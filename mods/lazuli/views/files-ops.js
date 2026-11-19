// The Files panel's reads and file operations (port of
// lstack-herdr's lh-files-ops.js (removed; git history ee5201a) and the tree reads of
// lh-files.js, after Herdr's shipped `files` mod, Apache-2.0). Herdr has no call for these, so each runs as a
// program through exec, here or on the space's machine (`on`), every path passed as an argument: no name is ever
// written into a shell string. None of them overwrites anything:
//   new file:    created under noclobber (`set -C`, O_EXCL): a name taken after the check still fails.
//   new folder:  mkdir, which fails on a name already there.
//   rename:      a file's new name is linked before the old one is unlinked (link and symlink fail on a taken
//                name). A folder's new name is first made as an empty folder, then the folder is renamed onto it
//                in one rename(2) (GNU mv -T, else perl). A change of letter case alone on a case-insensitive
//                volume renames in place.
//   delete:      macOS's /usr/bin/trash (the Trash keeps it), else rm (gone for good). The confirm is bound to what
//                the entry was when it opened (lstat: kind, device and inode, a link's target), checked again
//                right before. Trash takes it from its own place (Put Back works). rm first moves it (`mv -n`) into
//                a fresh holding folder beside it, checks that what arrived there is that same entry, and only then
//                removes it; anything else goes back to its name. A folder goes with everything in it; a link (to a
//                folder too) goes alone.
// Remote spaces are read-only (DESIGN B10): only listing runs there.

import { randomUUID } from "crypto";
import { exec, window as appWindow } from "herdr";
import * as filetabs from "../sys/filetabs.js";

/** Entries listed per folder, and in all. */
export const PER_FOLDER = 500;
export const TOTAL = 5000;

const TRASH = "/usr/bin/trash";
// The scripts' exit codes for "that name is taken", "that is gone" and "it changed since the confirm opened".
const TAKEN = 17;
const MISSING = 19;
const CHANGED = 20;
// The delete could not make its holding folder; a moved entry could not go back to its taken name.
const NO_HOLD = 22;
const STRANDED = 23;
// Counting what a folder holds stops here: past it the confirm says "more than".
const COUNT_LIMIT = 10000;
// A whole tree can take a while to remove; exec allows at most 10 minutes.
const DELETE_TIMEOUT = 600000;
const COUNT_TIMEOUT = 60000;

