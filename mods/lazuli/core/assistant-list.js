// The Assistant's session list (CONTRACTS K6, K2 shared key, K7 targets): Hermes's own ACP listing read
// from each profile's `state.db`, filtered to the folder, grouped by profile, with the remembered
// selection and collapsed groups. Pure: query output, profiles and state are arguments.
//
// SESSIONS_SQL is docs/spikes/S9/sessions.sql, checked against Hermes 0.17.0's
// `SessionManager.list_sessions` (acp_adapter/session.py:283-355 over hermes_state.py:2105-2341): ACP
// sessions with messages, not archived, roots and branches only (sub-agent runs and compression
// continuations stay folded into their original row), newest first; cwd from
// `json_extract(model_config, '$.cwd')` (the `cwd` column is NULL for ACP rows), plus the token and cost
// columns. The cwd filter and the title fallback (title → first user message cut to 60 characters with
// "..." → folder name → "New thread", session.py:73-81) run here, as Hermes runs them in Python.
// `sqlite3 -json` prints nothing at all for zero rows, so `mapRows("")` is `[]`.
//
// A gateway Hermes stores an editor's thread as `source='local'` under an id `local-<64 hex>`, its cwd in the `cwd`
// column. SESSIONS_SQL does not read those, and Lazuli lists only the ones it made itself: each `session/new` or
// `session/fork` answer with a local id is remembered in the shared key `lazuli.assistant.owned` with its profile
// and folder (normalizeOwned), `ownedSessionsSql` reads exactly those ids, and buildList shows a local id only when it
// is owned in that profile and folder. Other local chats (another editor's, the CLI's) never show and never count
// against SESSIONS_SQL's LIMIT.

import { AGENT_IDS, agentOf, isProfileName } from "./assistant-agents.js";
import { normalize } from "./paths.js";

export { isProfileName };

/** One profile's ACP sessions; run as `sqlite3 -readonly -json <state.db> SESSIONS_SQL`. */
export const SESSIONS_SQL = `SELECT
  s.id AS id,
  s.title AS title,
  COALESCE((SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 63)
            FROM messages m
            WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
            ORDER BY m.timestamp, m.id LIMIT 1), '') AS preview,
  CASE WHEN json_valid(s.model_config) THEN json_extract(s.model_config, '$.cwd') END AS cwd,
  s.model AS model,
  s.message_count AS message_count,
  s.started_at AS started_at,
  COALESCE((SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id), s.started_at) AS last_active,
  s.input_tokens AS input_tokens,
  s.output_tokens AS output_tokens,
  s.cache_read_tokens AS cache_read_tokens,
  s.cache_write_tokens AS cache_write_tokens,
  s.reasoning_tokens AS reasoning_tokens,
  s.estimated_cost_usd AS estimated_cost_usd,
  s.actual_cost_usd AS actual_cost_usd,
  s.cost_status AS cost_status,
  s.api_call_count AS api_call_count
FROM sessions s
WHERE s.source = 'acp'
  AND s.message_count > 0
  AND s.archived = 0
  AND (s.parent_session_id IS NULL
       OR (json_valid(s.model_config) AND json_extract(s.model_config, '$._branched_from') IS NOT NULL)
       OR EXISTS (SELECT 1 FROM sessions p
                  WHERE p.id = s.parent_session_id AND p.end_reason = 'branched'
                    AND s.started_at >= p.ended_at))
  AND NOT (json_valid(s.model_config) AND json_extract(s.model_config, '$._delegate_from') IS NOT NULL)
ORDER BY last_active DESC, s.id DESC
LIMIT 1000;`;

/** SESSIONS_SQL's columns for the Hermes local sessions Lazuli made, read by id (`sqlite3 -readonly -json <state.db>
 *  <sql>`, rows for mapRows): `source='local'`, at least one message, newest first, with `archived` (an archived one
 *  is returned so buildList can tell it from one not saved yet). The cwd is the `cwd` column (a gateway Hermes writes
 *  none into `model_config`, which is read only when the column is empty). Every column read is in Hermes 0.17.0's
 *  schema too. The ids are inlined: each is `local-` and 64 hex digits, so none can quote. Null when no id is a local
 *  session id. */
