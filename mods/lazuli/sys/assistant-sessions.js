// The Assistant's sessions on disk (CONTRACTS K6, K8; spike S9): Hermes's profiles, each profile's ACP sessions read
// read-only from its `state.db` with Hermes's own listing query (core/assistant-list.js SESSIONS_SQL), and the folder's
// files for the composer's @ menu. Nothing here writes under ~/.hermes.
//
// Every function takes `run(command, args, options)`, resolving `{code, stdout, stderr}` (Herdr's `exec`, or Node's
// child_process in tests), so this module imports no host module and tests run it against real sqlite3 databases.
//
// The query: `/usr/bin/sqlite3 -readonly -json <db> SESSIONS_SQL`. A WAL database that Hermes closed cleanly has no
// `-wal`/`-shm`, and a read-only connection cannot create `-shm`: sqlite3 fails with "unable to open database file
// (14)" (S9). With no `-wal` file the main file holds every committed page, so the query runs once more on
// `file:<db>?immutable=1`. A database without a column or table the query reads (another Hermes version) is
// `{error: "schema"}`; a profile without a `state.db` has no sessions yet.

import { SESSIONS_SQL, mapRows, isProfileName, firmlinkShort } from "../core/assistant-list.js";
import { stateDbPath, profilesDir } from "../core/assistant-agents.js";
import { kindOf } from "../core/paths.js";

export const SQLITE = "/usr/bin/sqlite3";
/** Query and listing deadlines (ms). */
const QUERY_MS = 15000;
const LIST_MS = 15000;
/** The @ menu lists at most this many files, at most this deep. */
export const MAX_FILES = 2000;
const MAX_DEPTH = 8;
/** The walk's output is cut at this many bytes (about four times MAX_FILES paths): `head` then closes the pipe and
 *  `find` stops at its next write, so a huge folder costs no more than this. */
export const WALK_BYTES = 512 * 1024;
// find "$folder" <args…> -print0, its output cut at WALK_BYTES (find's own complaints go nowhere).
const WALK = `f=$1; shift; /usr/bin/find "$f" "$@" 2>/dev/null | /usr/bin/head -c ${WALK_BYTES}`;
/** Folders the @ menu never lists. */
const SKIPPED = Object.freeze([".git", "node_modules", ".venv", "venv", "__pycache__", ".DS_Store"]);

const DETAIL_MAX = 400;
const said = (r) => String(r?.stderr || r?.stdout || "").trim().slice(0, DETAIL_MAX);
const errText = (e) => e?.message ?? String(e);

/** A path in a SQLite URI filename: `%`, `?` and `#` escaped (the rest is taken as it is). */
const uriPath = (p) => String(p).replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23");

/** Whether `path` exists (as `test -e`). */
async function exists(run, path) {
  try {
    return (await run("/bin/test", ["-e", path], { timeout: 5000 })).code === 0;
  } catch {
    return false;
  }
}

/**
 * The result of one sqlite3 run of SESSIONS_SQL: `{rows}` (rows of core/assistant-list.js mapRows), or `{error, detail}`
 * with `error` one of `schema` (a column or table the query reads is missing), `locked`, `open` (the file cannot be
 * opened), `parse` (output that is not a JSON array) or `failed`.
 */
export function queryResult(r) {
  if (r && r.code === 0) {
    const rows = mapRows(r.stdout ?? "");
    return rows ? { rows } : { error: "parse", detail: String(r.stdout ?? "").slice(0, DETAIL_MAX) };
  }
  const text = said(r);
  if (/no such (column|table)/i.test(text)) return { error: "schema", detail: text };
  if (/database is locked|database table is locked/i.test(text)) return { error: "locked", detail: text };
  if (/unable to open database file|\(14\)/i.test(text)) return { error: "open", detail: text };
  return { error: "failed", detail: text };
}

/**
 * One state.db's ACP sessions: `{rows, via}` (`via` "readonly" or "immutable") or `{error, detail}`. A missing file is
 * `{rows: [], via: "absent"}`: that profile has no sessions yet.
 */
export async function querySessions(run, db) {
  if (typeof db !== "string" || !db.startsWith("/")) return { error: "failed", detail: "no database path" };
  if (!(await exists(run, db))) return { rows: [], via: "absent" };
  const once = async (target) => {
    try {
      return await run(SQLITE, ["-readonly", "-json", target, SESSIONS_SQL], { timeout: QUERY_MS });
    } catch (e) {
      return { code: -1, stdout: "", stderr: errText(e) };
    }
  };
  const first = await once(db);
  const r = queryResult(first);
  if (!r.error) return { ...r, via: "readonly" };
  if (r.error !== "open" || !/\(14\)/.test(said(first)) || (await exists(run, `${db}-wal`))) return r;
  const again = queryResult(await once(`file:${uriPath(db)}?immutable=1`));
  return again.error ? again : { ...again, via: "immutable" };
}