const CREATE = 'set -C; true > "$1" && exit 0; if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi; exit 1';
const CREATE_FOLDER = 'mkdir -- "$1" && exit 0; if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi; exit 1';
const RENAME = [
  `move() { if mv --version >/dev/null 2>&1; then mv -T -- "$1" "$2"; else perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\\n"' -- "$1" "$2"; fi; }`,
  'if [ -d "$1" ] && [ ! -L "$1" ]; then',
  '  if [ "$3" = case ] && [ "$1" -ef "$2" ]; then move "$1" "$2" && exit 0; exit 1; fi',
  '  mkdir -- "$2" 2>/dev/null || { if [ -e "$2" ] || [ -L "$2" ]; then exit 17; fi; mkdir -- "$2"; exit 1; }',
  '  move "$1" "$2" && exit 0',
  '  rmdir -- "$2" 2>/dev/null; exit 1',
  "fi",
  'if [ -e "$2" ] || [ -L "$2" ]; then if [ "$3" = case ] && [ "$1" -ef "$2" ]; then exec mv -- "$1" "$2"; fi; exit 17; fi',
  'if [ -L "$1" ]; then t=$(readlink -- "$1") && ln -s -- "$t" "$2"; else link -- "$1" "$2"; fi || { if [ -e "$2" ] || [ -L "$2" ]; then exit 17; fi; exit 1; }',
  'rm -- "$1" && exit 0; if [ "$1" -ef "$2" ]; then rm -- "$2"; fi; exit 1',
].join("\n");
// `ident <path>` sets k (link | dir | file), i (device:inode, never following a link) and t (a link's target), or
// fails when the path is gone. GNU stat first (`-c`); BSD stat reads `-f` (on GNU `-f` means the file system).
const IDENT = [
  "ident() {",
  '  if [ -L "$1" ]; then k=link; t=$(readlink -- "$1") || return 1',
  '  elif [ -d "$1" ]; then k=dir; t=',
  '  elif [ -e "$1" ]; then k=file; t=',
  "  else return 1; fi",
  `  i=$(stat -c '%d:%i' -- "$1" 2>/dev/null || stat -f '%d:%i' -- "$1" 2>/dev/null) || return 1`,
  '  [ -n "$i" ]',
  "}",
].join("\n");
const IDENTIFY = `${IDENT}\nident "$1" || exit ${MISSING}; printf '%s\\0%s\\0%s' "$k" "$i" "$t"`;
// $1 path, $2 trash | rm, $3-$5 the kind, identity and link target the confirm showed, $6 a fresh holding folder
// beside it. Trash: the identity is checked again and the entry goes to the Trash from its own place, so "Put Back"
// knows where it came from (a Trash move can be undone, so the tiny window left is acceptable). rm: the entry is
// first moved (never over anything) into that private folder, keeping its name, and only what arrived there is
// checked against the confirmed identity and then removed, so a replacement made in between is never deleted. A move
// that fails reports its own error. On a mismatch or a failed removal, whatever was moved goes back to its name when
// that name is free (`mv -n`); otherwise it stays in the holding folder, whose path is printed.
const DELETE = [
  IDENT,
  'P=$1; HOW=$2; K=$3; I=$4; T=$5; HOLD=$6; MOVED="$6/${1##*/}"',
  'same() { ident "$1" && [ "$k" = "$K" ] && [ "$i" = "$I" ] && [ "$t" = "$T" ]; }',
  'here() { [ -e "$1" ] || [ -L "$1" ]; }',
  `back() { if here "$MOVED"; then here "$P" || mv -n -- "$MOVED" "$P"; if here "$MOVED"; then printf '%s' "$MOVED"; exit ${STRANDED}; fi; fi; rmdir -- "$HOLD" 2>/dev/null; }`,
  `same "$P" || exit ${CHANGED}`,
  `if [ "$HOW" = trash ]; then out=$(${TRASH} -s "$P" 2>&1) && exit 0; printf '%s\\n' "$out" >&2; exit 1; fi`,
  `mkdir -m 700 -- "$HOLD" || exit ${NO_HOLD}`,
  'if ! mv -n -- "$P" "$MOVED"; then back; exit 1; fi',
  `here "$MOVED" || { rmdir -- "$HOLD" 2>/dev/null; echo "mv: $P was not moved" >&2; exit 1; }`,
  `same "$MOVED" || { back; exit ${CHANGED}; }`,
  'case "$k" in dir) out=$(rm -rf -- "$MOVED" 2>&1);; *) out=$(rm -f -- "$MOVED" 2>&1);; esac; s=$?',
  `if [ "$s" -ne 0 ]; then printf '%s\\n' "$out" >&2; back; exit 1; fi`,
  'rmdir -- "$HOLD" 2>/dev/null; exit 0',
].join("\n");
// What a folder holds, every depth, hidden entries too. Any entry find could not read makes it "fail" (the confirm
// then says it could not count); past the limit it stops at "more".
const COUNT = [
  `[ -d "$1" ] && [ ! -L "$1" ] || exit ${MISSING}`,
  `{ find "$1" -mindepth 1 2>/dev/null; echo "status:$?"; } | awk -v max=${COUNT_LIMIT} '/^status:/ { s = substr($0, 8); next } { n++; if (n > max) { print "more"; exit } } END { if (n > max) exit; if (s != "0") print "fail"; else print n + 0 }'`,
].join("\n");
const LIST = `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=\${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt ${PER_FOLDER} ] && break; done; test -d "$1"`;

const said = (e) => String(e?.message ?? e).replace(/^`herdr\.\w+`:\s*/, "");

/** What a failed program said, in one line: trash's NSError description, else its first line without the program. */
export function reason(r) {
  const text = String(r.stderr || r.stdout || "").trim();
  const ns = text.match(/Code=\d+ "([^"]+)"/);
  if (ns) return ns[1];
  const line = text.split("\n").map((s) => s.trim()).find(Boolean);
  return line ? line.replace(/^(lazuli-files|ln|link|rm|mv|mkdir|rmdir|readlink)(: line \d+)?:\s*/, "") : `exit ${r.code}`;
}

/** {ok, stdout} | {taken} | {missing} | {changed} | {failed: why} from one script run. */
async function run(script, args, on, timeout) {
  let r;
  try {
    r = await exec("sh", ["-c", script, "lazuli-files", ...args], timeout ? { on, timeout } : { on });
  } catch (e) {
    return { failed: said(e) };
  }
  if (r.code === 0) return { ok: true, stdout: r.stdout };
  if (r.code === TAKEN) return { taken: true };
  if (r.code === MISSING) return { missing: true };
  if (r.code === CHANGED) return { changed: true };
  if (r.code === STRANDED) return { stranded: r.stdout.trim() };
  return { failed: reason(r) };
}

/** Creates the empty file `abs`, never over one already there. */
export const createFile = (abs, on) => run(CREATE, [abs], on);

/** Creates the empty folder `abs`, never over anything already there. */
export const createFolder = (abs, on) => run(CREATE_FOLDER, [abs], on);

