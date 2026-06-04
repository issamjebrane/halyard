import "server-only";

// Spot gold price via Binance PAX Gold (PAXGUSDT) — tracks XAU ~1:1, trades 24/7.
// Public market-data host, no API key required (keys are reserved for the bot
// side). Override the symbol/host with BINANCE_PRICE_URL if needed.
const PRICE_URL =
  process.env.BINANCE_PRICE_URL ??
  "https://data-api.binance.vision/api/v3/ticker/price?symbol=PAXGUSDT";

export async function fetchLiveGold(): Promise<number | null> {
  try {
    const res = await fetch(PRICE_URL, {
      headers: { "User-Agent": "halyard" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const p = Number(data?.price); // Binance ticker: { symbol, price }
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
