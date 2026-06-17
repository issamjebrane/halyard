import { supabaseServer } from "@/lib/supabase/server";
import { buildDailyDigest } from "@/lib/digest";
import { geminiEnabled } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/digest — a Gemini-written daily desk note over the last `hours` (default 24).
// Auth: an admin session (dashboard button) OR ?key=<CRON_SECRET> (scheduled job).
export async function GET(req: Request) {
  const url = new URL(req.url);

  const cronSecret = process.env.CRON_SECRET;
  const viaCron = !!cronSecret && url.searchParams.get("key") === cronSecret;

  if (!viaCron) {
    const sb = await supabaseServer();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (prof?.role !== "admin") return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  if (!geminiEnabled()) {
    return Response.json(
      { ok: false, error: "GEMINI_API_KEY is not set — add it to .env.local (see below)" },
      { status: 503 },
    );
  }

  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours")) || 24));
  try {
    const { text, stats } = await buildDailyDigest(hours);
    return Response.json({ ok: true, text, stats, generated_at: new Date().toISOString() });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "digest failed" },
      { status: 502 },
    );
  }
}