/** One profile's sessions: `querySessions` on its state.db (`~/.hermes/state.db` for `default`). */
export function profileSessions(run, home, profile) {
  const db = stateDbPath(home, profile);
  return db ? querySessions(run, db) : Promise.resolve({ error: "failed", detail: `bad profile ${profile}` });
}

/** Folder names → the profiles that may run: `default`, then every valid profile name, each once, by name. */
export function profileNames(text) {
  const names = String(text ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/\/+$/, ""))
    .map((l) => l.slice(l.lastIndexOf("/") + 1))
    .filter((n) => n !== "default" && isProfileName(n));
  return ["default", ...[...new Set(names)].sort()];
}

/** Hermes's profiles: `default` (~/.hermes itself) and each folder under ~/.hermes/profiles with a valid name. */
export async function listProfiles(run, home) {
  const dir = profilesDir(home);
  if (!dir || !(await exists(run, dir))) return ["default"];
  try {
    const r = await run("/usr/bin/find", [dir, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], { timeout: LIST_MS });
    return profileNames(r.code === 0 ? r.stdout : "");
  } catch {
    return ["default"];
  }
}

/** `find` output (NUL-separated absolute paths under `folder`) → folder-relative paths for the @ menu, images left
 *  out (core/paths.js kindOf "image"), sorted shallow first then by name, at most MAX_FILES. Text after the last NUL
 *  (a path the WALK_BYTES cut ended inside) is left out. */
export function folderFileList(output, folder) {
  const root = String(folder ?? "").replace(/\/+$/, "");
  const prefix = `${root}/`;
  const out = [];
  const text = String(output ?? "");
  for (const p of text.slice(0, text.lastIndexOf("\0") + 1).split("\0")) {
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (!rel || kindOf(rel) === "image") continue;
    out.push(rel);
  }
  const depth = (s) => s.split("/").length;
  out.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  return out.slice(0, MAX_FILES);
}

/** The folder's files for the @ menu: hidden entries and SKIPPED folders are not walked, and the walk stops after
 *  WALK_BYTES of output. Resolves `[]` on any failure (a missing folder too). */
export async function listFolderFiles(run, folder) {
  if (typeof folder !== "string" || !folder.startsWith("/")) return [];
  const prune = ["(", "-name", ".*", ...SKIPPED.flatMap((n) => ["-o", "-name", n]), ")", "-prune"];
  const args = ["-mindepth", "1", "-maxdepth", String(MAX_DEPTH), ...prune, "-o", "-type", "f", "-print0"];
  try {
    const r = await run("/bin/sh", ["-c", WALK, "lazuli-walk", folder, ...args], { timeout: LIST_MS });
    // find exits non-zero on an unreadable subfolder and still prints the rest; the pipeline's status is head's.
    return folderFileList(r.stdout, folder);
  } catch {
    return [];
  }
}

// Each argument → its physical path (`cd -P` then `pwd -P`: symlinks and macOS firmlinks resolved), or "" when it is
// not a folder that can be entered, each followed by a NUL.
const RESOLVE = 'CDPATH=; for p do r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || r=""; printf "%s\\0" "$r"; done';
const RESOLVE_BATCH = 200;

/** Folders → `{[path]: resolved path}` ("" for one that does not resolve: missing, not a folder, unreadable). Only
 *  absolute paths without NUL or newline are asked; anything else is left out. */
export async function resolvePaths(run, paths) {
  const list = [...new Set((Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p.startsWith("/") && !/[\0\n]/.test(p)))];
  const out = {};
  for (let i = 0; i < list.length; i += RESOLVE_BATCH) {
    const part = list.slice(i, i + RESOLVE_BATCH);
    let got = [];
    try {
      const r = await run("/bin/sh", ["-c", RESOLVE, "lazuli-resolve", ...part], { timeout: LIST_MS });
      if (r.code === 0) got = String(r.stdout ?? "").split("\0");
    } catch {
      got = [];
    }
    part.forEach((p, j) => {
      out[p] = typeof got[j] === "string" ? got[j] : "";
    });
  }
  return out;
}

/** The form of a folder to keep: a path under macOS's `/private` (the system folder picker gives `/private/tmp/x`
 *  for `/tmp/x`) becomes its short form when both resolve to the same folder; any other path stays as it is. */
export async function shortFolder(run, path) {
  const short = firmlinkShort(path);
  if (!short) return path;
  const r = await resolvePaths(run, [path, short]);
  return r[path] && r[path] === r[short] ? short : path;
}
