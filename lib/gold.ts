import "server-only";

const GOLD_URL =
  process.env.GOLD_PRICE_URL ?? "https://api.gold-api.com/price/XAU";

// Fetch the live spot gold price, server-side (trusted — the client cannot
// influence it). Returns null on failure; callers fall back to price_cache.
export async function fetchLiveGold(): Promise<number | null> {
  try {
    const res = await fetch(GOLD_URL, {
      headers: { "User-Agent": "halyard" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const p = Number(data?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
