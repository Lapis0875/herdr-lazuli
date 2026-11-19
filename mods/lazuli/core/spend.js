// Usage records of the three agent tools → spend entries, priced and summed per day, week, tool and model
// (DESIGN A4, ARCHITECTURE §4.3, CONTRACTS "pricing.js and spend.js"). Pure: `bin/scan.mjs` reads the
// transcripts and calls these per JSON line.
//
// Entry = {tool: "omp"|"claude"|"codex", model, at, tokens, usd, key}. Tokens = {input, output, cacheRead,
// cacheWrite, cacheWrite1h}. `key` lets a caller count a repeated record once per file (Claude Code writes
// one line per content block of a streamed reply, each with the same message id and usage).

import { RATES, rateFor, cost } from "./pricing.js";

const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];
const TOOLS = ["omp", "claude", "codex"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v) => (typeof v === "string" && v ? v : null);

function tokensOf(o) {
  const t = {};
  for (const f of FIELDS) t[f] = num(o?.[f]);
  return t;
}

/** The sum of all five token fields. */
const total = (t) => FIELDS.reduce((sum, f) => sum + num(t?.[f]), 0);

function timeOf(text) {
  if (typeof text !== "string") return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

/** An OMP transcript record → its entry: an assistant message with `message.usage`, or a `model_usage`
 *  record (side calls: titles, captions). OMP writes the USD itself (`usage.cost.total`). One-hour cache
 *  writes (`usage.cttl.ephemeral1h`) are split out of `cacheWrite`. Null for any other record. */
export function ompUsage(record) {
  if (!isObj(record)) return null;
  const m = record.message;
  let usage = null;
  let model = null;
  if (record.type === "message" && isObj(m) && m.role === "assistant" && isObj(m.usage)) {
    usage = m.usage;
    model = str(m.model);
  } else if (record.type === "model_usage" && isObj(record.usage)) {
    usage = record.usage;
    model = str(record.model);
  } else return null;
  const tokens = tokensOf({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
  const oneHour = Math.min(num(usage.cttl?.ephemeral1h), tokens.cacheWrite);
  tokens.cacheWrite -= oneHour;
  tokens.cacheWrite1h = oneHour;
  const usd = isObj(usage.cost) && typeof usage.cost.total === "number" && Number.isFinite(usage.cost.total) ? usage.cost.total : null;
  const at = timeOf(record.timestamp) ?? (isObj(m) && typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : null);
  return { tool: "omp", model, at, tokens, usd, key: null };
}

/** A Claude Code transcript record → its entry: an `assistant` record with `message.usage`. Subagent (Task)
 *  replies are sidechain records (`isSidechain: true`) in the subagent's own transcript
 *  (`<session>/subagents/agent-<id>.jsonl`; older versions wrote them inline in the session file), never copied
 *  into the parent's, so they count like any other. Claude Code writes no USD; `key` is the message id. Null for
 *  any other record. */
export function claudeUsage(record) {
  if (!isObj(record) || record.type !== "assistant") return null;
  const m = record.message;
  if (!isObj(m) || !isObj(m.usage)) return null;
  const u = m.usage;
  const cc = isObj(u.cache_creation) ? u.cache_creation : {};
  const tokens = tokensOf({
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: cc.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens,
    cacheWrite1h: cc.ephemeral_1h_input_tokens ?? 0,
  });
  return { tool: "claude", model: str(m.model), at: timeOf(record.timestamp), tokens, usd: null, key: str(m.id) };
}

/** A Codex rollout record → the session's running token total, from a `token_count` event; null for any
 *  other record. Codex counts cached input inside `input_tokens`; here it is split out. */
export function codexTotal(record) {
  if (!isObj(record) || record.type !== "event_msg" || !isObj(record.payload) || record.payload.type !== "token_count") return null;
  const u = record.payload.info?.total_token_usage;
  if (!isObj(u)) return null;
  const cached = num(u.cached_input_tokens);
  return { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cacheRead: cached, cacheWrite: 0, cacheWrite1h: 0 };
}

/** The tokens spent between two running totals: per field max(0, total − prev). A total below the previous
 *  one (the counter started again) counts whole, as does the first total. */
export function codexDelta(prev, total_) {
  const t = tokensOf(total_);
  if (!isObj(prev)) return t;
  const p = tokensOf(prev);
  if (total(t) < total(p)) return t;
  const out = {};
  for (const f of FIELDS) out[f] = Math.max(0, t[f] - p[f]);
  return out;
}

/** The entry with its USD: a recorded one is kept, else the tokens at the model's rate, else null
 *  (unpriced). */
export function price(entry, rates = RATES) {
  const e = isObj(entry) ? entry : {};
  const tokens = tokensOf(e.tokens);
  if (typeof e.usd === "number" && Number.isFinite(e.usd)) return { ...e, tokens, usd: e.usd };
  const rate = rateFor(e.model ?? null, rates);
  return { ...e, tokens, usd: rate ? cost(tokens, rate) : null };
}

// Sums.

const round = (usd) => Math.round(usd * 1e6) / 1e6;
const emptySum = () => ({ usd: 0, tokens: 0 });

function add(sum, entry) {
  sum.tokens += total(entry.tokens);
  if (typeof entry.usd === "number" && Number.isFinite(entry.usd)) sum.usd += entry.usd;
}

const finish = (sum) => ({ usd: round(sum.usd), tokens: sum.tokens });

function dateText(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight of `now`'s day, the Monday of its week, and the seven day starts Monday to Sunday. */
function calendar(now) {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const back = (d.getDay() + 6) % 7;
  const starts = [];
  for (let i = 0; i <= 7; i++) starts.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + i).getTime());
  return { today, tomorrow: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(), starts };
}

/** Totals of priced entries (`price` first): today, the week holding `now` (Monday to Sunday, local), each
 *  of its seven days, and the week by tool and by model (most expensive first). `unpriced` lists the week's
 *  models without a USD, with their tokens (most first). Entries with `at === null` are left out. */
export function summarize(entries, now) {
  const { today, tomorrow, starts } = calendar(num(now));
  const weekStart = starts[0];
  const weekEnd = starts[7];
  const day = emptySum();
  const week = emptySum();
  const days = starts.slice(0, 7).map(() => emptySum());
  const byTool = Object.fromEntries(TOOLS.map((t) => [t, emptySum()]));
  const byModel = new Map();
  const unpriced = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isObj(e) || typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    if (e.at < weekStart || e.at >= weekEnd) continue;
    add(week, e);
    if (e.at >= today && e.at < tomorrow) add(day, e);
    let i = 6;
    while (i > 0 && e.at < starts[i]) i--;
    add(days[i], e);
    if (byTool[e.tool]) add(byTool[e.tool], e);
    const model = str(e.model);
    let m = byModel.get(model);
    if (!m) byModel.set(model, (m = emptySum()));
    add(m, e);
    if (e.usd === null || e.usd === undefined) {
      const n = total(e.tokens);
      if (n > 0) unpriced.set(model, (unpriced.get(model) ?? 0) + n);
    }
  }
  return {
    today: finish(day),
    week: finish(week),
    days: days.map((s, i) => ({ date: dateText(starts[i]), ...finish(s) })),
    byTool: Object.fromEntries(TOOLS.map((t) => [t, finish(byTool[t])])),
    byModel: [...byModel]
      .map(([model, s]) => ({ model, ...finish(s) }))
      .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || String(a.model).localeCompare(String(b.model))),
    unpriced: [...unpriced]
      .map(([model, tokens]) => ({ model, tokens }))
      .sort((a, b) => b.tokens - a.tokens || String(a.model).localeCompare(String(b.model))),
  };
}
