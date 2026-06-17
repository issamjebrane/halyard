import { supabaseServer } from "@/lib/supabase/server";
import { buildAnalysis, type WindowKey } from "@/lib/digest";
import { buildDeepAnalysis } from "@/lib/deepAnalysis";
import { geminiEnabled } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WINDOWS: WindowKey[] = ["7d", "30d", "all"];

// GET /api/digest?window=7d|30d|all — a Gemini-written performance analysis over
// the chosen window. Auth: an admin session (dashboard) OR ?key=<CRON_SECRET> (cron).
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

  try {
    // deep mode — multi-pass per-engine rentability + where-they-missed report (all trades)
    if (url.searchParams.get("mode") === "deep") {
      const { text, stats } = await buildDeepAnalysis();
      return Response.json({ ok: true, mode: "deep", text, stats, generated_at: new Date().toISOString() });
    }
    const w = url.searchParams.get("window") as WindowKey | null;
    const windowKey: WindowKey = w && WINDOWS.includes(w) ? w : "30d";
    const { text, stats } = await buildAnalysis(windowKey);
    return Response.json({ ok: true, window: windowKey, text, stats, generated_at: new Date().toISOString() });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "analysis failed" },
      { status: 502 },
    );
  }
}