/** Renames the file or folder `from` to `to` (in the same folder), never over anything already there. */
export async function renameEntry(from, to, on) {
  const a = from.split("/").pop();
  const b = to.split("/").pop();
  const r = await run(RENAME, [from, to, a !== b && a.toLowerCase() === b.toLowerCase() ? "case" : ""], on);
  // Open file tabs on the file (or anything under the folder) follow it to its new name.
  if (r.ok) {
    try {
      const n = filetabs.renamed?.(from, to, { on: on ?? null });
      if (n) console.log(`[lazuli/files] rename moved ${n} file tab(s)`);
    } catch (e) {
      console.log(`[lazuli/files] tab rename failed: ${e?.message ?? e}`);
    }
  }
  return r;
}

/** What `abs` is now, without following a link: `{kind: "link" | "dir" | "file", id: "dev:ino", target}`, or
 *  `{missing}` / `{failed}`. */
export async function identify(abs, on) {
  const r = await run(IDENTIFY, [abs], on);
  if (!r.ok) return r;
  const [kind, id, target = ""] = r.stdout.split("\0");
  return kind && id ? { kind, id, target } : { failed: "stat" };
}

/** Deletes `abs` if it is still exactly what `ident` (from identify) says: to the Trash when `trash`, else for good.
 *  It is moved aside first into a fresh holding folder beside it, so only the confirmed entry can be removed.
 *  `{ok}`, `{changed}` (nothing deleted; put back), `{stranded: path}` (not deleted and its name was taken
 *  meanwhile, so it waits at `path`), or `{failed}`. */
export function deleteEntry(abs, on, trash, ident) {
  const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
  const hold = `${dir === "/" ? "" : dir}/.lazuli-del-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  return run(DELETE, [abs, trash ? "trash" : "rm", ident.kind, ident.id, ident.target ?? "", hold], on, DELETE_TIMEOUT);
}

/** What deleting a folder takes along: `{count, more}`, or null when it could not be counted (an unreadable entry,
 *  a timeout, not a folder). */
export async function folderContents(abs, on) {
  const r = await run(COUNT, [abs], on, COUNT_TIMEOUT);
  if (!r.ok) return null;
  const out = r.stdout.trim();
  if (out === "more") return { count: COUNT_LIMIT, more: true };
  const n = /^\d+$/.test(out) ? Number(out) : NaN;
  return Number.isFinite(n) ? { count: n, more: false } : null;
}

/** Whether a delete goes to the Trash: only on this Mac, and only with /usr/bin/trash. */
export async function trashes(on) {
  if (on || appWindow()?.platform !== "macos") return false;
  return exec("test", ["-x", TRASH]).then((r) => r.code === 0, () => false);
}

/** Whether files can be made, renamed and deleted in a space on that machine: here only (B10), where sh is. */
export const canOperate = (on) => !on && appWindow()?.platform !== "windows";

async function windowsDirectory(path, on) {
  // PowerShell otherwise writes the console code page; links keep directory attributes even when dangling.
  const r = await exec(
    "powershell",
    ["-NoProfile", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First ${PER_FOLDER + 1} | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '${path.replace(/['‘’‚‛]/g, "$&$&")}'`],
    { on },
  );
  if (r.code !== 0) throw new Error(r.stderr || path);
  const out = JSON.parse(r.stdout || "[]");
  return Array.isArray(out) ? out : [out];
}

/** A folder's entries `{name, dir}` (at most PER_FOLDER + 1, `.git` left out), unsorted. Throws when unreadable. */
export async function directory(path, on) {
  if (!on && appWindow()?.platform === "windows") return windowsDirectory(path, on);
  let r;
  try {
    r = await exec("sh", ["-c", LIST, "lazuli-files", path], { on });
  } catch (e) {
    if (on && String(e).includes("program not found")) return windowsDirectory(path, on);
    throw new Error(said(e));
  }
  if (r.code !== 0) throw new Error(r.stderr.trim() || path);
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

/** Git's marks under `cwd`, by absolute path: M modified, U untracked, A added, D deleted, C conflict; plus the
 *  branch. `{marks: {}, branch: null}` outside a repository. Writes nothing under .git (no index lock). */
export async function gitMarks(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (top?.code !== 0) return { marks: {}, branch: null };
  const root = top.stdout.trim();
  const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--branch", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
  const marks = {};
  let branch = null;
  if (status?.code === 0) {
    for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL + 1)) {
      if (entry.startsWith("## ")) {
        branch = entry.slice(3).split("...")[0].replace(/^No commits yet on /, "").trim() || null;
        continue;
      }
      const xy = entry.slice(0, 2);
      const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
      marks[`${root}/${entry.slice(3)}`] = conflict ? "C" : xy === "??" ? "U" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
    }
  }
  return { marks, branch };
}
