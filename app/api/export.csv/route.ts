import { supabaseServer } from "@/lib/supabase/server";
import type { Signal } from "@/lib/types";

type Row = Omit<Signal, "trader_name"> & { profiles: { username: string } | null };

const COLS = [
  "id",
  "trader",
  "direction",
  "order_type",
  "entry",
  "stop_loss",
  "take_profit",
  "rr_planned",
  "status",
  "result_R",
  "result_pips",
  "created_at",
  "activated_at",
  "closed_at",
  "exit_price",
];

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET() {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const { data: prof } = await sb
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (prof?.role !== "admin") return new Response("forbidden", { status: 403 });

  const { data } = await sb
    .from("signals")
    .select("*, profiles(username)")
    .order("id", { ascending: true });

  const rows = (data ?? []) as Row[];
  const lines = [COLS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.profiles?.username ?? "",
        r.direction,
        r.order_type,
        r.entry_price,
        r.stop_loss,
        r.take_profit,
        r.rr_planned,
        r.status,
        r.result_r,
        r.result_pips,
        r.created_at,
        r.activated_at,
        r.closed_at,
        r.exit_price,
      ]
        .map(cell)
        .join(","),
    );
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="track-record.csv"',
    },
  });
}
