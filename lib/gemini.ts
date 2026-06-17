import "server-only";

// Minimal server-side Gemini text client — mirrors the REST call the Telegram
// ingester already uses (scripts/telegram-llm-parse.mjs), so there's one auth
// convention and no SDK dependency. Reads GEMINI_API_KEY / GEMINI_MODEL.
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export const geminiEnabled = () => !!process.env.GEMINI_API_KEY;

export async function geminiText(
  prompt: string,
  opts: { system?: string; model?: string; maxOutputTokens?: number; temperature?: number } = {},
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const model = opts.model ?? DEFAULT_MODEL;

  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.maxOutputTokens ?? 700,
        thinkingConfig: { thinkingBudget: 0 }, // 2.5-flash thinks by default; off => faster + cheaper
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof out === "string" ? out.trim() : "";
}
