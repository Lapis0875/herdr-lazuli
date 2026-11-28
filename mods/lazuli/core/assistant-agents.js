// The Assistant's agent adapters (CONTRACTS K1, K3, K4, K7): what lazuli runs for an ACP agent and what
// it knows of that agent's replies. `hermes` is Hermes Agent 0.17.0; `nod` is planned and has no
// command yet. Pure.
//
// Facts from docs/spikes/S9.md and the Hermes source (`~/.hermes/hermes-agent`):
// - argv `<hermes> -p <profile> acp`; `-p` is passed for `default` too, so an active profile set with
//   `hermes profile use` never changes which profile a bridge serves (hermes_cli/main.py:388-478).
// - profile names follow `^[a-z0-9][a-z0-9_-]{0,63}$` (hermes_cli/main.py:436); `default` is ~/.hermes
//   itself, any other profile is ~/.hermes/profiles/<name>.
// - slash commands answered locally (acp_adapter/server.py:1731-1744); any other "/word" goes to the
//   model. The Assistant's / menu hides `steer` and `queue`: Enter and ⌥Enter do them (K4).
// - a `/steer` answer is one agent_message_chunk with one of four texts (server.py:1956-1973). The
//   patterns are anchored at the chunk start, so a reply that merely starts with "Queued" (a plain prompt
//   queued by Hermes, server.py:1376, or `/queue`, :1982) is never taken for a steer answer.
// - approval options by id (acp_adapter/permissions.py:41-69, edit_approval.py:254-257): the kind of
//   `allow_session` is `allow_always`, so buttons are chosen by option id (D29).

/** An approval card expires this many ms after the bridge received it (Hermes waits 60 s). */
export const PERMISSION_TIMEOUT_MS = 60000;

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const freeze = (v) => Object.freeze(v);

const HERMES = freeze({
  id: "hermes",
  name: "Hermes",
  planned: false,
  defaultProfile: "default",
  /** Commands Hermes answers without the model. */
  commands: freeze(["help", "model", "tools", "context", "reset", "compact", "steer", "queue", "version"]),
  /** Left out of the / menu (K4 slash routing). */
  hiddenCommands: freeze(["steer", "queue"]),
  /** Commands after which the session is loaded again: they rewrite Hermes's history (K4). */
  resyncCommands: freeze(["reset", "compact"]),
  /** Option ids shown as buttons, in this order; every other option goes in More (D29). */
  buttonOptions: freeze(["allow_once", "allow_always", "deny"]),
  /** The option ids `lazuli.assistant:allow` and `:deny` answer with (K7). */
  quickAnswers: freeze({ allow: "allow_once", deny: "deny" }),
  /** What a `/steer` request is answered with, as `{code, pattern, vars}` (`vars` name the pattern's groups);
   *  the first match wins. The codes are notice codes (`assistant.event.<code>`). */
  steerReplies: freeze([
    // server.py:1964-1965, accepted: "⏩ Steer queued for the active turn: {preview}".
    freeze({ code: "steer-ack", pattern: /^\u23E9 Steer queued for the active turn: ([\s\S]*)$/, vars: ["preview"] }),
    // server.py:1973, Hermes queued it as its own next prompt.
    freeze({ code: "steer-queued", pattern: /^No active turn \u2014 queued for the next turn\. \((\d+) queued\)$/, vars: ["depth"] }),
    // server.py:1968, "⚠️ Steer failed: {exc}".
    freeze({ code: "steer-failed", pattern: /^\u26A0\uFE0F Steer failed: ([\s\S]*)$/, vars: ["detail"] }),
    // server.py:1959, empty guidance: refused, the whole text is the detail.
    freeze({ code: "steer-failed", pattern: /^(Usage: \/steer <guidance>)$/, vars: ["detail"] }),
  ]),
});

const NOD = freeze({ id: "nod", name: "Nod", planned: true });

/** The adapters by id. */
export const AGENTS = freeze({ hermes: HERMES, nod: NOD });

/** Adapter ids in list order (Nod last). */
export const AGENT_IDS = freeze(["hermes", "nod"]);

/** The adapter for an id, or null. */
export function agentOf(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(AGENTS, id) ? AGENTS[id] : null;
}

