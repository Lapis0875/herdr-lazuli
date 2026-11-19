// Model prices for transcripts that carry tokens but no dollars (Claude Code, Codex), in USD per million
// tokens (DESIGN A4, ARCHITECTURE §4.3). Updated by hand when prices change; a model missing here is shown
// as tokens, marked unpriced. Long-context surcharges are not modelled: every rate is the base rate.
//
// Source of every price below, unless a row says otherwise: OMP's model catalog on this Mac,
// `~/.omp/agent/models.db`, table `model_cache`, field `cost` of each model, read 2026-11-19:
//   - Anthropic rows: provider "anthropic", updated 2026-11-18T05:43:37Z (OMP 18.22.2).
//   - OpenAI rows: provider "openai", updated 2026-11-18T05:43:36Z (OMP 18.22.2).
// `cacheWrite` is the 5-minute cache write. `cacheWrite1h` (Anthropic only) is 2 × input: observed for
// claude-opus-5-5 in an OMP session's own cost fields on 2026-11-18 (53,035 one-hour write tokens priced
// $0.42428, i.e. $8/M), and applied to the other Anthropic rows as the same multiplier [INFERENCE].

/** @typedef {{input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h?: number}} Rate */

const anthropic = (input, output, cacheRead, cacheWrite) => Object.freeze({ input, output, cacheRead, cacheWrite, cacheWrite1h: input * 2 });
const openai = (input, output, cacheRead, cacheWrite) => Object.freeze({ input, output, cacheRead, cacheWrite });

/** @type {{[modelPrefix: string]: Rate}} */
export const RATES = Object.freeze({
  // Anthropic, catalog 2026-11-18.
  "claude-opus-5-5": anthropic(4, 20, 0.2, 5),
  "claude-opus-5": anthropic(5, 25, 0.5, 6.25),
  "claude-opus-4-8": anthropic(5, 25, 0.5, 6.25),
  "claude-opus-4-7": anthropic(5, 25, 0.5, 6.25),
  "claude-opus-4-6": anthropic(5, 25, 0.5, 6.25),
  "claude-opus-4-5": anthropic(5, 25, 0.5, 6.25),
  "claude-sonnet-5-5": anthropic(2, 10, 0.1, 2.5),
  "claude-sonnet-5": anthropic(2, 10, 0.2, 2.5),
  "claude-sonnet-4-6": anthropic(3, 15, 0.3, 3.75),
  "claude-sonnet-4-5": anthropic(3, 15, 0.3, 3.75),
  "claude-haiku-5-5": anthropic(0.1, 0.5, 0.01, 0.125),
  "claude-haiku-4-5": anthropic(1, 5, 0.1, 1.25),
  "claude-fable-5-2": anthropic(8, 40, 0.2, 10),
  "claude-fable-5-1": anthropic(10, 50, 0.25, 12.5),
  "claude-fable-5": anthropic(10, 50, 1, 12.5),
  "claude-mythos-5-2": anthropic(8, 40, 0.2, 10),
  "claude-mythos-5-1": anthropic(10, 50, 0.25, 12.5),
  "claude-mythos-5": anthropic(10, 50, 1, 12.5),
  // OpenAI, catalog 2026-11-18. Codex reports no cache writes, so their rate never applies there.
  "gpt-6.2-astra": openai(8, 40, 0.4, 10),
  "gpt-6.2-sol": openai(2, 10, 0.1, 2.5),
  "gpt-6.1-sol": openai(2, 10, 0.1, 2.5),
  "gpt-6.1-terra": openai(1, 5, 0.05, 1.25),
  "gpt-6-astra": openai(10, 50, 1, 12.5),
  "gpt-6-sol": openai(2, 10, 0.2, 2.5),
  "gpt-6-luna": openai(0.1, 0.5, 0.01, 0.125),
  "gpt-5.6": openai(4, 20, 0.4, 5),
  "gpt-5.6-sol": openai(4, 20, 0.4, 5),
  "gpt-5.6-terra": openai(2, 12, 0.2, 2.5),
  "gpt-5.6-luna": openai(0.2, 1.2, 0.02, 0.25),
  "gpt-5.5": openai(5, 30, 0.5, 0),
  "gpt-5.5-pro": openai(30, 180, 0, 0),
  "gpt-5.4": openai(2.5, 15, 0.25, 0),
  "gpt-5.4-mini": openai(0.75, 4.5, 0.075, 0),
  "gpt-5.4-nano": openai(0.2, 1.25, 0.02, 0),
  "gpt-5.4-pro": openai(30, 180, 0, 0),
  "codex-mini-latest": openai(1.5, 6, 0.375, 0),
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The rate for a model id, lower-cased: its exact key, else the longest key that prefixes it; null when
 *  none does (the model is unpriced). */
export function rateFor(model, rates = RATES) {
  if (typeof model !== "string" || !model || !rates || typeof rates !== "object") return null;
  const id = model.toLowerCase();
  if (own(rates, id)) return rates[id];
  let best = null;
  for (const key of Object.keys(rates)) if (id.startsWith(key) && (best === null || key.length > best.length)) best = key;
  return best === null ? null : rates[best];
}

/** USD for a token count at a rate. The one-hour cache write rate defaults to the 5-minute one. */
export function cost(tokens, rate) {
  const t = tokens ?? {};
  const r = rate ?? {};
  const write1h = typeof r.cacheWrite1h === "number" ? r.cacheWrite1h : num(r.cacheWrite);
  return (
    num(t.input) * num(r.input) +
    num(t.output) * num(r.output) +
    num(t.cacheRead) * num(r.cacheRead) +
    num(t.cacheWrite) * num(r.cacheWrite) +
    num(t.cacheWrite1h) * write1h
  ) / 1e6;
}
