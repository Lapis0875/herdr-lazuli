// The Files panel's file and folder operations: a new file or folder, a rename, a delete. Herdr has no call for these,
// so each runs as a program through exec, here or on the space's machine (`on`), with every path passed as an argument:
// no name is ever written into a shell string. None of them overwrites anything:
//   new file:    created under noclobber (`set -C`), which opens with O_EXCL: a name taken after the check still fails.
//   new folder:  mkdir, which fails on a name already there.
//   rename:      a file's new name is linked before the old one is unlinked (link and symlink fail when the name is
//                taken). A folder's new name is first made as an empty folder (mkdir fails when it is taken), and the
//                folder is then renamed onto that one in a single rename(2): it replaces only an empty folder this
//                script just made, and fails rather than moving the folder inside another. GNU mv -T makes that call,
//                else perl. A name that differs only in letter case and is the same file or folder (a case-insensitive
//                volume) is renamed in place.
//   delete:      macOS 15's /usr/bin/trash on this Mac (the Trash keeps it), else rm (gone for good). A file's delete
//                refuses a folder; a folder's goes with everything in it. A link to a folder goes alone: its target
//                stays.

import { exec, window as appWindow } from "herdr";

const TRASH = "/usr/bin/trash";
// The scripts' exit codes for "that name is taken", "that is a folder" and "that is not a folder".
const TAKEN = 17;
const FOLDER = 18;
const NOT_FOLDER = 19;
// Counting what a folder holds stops here: past it the confirm says "more than".
const COUNT_LIMIT = 10000;
// A whole tree can take a while to remove; exec allows at most 10 minutes.
const DELETE_TIMEOUT = 600_000;

const CREATE = 'set -C; true > "$1" && exit 0; if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi; exit 1';
const CREATE_FOLDER = 'mkdir -- "$1" && exit 0; if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi; exit 1';
const RENAME = [
  // rename(2) itself, one step: GNU mv -T calls it on the name as given (plain mv would move into a folder there).
  `move() { if mv --version >/dev/null 2>&1; then mv -T -- "$1" "$2"; else perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\\n"' -- "$1" "$2"; fi; }`,
  // A folder (not a link to one): its own letter case in place, else onto an empty folder made for it here.
  'if [ -d "$1" ] && [ ! -L "$1" ]; then',
  '  if [ "$3" = case ] && [ "$1" -ef "$2" ]; then move "$1" "$2" && exit 0; exit 1; fi',
  '  mkdir -- "$2" 2>/dev/null || { if [ -e "$2" ] || [ -L "$2" ]; then exit 17; fi; mkdir -- "$2"; exit 1; }',
  '  move "$1" "$2" && exit 0',
  '  rmdir -- "$2" 2>/dev/null; exit 1',
  "fi",
  // A file. Taken, unless it is this same file under another letter case: then mv renames it where it is.
  'if [ -e "$2" ] || [ -L "$2" ]; then if [ "$3" = case ] && [ "$1" -ef "$2" ]; then exec mv -- "$1" "$2"; fi; exit 17; fi',
  // `link` makes the hard link itself (ln would put it inside a folder by that name); a symlink is made again.
  'if [ -L "$1" ]; then t=$(readlink -- "$1") && ln -s -- "$t" "$2"; else link -- "$1" "$2"; fi || { if [ -e "$2" ] || [ -L "$2" ]; then exit 17; fi; exit 1; }',
  // The old name goes; if it cannot, the new link goes again, but only while both still name the same file.
  'rm -- "$1" && exit 0; if [ "$1" -ef "$2" ]; then rm -- "$2"; fi; exit 1',
].join("\n");
const DELETE = `if [ -d "$1" ] && [ ! -L "$1" ]; then exit 18; fi; if [ "$2" = trash ]; then exec ${TRASH} -s "$1"; fi; exec rm -- "$1"`;
// -f: rm never stops to ask about a read-only file inside, whatever its input is.
const DELETE_FOLDER = `if [ -L "$1" ]; then if [ "$2" = trash ]; then exec ${TRASH} -s "$1"; fi; exec rm -f -- "$1"; fi; [ -d "$1" ] || exit 19; if [ "$2" = trash ]; then exec ${TRASH} -s "$1"; fi; exec rm -rf -- "$1"`;
// What a folder holds, at every depth, hidden entries too; `link` for a link to a folder (its delete leaves the target).
const COUNT = `if [ -L "$1" ]; then echo link; exit 0; fi; [ -d "$1" ] || exit 19; find "$1" -mindepth 1 2>/dev/null | head -n ${COUNT_LIMIT + 1} | wc -l`;