export function ownedSessionsSql(ids) {
  const want = [...new Set(Array.isArray(ids) ? ids.filter(isLocalSessionId) : [])].sort();
  if (!want.length) return null;
  return `SELECT
  s.id AS id,
  s.title AS title,
  COALESCE((SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 63)
            FROM messages m
            WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
            ORDER BY m.timestamp, m.id LIMIT 1), '') AS preview,
  COALESCE(NULLIF(s.cwd, ''), CASE WHEN json_valid(s.model_config) THEN json_extract(s.model_config, '$.cwd') END) AS cwd,
  s.model AS model,
  s.message_count AS message_count,
  s.started_at AS started_at,
  COALESCE((SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id), s.started_at) AS last_active,
  s.input_tokens AS input_tokens,
  s.output_tokens AS output_tokens,
  s.cache_read_tokens AS cache_read_tokens,
  s.cache_write_tokens AS cache_write_tokens,
  s.reasoning_tokens AS reasoning_tokens,
  s.estimated_cost_usd AS estimated_cost_usd,
  s.actual_cost_usd AS actual_cost_usd,
  s.cost_status AS cost_status,
  s.api_call_count AS api_call_count,
  s.archived AS archived
FROM sessions s
WHERE s.source = 'local'
  AND s.id IN (${want.map((id) => `'${id}'`).join(", ")})
  AND s.message_count > 0
ORDER BY last_active DESC, s.id DESC;`;
}

const SESSION_ID = /^(?:[0-9a-f-]{36}|local-[0-9a-f]{64})$/;
const LOCAL_ID = /^local-[0-9a-f]{64}$/;
const BRIDGE_STATES = new Set(["off", "starting", "ready", "error", "stopped"]);
const DEFAULT = "default";
/** At most this many owned local sessions are remembered, the newest made kept. */
export const OWNED_MAX = 200;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ms = (seconds) => (num(seconds) === null ? null : Math.round(seconds * 1000));

/** Accept legacy session targets and Hermes local IDs without admitting path separators. */
export function isSessionId(s) {
  return typeof s === "string" && SESSION_ID.test(s);
}

/** Whether `s` is a Hermes local session id (`local-` and 64 lowercase hex digits): listed only when Lazuli made it. */
export function isLocalSessionId(s) {
  return typeof s === "string" && LOCAL_ID.test(s);
}

/** A session's key `<profile>/<sessionId>`, or null when either part is malformed. */
export function sessionKey(profile, sessionId) {
  return isProfileName(profile) && isSessionId(sessionId) ? `${profile}/${sessionId}` : null;
}

/** A key's parts, or null when it is not a well-formed key. */
export function parseKey(key) {
  if (typeof key !== "string") return null;
  const cut = key.indexOf("/");
  if (cut < 0) return null;
  const profile = key.slice(0, cut);
  const sessionId = key.slice(cut + 1);
  return sessionKey(profile, sessionId) ? { profile, sessionId } : null;
}

/** A cwd as Hermes compares it (session.py:56-70): trimmed ("" → "."), a leading "~" expanded with
 *  `home`, "." and ".." resolved, "//" collapsed and no trailing "/". */
export function normalizeCwd(p, home) {
  let s = typeof p === "string" ? p.trim() : "";
  if (s === "") s = ".";
  if ((s === "~" || s.startsWith("~/")) && typeof home === "string" && home !== "") s = home + s.slice(1);
  return normalize(s);
}

/** A path under macOS's `/private` (`/private/tmp/x`, `/private/var/…`) → the short form without `/private`, which
 *  the system folder picker resolves away; null for any other path. Whether the short form is the same folder is the
 *  caller's to check (by resolving both). */
export function firmlinkShort(path) {
  const m = typeof path === "string" ? /^\/private(\/[^/].*)$/.exec(path) : null;
  return m ? normalize(m[1]) : null;
}

/** The absolute paths the list compares, each once, sorted: the folder and every cwd of the rows and local sessions,
 *  normalized as normalizeCwd does. The caller resolves them (symlinks, macOS firmlinks) and passes `real` to
 *  buildList. */
export function pathsToResolve({ folder, home, profiles, local } = {}) {
  const out = new Set();
  const add = (p) => {
    if (typeof p !== "string" || p.trim() === "") return;
    const n = normalizeCwd(p, home);
    if (n.startsWith("/")) out.add(n);
  };
  add(folder);
  for (const src of Array.isArray(profiles) ? profiles : []) for (const r of Array.isArray(src?.rows) ? src.rows : []) add(r?.cwd);
  for (const l of Array.isArray(local) ? local : []) add(l?.cwd);
  return [...out].sort();
}

