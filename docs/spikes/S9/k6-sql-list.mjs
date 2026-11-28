// SESSIONS_SQL + the JS half of the K6 listing (cwd filter, title fallback),
// mirroring acp_adapter/session.py:56-81 and 293-318 of Hermes 0.17.0.
//   node k6-sql-list.mjs <state.db> <abs folder>
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { basename, normalize } from "node:path";
import { homedir } from "node:os";

const [db, folder] = process.argv.slice(2);
const sql = readFileSync(new URL("./sessions.sql", import.meta.url), "utf8");
const run = (target) => execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", target, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let out;
let via = "readonly";
try {
  out = run(db);
} catch (e) {
  // WAL-mode DB whose -wal/-shm were removed by a clean close: a read-only
  // connection cannot create -shm (SQLITE_CANTOPEN, "(14)"). With no -wal
  // file the main file holds every committed page, so immutable=1 is exact.
  if (!/\(14\)/.test(String(e.stderr)) || existsSync(db + "-wal")) throw e;
  out = run(`file:${db}?immutable=1`);
  via = "immutable";
}
console.error(`read via ${via}`);
const rows = out.trim() ? JSON.parse(out) : []; // sqlite3 -json prints nothing for zero rows

const norm = (p) => {
  let s = String(p ?? ".").trim() || ".";
  if (s === "~" || s.startsWith("~/")) s = homedir() + s.slice(1);
  const n = normalize(s);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
};
const title = (r) => {
  if (r.title && r.title.trim()) return r.title.trim();
  const raw = (r.preview || "").trim();
  if (raw) return raw.slice(0, 60) + (raw.length > 60 ? "..." : "");
  return basename(String(r.cwd ?? "").replace(/[\\/]+$/, "")) || "New thread";
};
const list = rows
  .filter((r) => norm(r.cwd ?? ".") === norm(folder))
  .map((r) => ({ session_id: r.id, cwd: r.cwd, title: title(r), updated_at: new Date(r.last_active * 1000).toISOString(), history_len: r.message_count }));
console.log(JSON.stringify(list));