/** Why `name` cannot be a new name in a folder whose entries are `siblings`, or null. `self`: the name being renamed. */
export function invalidName(name, siblings, self = null) {
  if (!name.trim()) return "이름을 입력하세요";
  if (name === "." || name === "..") return `"${name}"은 이름으로 쓸 수 없습니다`;
  if (name.includes("/")) return "이름에 / 를 넣을 수 없습니다";
  if (name !== self && siblings.includes(name)) return "같은 이름이 이미 있습니다";
  return null;
}

/** What a failed program said, in one line: trash's NSError description, else its first line without the program. */
export function reason(r) {
  const text = String(r.stderr || r.stdout || "").trim();
  const ns = text.match(/Code=\d+ "([^"]+)"/);
  if (ns) return ns[1];
  const line = text.split("\n").map((s) => s.trim()).find(Boolean);
  return line ? line.replace(/^(lh-files|ln|link|rm|mv|mkdir|rmdir|readlink)(: line \d+)?:\s*/, "") : `종료 코드 ${r.code}`;
}

/** { ok, stdout } | { taken } | { folder } | { notFolder } | { failed: why } from one script run; a program that could
 *  not start fails too. */
async function run(script, args, on, timeout) {
  let r;
  try {
    r = await exec("sh", ["-c", script, "lh-files", ...args], timeout ? { on, timeout } : { on });
  } catch (e) {
    return { failed: String(e?.message ?? e).replace(/^`herdr\.\w+`:\s*/, "") };
  }
  if (r.code === 0) return { ok: true, stdout: r.stdout };
  if (r.code === TAKEN) return { taken: true };
  if (r.code === FOLDER) return { folder: true };
  if (r.code === NOT_FOLDER) return { notFolder: true };
  return { failed: reason(r) };
}

/** Creates the empty file `abs`, never over one already there. */
export const createFile = (abs, on) => run(CREATE, [abs], on);

/** Creates the empty folder `abs`, never over anything already there. */
export const createFolder = (abs, on) => run(CREATE_FOLDER, [abs], on);

/** Renames the file or folder `from` to `to` (the same folder), never over anything already there. */
export const renameEntry = (from, to, on) => {
  const a = from.split("/").pop();
  const b = to.split("/").pop();
  return run(RENAME, [from, to, a !== b && a.toLowerCase() === b.toLowerCase() ? "case" : ""], on);
};

/** Deletes the file `abs`: to the Trash when `trash`, else for good. */
export const deleteFile = (abs, on, trash) => run(DELETE, [abs, trash ? "trash" : "rm"], on);

/** Deletes the folder `abs` with everything in it (a link to a folder: the link alone): to the Trash when `trash`. */
export const deleteFolder = (abs, on, trash) => run(DELETE_FOLDER, [abs, trash ? "trash" : "rm"], on, DELETE_TIMEOUT);

/**
 * What deleting the folder `abs` takes with it: { link: true } for a link to a folder, { count, more } for a folder
 * (`more`: past COUNT_LIMIT, counting stopped), or null when it could not be counted.
 */
export async function folderContents(abs, on) {
  const r = await run(COUNT, [abs], on);
  if (!r.ok) return null;
  const out = r.stdout.trim();
  if (out === "link") return { link: true };
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? { count: Math.min(n, COUNT_LIMIT), more: n > COUNT_LIMIT } : null;
}

/** Whether a delete in a space `on` that machine goes to the Trash: only this Mac, and only with /usr/bin/trash. */
export async function trashes(on) {
  if (on || appWindow()?.platform !== "macos") return false;
  return exec("test", ["-x", TRASH]).then((r) => r.code === 0, () => false);
}

/** Whether these operations can run in a space `on` that machine: everywhere sh is, so not Windows here. */
export const canOperate = (on) => Boolean(on) || appWindow()?.platform !== "windows";