/** Hermes's list title (hermes_state.py:2296-2302, session.py:73-81). */
function titleOf(title, preview, cwd) {
  const explicit = typeof title === "string" ? title.trim() : "";
  if (explicit) return explicit;
  const raw = typeof preview === "string" ? preview.trim() : "";
  if (raw) {
    const chars = Array.from(raw);
    return chars.length > 60 ? `${chars.slice(0, 60).join("")}...` : raw;
  }
  const trimmed = (typeof cwd === "string" ? cwd : "").replace(/[/\\]+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "New thread";
}

function statsOf(r) {
  return {
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
    reasoningTokens: num(r.reasoning_tokens),
    estimatedCostUsd: num(r.estimated_cost_usd),
    actualCostUsd: num(r.actual_cost_usd),
    costStatus: str(r.cost_status),
    apiCallCount: num(r.api_call_count),
  };
}

/** `sqlite3 -json` output of SESSIONS_SQL or ownedSessionsSql → `[{id, title, cwd, model, messageCount, startedAt,
 *  updatedAt, stats, archived}]` (times in ms; a missing number is null; `archived` true only for a row that says so,
 *  which only ownedSessionsSql returns). Blank output is `[]`; output that is not a JSON array is null. */
export function mapRows(json) {
  if (typeof json !== "string") return null;
  if (json.trim() === "") return [];
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  return data
    .filter((r) => isPlain(r) && typeof r.id === "string" && r.id !== "")
    .map((r) => {
      const cwd = str(r.cwd);
      const startedAt = ms(r.started_at);
      return {
        id: r.id,
        title: titleOf(r.title, r.preview, cwd),
        cwd,
        model: str(r.model),
        messageCount: num(r.message_count),
        startedAt,
        updatedAt: ms(r.last_active) ?? startedAt,
        stats: statsOf(r),
        archived: r.archived === 1 || r.archived === true,
      };
    });
}

/** An ACP `session/list` result (the fallback when the query fails) → rows of the `mapRows` shape with
 *  unknown model, count and stats. */
export function mapSessionList(result) {
  const list = isPlain(result) && Array.isArray(result.sessions) ? result.sessions : [];
  return list
    .filter((s) => isPlain(s) && typeof s.sessionId === "string" && s.sessionId !== "")
    .map((s) => {
      const at = typeof s.updatedAt === "string" ? Date.parse(s.updatedAt) : NaN;
      return {
        id: s.sessionId,
        title: titleOf(s.title, "", s.cwd),
        cwd: str(s.cwd),
        model: null,
        messageCount: null,
        startedAt: null,
        updatedAt: Number.isFinite(at) ? at : null,
        stats: null,
        archived: false,
      };
    });
}

/** The shared key `lazuli.assistant.ui` (K2, D25) for `folder`: `{v: 1, folder, selected: {agent,
 *  profile, session} | null, collapsed: [profile]}`. A value for another folder, or a malformed one, is
 *  reset; a malformed selection is dropped. */
export function normalizeUi(raw, folder) {
  const f = typeof folder === "string" && folder !== "" ? folder : null;
  const fresh = { v: 1, folder: f, selected: null, collapsed: [] };
  if (!isPlain(raw) || raw.v !== 1 || f === null || typeof raw.folder !== "string" || normalize(raw.folder) !== normalize(f)) return fresh;
  const s = raw.selected;
  const agent = isPlain(s) ? agentOf(s.agent) : null;
  const selected = agent && !agent.planned && isProfileName(s.profile) && isSessionId(s.session) ? { agent: s.agent, profile: s.profile, session: s.session } : null;
  const collapsed = Array.isArray(raw.collapsed) ? [...new Set(raw.collapsed.filter(isProfileName))] : [];
  return { v: 1, folder: f, selected, collapsed };
}

const ownedEntry = (e) => isPlain(e) && isProfileName(e.profile) && isLocalSessionId(e.session)
  && typeof e.folder === "string" && e.folder.startsWith("/") && num(e.at) !== null;

/** The shared key `lazuli.assistant.owned`: the Hermes local sessions Lazuli made, `{v: 1, sessions: [{profile,
 *  folder, session, at}]}`, newest made first, each profile/session once, at most OWNED_MAX. `folder` (normalized) is
 *  the folder of the bridge that made it; `at` when (ms). Malformed entries are dropped; a malformed value is empty. */
export function normalizeOwned(raw) {
  const list = isPlain(raw) && raw.v === 1 && Array.isArray(raw.sessions) ? raw.sessions.filter(ownedEntry) : [];
  const seen = new Set();
  const sessions = [];
  for (const e of list.sort((a, b) => b.at - a.at)) {
    const key = `${e.profile}/${e.session}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({ profile: e.profile, folder: normalize(e.folder), session: e.session, at: e.at });
    if (sessions.length === OWNED_MAX) break;
  }
  return { v: 1, sessions };
}

/** The owned key with one more session Lazuli made, `{profile, folder, session, at}`, or null when there is nothing
 *  to write: the entry is malformed (a session id that is not a local one among it), or that profile already holds
 *  that session in that folder. */
export function addOwned(raw, entry) {
  if (!ownedEntry(entry)) return null;
  const owned = normalizeOwned(raw);
  const folder = normalize(entry.folder);
  const same = (e) => e.profile === entry.profile && e.session === entry.session;
  if (owned.sessions.some((e) => same(e) && e.folder === folder)) return null;
  const next = { profile: entry.profile, folder, session: entry.session, at: entry.at };
  return normalizeOwned({ v: 1, sessions: [next, ...owned.sessions.filter((e) => !same(e))] });
}

/** The local session ids Lazuli made with `profile` in `folder` (compared normalized), newest made first. */
export function ownedIds(raw, folder, profile) {
  if (typeof folder !== "string" || !folder.startsWith("/") || !isProfileName(profile)) return [];
  const f = normalize(folder);
  return normalizeOwned(raw).sessions.filter((e) => e.profile === profile && e.folder === f).map((e) => e.session);
}

/** The owned key without that profile's `session`, or null when it holds no such entry. */
export function dropOwned(raw, profile, session) {
  const owned = normalizeOwned(raw);
  const sessions = owned.sessions.filter((e) => e.profile !== profile || e.session !== session);
  return sessions.length === owned.sessions.length ? null : { v: 1, sessions };
}

/** The remembered selection (`ui`, the shared key) when it is a Hermes local session `owned` holds for that profile
 *  in `folder`: `{profile, sessionId, at}`, else null. After a reload nothing of the run before stands in for it, and
 *  the database may list no row for it yet (AT-25: a reload during its first turn): the service passes it in
 *  buildList's `local`, as a session made in this run, so the list keeps it selected until the profile's rows list it
 *  or rule it out, and loads it. */
export function heldSelection(ui, owned, folder) {
  const s = normalizeUi(ui, folder).selected;
  if (!s || !isLocalSessionId(s.session) || !folder.startsWith("/")) return null;
  const f = normalize(folder);
  const e = normalizeOwned(owned).sessions.find((x) => x.profile === s.profile && x.session === s.session && x.folder === f);
  return e ? { profile: e.profile, sessionId: e.session, at: e.at } : null;
}

function keySet(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v.filter((k) => typeof k === "string"));
  if (isPlain(v)) return new Set(Object.keys(v).filter((k) => v[k]));
  return new Set();
}

function bridgeState(v) {
  const s = isPlain(v) ? v.state : v;
  return BRIDGE_STATES.has(s) ? s : "off";
}

/** `profiles` entries → `{profile, rows, error}` for valid names, first one per name, `default` first
 *  and always present, the rest by name. A bare name, or `rows` that is not an array, means not loaded. */
function sources(profiles) {
  const seen = new Map();
  for (const p of Array.isArray(profiles) ? profiles : []) {
    const name = typeof p === "string" ? p : isPlain(p) ? p.profile : null;
    if (!isProfileName(name) || seen.has(name)) continue;
    const rows = isPlain(p) && Array.isArray(p.rows) ? p.rows : null;
    const error = isPlain(p) && typeof p.error === "string" && p.error !== "" ? p.error : null;
    seen.set(name, { profile: name, rows, error });
  }
  if (!seen.has(DEFAULT)) seen.set(DEFAULT, { profile: DEFAULT, rows: null, error: null });
  const rest = [...seen.keys()].filter((n) => n !== DEFAULT).sort();
  return [DEFAULT, ...rest].map((n) => seen.get(n));
}

const byRecent = (a, b) => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0);

/** The list (K6): `{groups, planned, pickable}`.
 *  - `profiles`: `[{profile, rows, error?}]`, rows from `mapRows`/`mapSessionList` (null = not loaded);
 *  - `local`: sessions this run made, `[{profile, sessionId, title?, updatedAt?, model?, cwd?}]`, shown
 *    while the database has no row for them (new empty sessions); one with a Hermes local id also not once the
 *    database rules it out (its row archived, or its cwd in another folder);
 *  - `owned`: the shared key `lazuli.assistant.owned`: a row with a Hermes local id shows only when that profile
 *    made it in this folder and it is not archived (another editor's or the CLI's local chats never show);
 *  - `running`: keys with a turn running; `bridges`: `{[profile]: state | {state}}`; `ui`: the shared key;
 *  - `real`: optional `{[normalized path]: resolved path}` (pathsToResolve's paths with symlinks resolved; "" for one
 *    that does not resolve): a cwd is in the folder when it is the folder's path, or resolves to where the folder does.
 *  A group: `{agent, profile, visible, collapsed, bridge, running, rows, loading, error?}`; `default` is
 *  always visible and first, another profile only with rows in the folder. A row: `{key, profile,
 *  sessionId, title, updatedAt, model, messageCount, running, selected, local, stats}`, newest first.
 *  `planned` lists the planned agents (Nod, shown last and disabled); `pickable` every valid profile. */
export function buildList(o) {
  const folder = typeof o?.folder === "string" && o.folder !== "" ? o.folder : null;
  const home = o?.home;
  const want = folder === null ? null : normalizeCwd(folder, home);
  const ui = normalizeUi(o?.ui, folder);
  const running = keySet(o?.running);
  const bridges = isPlain(o?.bridges) ? o.bridges : {};
  const local = Array.isArray(o?.local) ? o.local.filter(isPlain) : [];
  const sel = ui.selected && ui.selected.agent === "hermes" ? `${ui.selected.profile}/${ui.selected.session}` : null;
  const real = isPlain(o?.real) ? o.real : null;
  const realOf = (p) => (real && typeof real[p] === "string" && real[p] !== "" ? real[p] : null);
  const wantReal = want === null ? null : realOf(want);
  const inFolder = (cwd) => {
    if (want === null) return false;
    const n = normalizeCwd(cwd, home);
    return n === want || (wantReal !== null && realOf(n) === wantReal);
  };
  const ownedFolder = folder !== null && folder.startsWith("/") ? normalize(folder) : null;
  const owned = new Set(normalizeOwned(o?.owned).sessions.filter((e) => e.folder === ownedFolder).map((e) => `${e.profile}/${e.session}`));
  const mine = (profile, r) => !isLocalSessionId(r.id) || (owned.has(`${profile}/${r.id}`) && r.archived !== true);
  const ruledOut = (r) => Boolean(r) && (r.archived === true || (typeof r.cwd === "string" && !inFolder(r.cwd)));

  const groups = sources(o?.profiles).map((src) => {
    const row = (profile, id, r, isLocal) => {
      const key = `${profile}/${id}`;
      return {
        key,
        profile,
        sessionId: id,
        title: r.title ?? null,
        updatedAt: num(r.updatedAt),
        model: str(r.model),
        messageCount: isLocal ? 0 : num(r.messageCount),
        running: running.has(key),
        selected: key === sel,
        local: isLocal,
        stats: isLocal ? null : r.stats ?? null,
      };
    };
    const stored = (src.rows ?? []).filter((r) => isPlain(r) && typeof r.id === "string" && mine(src.profile, r) && inFolder(r.cwd));
    const ids = new Set(stored.map((r) => r.id));
    const rows = stored.map((r) => row(src.profile, r.id, r, false));
    const localRows = new Map();
    for (const r of src.rows ?? []) if (isPlain(r) && isLocalSessionId(r.id) && !localRows.has(r.id)) localRows.set(r.id, r);
    for (const l of local) {
      if (l.profile !== src.profile || !isSessionId(l.sessionId) || ids.has(l.sessionId)) continue;
      if (l.cwd !== undefined && l.cwd !== null && !inFolder(l.cwd)) continue;
      if (ruledOut(localRows.get(l.sessionId))) continue;
      ids.add(l.sessionId);
      rows.push(row(src.profile, l.sessionId, l, true));
    }
    rows.sort(byRecent);
    const group = {
      agent: "hermes",
      profile: src.profile,
      visible: src.profile === DEFAULT || rows.length > 0,
      collapsed: ui.collapsed.includes(src.profile),
      bridge: bridgeState(bridges[src.profile]),
      running: rows.filter((r) => r.running).length,
      rows,
      loading: src.rows === null,
    };
    if (src.error) group.error = src.error;
    return group;
  });

  const planned = AGENT_IDS.filter((id) => agentOf(id).planned).map((id) => ({ agent: id, name: agentOf(id).name, planned: true, disabled: true }));
  return { groups, planned, pickable: groups.map((g) => g.profile) };
}

/** The shared key with a selection that no longer exists cleared (K2): its profile is gone, or its group
 *  finished loading without error and has no such row. A group still loading or failing keeps it. */
export function pruneUi(ui, list) {
  if (!isPlain(ui) || !isPlain(ui.selected)) return ui;
  const { profile, session } = ui.selected;
  const groups = Array.isArray(list?.groups) ? list.groups : [];
  const group = groups.find((g) => g.profile === profile);
  if (group && (group.loading || group.error)) return ui;
  if (group && group.rows.some((r) => r.key === `${profile}/${session}`)) return ui;
  return { ...ui, selected: null };
}