/** Whether `s` is a Hermes profile name (`default` included). */
export function isProfileName(s) {
  return typeof s === "string" && PROFILE_NAME.test(s);
}

const words = (v) => (Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === "string" && w !== "") ? v : null);
const program = (o) => words(o?.debugAgent) ?? (typeof o?.bin === "string" && o.bin !== "" ? [o.bin] : null);

/** The agent argv a bridge runs for a profile: `[bin, "-p", profile, "acp"]`, or with `debugAgent` set
 *  (D30) `debugAgent ++ ["-p", profile, "acp"]`. Null for a bad profile name or no program. */
export function agentArgv(o) {
  const head = program(o);
  if (!head || !isProfileName(o?.profile)) return null;
  return [...head, "-p", o.profile, "acp"];
}

/** The once-per-start check (K4): `[bin, "acp", "--check"]`, or `debugAgent ++ ["acp", "--check"]`. */
export function checkArgv(o) {
  const head = program(o);
  return head ? [...head, "acp", "--check"] : null;
}

/** A profile's session database: `<home>/.hermes/state.db` for `default`, otherwise
 *  `<home>/.hermes/profiles/<profile>/state.db`. Null for a bad name or no home. */
export function stateDbPath(home, profile) {
  if (typeof home !== "string" || home === "" || !isProfileName(profile)) return null;
  const root = `${home.replace(/\/+$/, "")}/.hermes`;
  return profile === HERMES.defaultProfile ? `${root}/state.db` : `${root}/profiles/${profile}/state.db`;
}

/** The folder whose subfolders are the non-default profiles. */
export function profilesDir(home) {
  return typeof home === "string" && home !== "" ? `${home.replace(/\/+$/, "")}/.hermes/profiles` : null;
}

/** A steer answer: `{code, vars}` when the whole chunk text is one of the agent's steer replies,
 *  otherwise null. */
export function steerReply(text, agent = "hermes") {
  const replies = agentOf(agent)?.steerReplies;
  if (!replies || typeof text !== "string") return null;
  for (const r of replies) {
    const m = r.pattern.exec(text);
    if (!m) continue;
    const vars = {};
    r.vars.forEach((name, i) => {
      vars[name] = name === "depth" ? Number(m[i + 1]) : m[i + 1];
    });
    return { code: r.code, vars };
  }
  return null;
}

/** A slash command as Hermes reads it (server.py:1727-1729): the first word without its leading "/"s,
 *  lowercased, and the rest trimmed. Null when the trimmed text does not start with "/". */
export function parseSlash(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  return { name: m[1].replace(/^\/+/, "").toLowerCase(), args: (m[2] ?? "").trim() };
}

/** Where composer text goes (K4 slash routing):
 *  - `{route: "model", model}`: `/model <x>`, through `session/set_model`;
 *  - `{route: "queue", text}`: `/queue <text>`, a lazuli chip (D28);
 *  - `{route: "steer", text}`: a typed `/steer <text>`, sent to the agent as it is;
 *  - `{route: "command", name, resync}`: another command the agent answers itself; `resync` when the
 *    session must be loaded again afterwards;
 *  - `{route: "prompt"}`: anything else, the model's (an unknown "/word" too). */
export function routeText(text, agent = "hermes") {
  const a = agentOf(agent);
  const slash = parseSlash(text);
  if (!a || a.planned || !slash || !a.commands.includes(slash.name)) return { route: "prompt" };
  if (slash.name === "model" && slash.args) return { route: "model", model: slash.args };
  if (slash.name === "queue" && slash.args) return { route: "queue", text: slash.args };
  if (slash.name === "steer" && slash.args) return { route: "steer", text: text.trim() };
  return { route: "command", name: slash.name, resync: a.resyncCommands.includes(slash.name) };
}

/** The / menu: the commands an agent advertised (`available_commands_update`) minus its hidden ones. */
export function menuCommands(commands, agent = "hermes") {
  const hidden = agentOf(agent)?.hiddenCommands ?? [];
  return Array.isArray(commands) ? commands.filter((c) => typeof c?.name === "string" && !hidden.includes(c.name)) : [];
}
