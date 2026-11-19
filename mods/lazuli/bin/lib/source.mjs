// The file an HTML viewer shows: the folder its static server serves (the repository holding the
// file along the path it was opened by, else the file's folder), its saves, and how the shown page
// is named in the top line.
// The folder is watched, since editors often save by rename, and the file is polled each second.

import fs from "node:fs";
import path from "node:path";

const tilde = (p, home) => (home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);

/** What the top line names for the shown `url`: a page of the static server (`origin`) as its file
 *  under `root` (a rendered Markdown page as its source), another http(s) page as its URL, anything
 *  else as `file`. Not yet safe to print: the caller passes it through kitty.mjs safeText. */
export function displayPath(url, { origin, root, file, home }) {
  try {
    const u = new URL(url);
    if (origin && u.origin === origin) {
      let p = decodeURIComponent(u.pathname);
      if (p.startsWith("/__lazuli/md/")) p = p.slice("/__lazuli/md".length);
      return tilde(path.join(root, p), home) + u.hash;
    }
    if (u.protocol === "http:" || u.protocol === "https:") return url;
  } catch {}
  return tilde(file, home);
}

/** The served folder for the opened `file`, worked out from the path as opened, never from where a
 *  symlink leads: the nearest folder above it holding `.git` (the repository), else the file's own
 *  folder. Returns `{root, rel}` (the root's real path and the file's "/"-separated real path under
 *  it), or `{error: "outside-root"}` when the file resolves outside that root (a symlink leading
 *  out), which is then not served at all; `{error: "no-folder"}` when its folder is gone. The static
 *  server never serves a name starting with ".": a file inside such a folder (`.github/x.md`) is
 *  served from its own folder, and a file so named gives `{error: "hidden-file"}`. */
export async function findRoot(file) {
  const opened = path.resolve(file);
  let root = path.dirname(opened);
  for (let d = root; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) {
      root = d;
      break;
    }
    if (path.dirname(d) === d) break;
  }
  const realRoot = await fs.promises.realpath(root).catch(() => null);
  if (!realRoot) return { error: "no-folder" };
  // A file not there (yet) is named by its folder's real path; the static server refuses it until it is.
  const real = await fs.promises.realpath(opened).catch(async () =>
    path.join(await fs.promises.realpath(path.dirname(opened)).catch(() => path.dirname(opened)), path.basename(opened)),
  );
  const rel = path.relative(realRoot, real);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { error: "outside-root" };
  const parts = rel.split(path.sep);
  if (parts.at(-1).startsWith(".")) return { error: "hidden-file" };
  if (parts.some((s) => s.startsWith("."))) return { root: path.dirname(real), rel: parts.at(-1) };
  return { root: realRoot, rel: parts.join("/") };
}

function signature(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Calls `onChange(exists)` after each change of the file (written, replaced, removed, back).
 *  Returns `{exists}` as found at the start. */
export function watchFile(file, onChange) {
  let sig = signature(file);
  let timer = null;
  const check = () => {
    const now = signature(file);
    if (now === sig) return;
    sig = now;
    onChange(now !== null);
  };
  const base = path.basename(file);
  try {
    fs.watch(path.dirname(file), (_, name) => {
      if (name && String(name) !== base) return;
      clearTimeout(timer);
      timer = setTimeout(check, 120);
    }).on("error", () => {});
  } catch {}
  setInterval(check, 1000);
  return { exists: sig !== null };
}
