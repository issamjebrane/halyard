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
  "tp1",
  "tp2",
  "tp3",
  "rr_planned",
  "status",
  "result_R",
  "result_pips",
  "peak_tp",
  "mfe_R",
  "mae_R",
  "created_at",
  "activated_at",
  "tp1_hit_at",
  "tp2_hit_at",
  "tp3_hit_at",
  "sl_hit_at",
  "closed_at",
  "settled_at",
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
        r.tp1,
        r.tp2,
        r.tp3,
        r.rr_planned,
        r.status,
        r.result_r,
        r.result_pips,
        r.peak_tp,
        r.mfe_r,
        r.mae_r,
        r.created_at,
        r.activated_at,
        r.tp1_hit_at,
        r.tp2_hit_at,
        r.tp3_hit_at,
        r.sl_hit_at,
        r.closed_at,
        r.settled_at,
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
