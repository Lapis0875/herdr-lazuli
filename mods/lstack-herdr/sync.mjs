#!/usr/bin/env node
// Generates the lstack-herdr fork of cockpit from upstream, which `cockpit app install` keeps fresh and nobody edits:
//   mods/cockpit/            → mods/lstack-herdr-cockpit/   (mod-name rewrite, hooks, components/; every upstream
//                                                            file it changes carries a one-line "Modified by" notice)
//   layouts/cockpit.json     → layouts/lstack-herdr.json    (mod refs → the fork, the tree panel in
//                                                            panel-body, the Files panel on the fork's editor; floating
//                                                            blocks added to layouts/lstack-herdr.json since, by hand or
//                                                            by another tool such as herdr-relay's mirror, are kept)
//   layouts/cockpit.svg      → layouts/lstack-herdr.svg     (the preview)
//   keys.json layout:cockpit → keys.json layout:lstack-herdr (prefix renamed, ctrl-cmd-6 for the tree)
//
//   node ~/.config/herdr-app/mods/lstack-herdr/sync.mjs [--check] [--home <herdr-app home>] [--json]
//
// Everything is built in memory first. A hook whose anchor is missing or repeated fails the build: nothing is written,
// the previous output stays, the reason is printed (exit 1). Each output is then replaced whole, one after another; a
// write that fails part way reports which ones it already replaced (exit 1), and running it again finishes the job.
// An unchanged result writes nothing, so a second run is a no-op. --check reports what would change without writing
// (exit 2 when something would).

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { HOOKS, KNOWN_PANELS } from "./hooks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const HOME = path.resolve(opt("--home") ?? path.join(HERE, "..", ".."));
const UP = "cockpit";
const FORK = "lstack-herdr-cockpit";
const LAYOUT = "lstack-herdr";
const UP_MOD = path.join(HOME, "mods", UP);
const FORK_MOD = path.join(HOME, "mods", FORK);
const STAMP = ".lstack-sync.json";
// Files Herdr writes into every mod folder itself; copying them would only churn.
const APP_WRITTEN = new Set(["gpui-kit.d.ts", "jsconfig.json"]);

class SyncError extends Error {}
const fail = (msg) => {
  throw new SyncError(msg);
};

function walk(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile() && !APP_WRITTEN.has(e.name) && !e.name.endsWith(".error")) out.push(r);
  }
  return out.sort();
}

/** The mod name rewrite: every place a cockpit file names its own mod, by kind, with how many it found. */
function rewrite(text) {
  const counts = { assets: 0, commands: 0, overlays: 0, checks: 0 };
  let t = text.replace(/mods\/cockpit\//g, () => (counts.assets++, `mods/${FORK}/`));
  // `cockpit.<command>` (its keys, menu items, toast actions) and its `cockpit.*` shared keys, as string literals.
  t = t.replace(/(["'`])cockpit\.(?!json\b|svg\b)(?=[a-z])/g, (_m, q) => (counts.commands++, `${q}${FORK}.`));
  t = t.replace(/\bmod:\s*"cockpit"/g, () => (counts.overlays++, `mod: "${FORK}"`));
  t = t.replace(/\.mod\s*===\s*"cockpit"/g, (m) => (counts.checks++, m.replace('"cockpit"', `"${FORK}"`)));
  return { text: t, counts };
}

function applyHook(files, hook) {
  const text = files.get(hook.file);
  if (text === undefined) fail(`hook target ${hook.file} is missing upstream`);
  const first = text.indexOf(hook.anchor);
  if (first < 0) fail(`anchor not found in ${hook.file}: ${JSON.stringify(hook.anchor.split("\n")[0])}`);
  if (text.indexOf(hook.anchor, first + 1) >= 0) fail(`anchor appears more than once in ${hook.file}: ${JSON.stringify(hook.anchor.split("\n")[0])}`);
  const end = first + hook.anchor.length;
  const next =
    hook.where === "before" ? text.slice(0, first) + hook.text + text.slice(first)
    : hook.where === "after" ? text.slice(0, end) + hook.text + text.slice(end)
    : hook.where === "replace" ? text.slice(0, first) + hook.text + text.slice(end)
    : fail(`hook on ${hook.file} has an unknown place ${hook.where}`);
  files.set(hook.file, next);
}

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

/** Every layout node, depth first: the node, then its children. */
function* nodes(node) {
  if (!node || typeof node !== "object") return;
  yield node;
  for (const c of node.children ?? []) yield* nodes(c);
}

/** A floating block's identity: its id, else the whole block. */
const floatKey = (f) => (typeof f?.id === "string" ? `id:${f.id}` : `json:${JSON.stringify(f)}`);

/**
 * Floating blocks the current layouts/lstack-herdr.json has and cockpit's layout does not (herdr-relay's mirror, or
 * one added by hand) go back into the new layout, on the node that held them (by id; the root when that node is gone),
 * after cockpit's own. A block cockpit's layout also has (same id) is cockpit's: the new layout keeps cockpit's.
 */
function keepAddedFloats(layout, warnings) {
  const file = path.join(HOME, "layouts", `${LAYOUT}.json`);
  if (!fs.existsSync(file)) return;
  let before;
  try {
    before = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    warnings.push(`layouts/${LAYOUT}.json is not JSON (${e.message}): floating blocks added to it could not be kept`);
    return;
  }
  const have = new Set();
  for (const node of nodes(layout)) for (const f of node.floating ?? []) have.add(floatKey(f));
  for (const node of nodes(before)) {
    const added = (Array.isArray(node.floating) ? node.floating : []).filter((f) => !have.has(floatKey(f)));
    if (!added.length) continue;
    const host = (typeof node.id === "string" && findNode(layout, node.id)) || layout;
    host.floating = [...(host.floating ?? []), ...added];
    for (const f of added) have.add(floatKey(f));
  }
}

/** Every `mod: "cockpit"` in the layout, wherever it sits (blocks, pane headers, floating blocks). */
function retarget(value, counter) {
  if (Array.isArray(value)) return value.map((v) => retarget(v, counter));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "mod" && v === UP) {
      counter.n++;
      out[k] = FORK;
    } else out[k] = retarget(v, counter);
  }
  return out;
}

function buildLayout(warnings) {
  const src = path.join(HOME, "layouts", `${UP}.json`);
  if (!fs.existsSync(src)) fail(`layouts/${UP}.json is missing`);
  let layout;
  try {
    layout = JSON.parse(fs.readFileSync(src, "utf8"));
  } catch (e) {
    fail(`layouts/${UP}.json is not JSON: ${e.message}`);
  }
  const counter = { n: 0 };
  layout = retarget(layout, counter);
  if (!counter.n) fail(`layouts/${UP}.json names no "${UP}" mod: the layout changed shape`);
  const body = findNode(layout, "panel-body");
  if (!body || body.type !== "stack" || !Array.isArray(body.children)) fail('layouts/cockpit.json has no "panel-body" stack');
  const ids = body.children.map((c) => c.id);
  const added = ids.filter((id) => !KNOWN_PANELS.includes(id));
  const gone = KNOWN_PANELS.filter((id) => !ids.includes(id));
  if (added.length) warnings.push(`upstream added side panel ${added.join(", ")}: it is in the fork's panel, check the tree tab still sits last`);
  if (gone.length) warnings.push(`upstream removed side panel ${gone.join(", ")}`);
  // Upstream's Files tab is Herdr's shipped `files` mod (a read-only preview); here it is components/lh-files.js.
  const files = body.children.find((c) => c.id === "files");
  if (files?.content?.mod === "files") files.content = { mod: FORK, props: { app: "files" } };
  else if (files) warnings.push('the side panel\'s "files" block no longer shows the files mod: it stays as upstream has it, without the editor');
  if (!ids.includes("tree")) body.children.push({ id: "tree", type: "block", content: { mod: FORK, props: { app: "tree" } } });
  if (!findNode(layout, "activity")) fail('layouts/cockpit.json has no "activity" block');
  layout.preview = `layouts/${LAYOUT}.svg`;
  keepAddedFloats(layout, warnings);
  return `${JSON.stringify(layout, null, 2)}\n`;
}

function buildKeys(warnings) {
  const file = path.join(HOME, "keys.json");
  const text = fs.readFileSync(file, "utf8");
  let keys;
  try {
    keys = JSON.parse(text);
  } catch (e) {
    fail(`keys.json is not JSON: ${e.message}`);
  }
  const up = keys[`layout:${UP}`];
  if (!up || typeof up !== "object") fail(`keys.json has no "layout:${UP}" section`);
  const ours = { ...(keys[`layout:${LAYOUT}`] ?? {}) };
  for (const [key, action] of Object.entries(up)) {
    ours[key] = typeof action === "string" && action.startsWith(`${UP}.`) ? `${FORK}.${action.slice(UP.length + 1)}` : action;
  }
  if (up["ctrl-cmd-6"] && !String(up["ctrl-cmd-6"]).includes("panel:tree")) warnings.push(`cockpit now binds ctrl-cmd-6 (${up["ctrl-cmd-6"]}); the tree keeps it in layout:${LAYOUT}`);
  ours["ctrl-cmd-6"] = `${FORK}.panel:tree`;
  const next = { ...keys, [`layout:${LAYOUT}`]: ours };
  // keys.json is the installer's compact JSON; it round-trips byte for byte, so only our section changes.
  const compact = JSON.stringify(JSON.parse(text)) === text.trimEnd();
  return compact ? JSON.stringify(next) + (text.endsWith("\n") ? "\n" : "") : `${JSON.stringify(next, null, 2)}\n`;
}

function upstreamVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, "cockpit.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function hash(buffers) {
  const h = crypto.createHash("sha256");
  for (const [name, b] of buffers) h.update(name).update("\0").update(b).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** The whole output, in memory: the fork's files, the layout, its preview, keys.json. */
function build() {
  const warnings = [];
  if (!fs.existsSync(path.join(UP_MOD, "main.js"))) fail(`mods/${UP}/main.js is missing: is cockpit installed?`);
  const upstream = walk(UP_MOD);
  const files = new Map();
  const assets = new Map();
  const totals = { assets: 0, commands: 0, overlays: 0, checks: 0 };
  const raw = [];
  for (const rel of upstream) {
    const buf = fs.readFileSync(path.join(UP_MOD, rel));
    raw.push([rel, buf]);
    if (rel.endsWith(".js")) {
      const { text, counts } = rewrite(buf.toString("utf8"));
      for (const k of Object.keys(totals)) totals[k] += counts[k];
      files.set(rel, text);
    } else assets.set(rel, buf);
  }
  // Each kind of self-reference exists in cockpit 0.38; one gone means the code moved and the rewrite needs a look.
  for (const [kind, n] of Object.entries(totals)) if (!n) fail(`the mod-name rewrite found no ${kind} to rewrite: upstream changed`);
  for (const hook of HOOKS) applyHook(files, hook);
  const leftovers = [...files].filter(([, t]) => /\bmod:\s*"cockpit"|(["'`])cockpit\.(?!json\b|svg\b)[a-z]/.test(t)).map(([f]) => f);
  if (leftovers.length) fail(`cockpit self-references survived the rewrite in ${leftovers.join(", ")}`);
  // Apache-2.0 §4(b): every upstream file the rewrite or a hook changed says so in its first line (after a shebang).
  const version = upstreamVersion();
  const hooked = new Set(HOOKS.map((h) => h.file));
  for (const [rel, buf] of raw) {
    const text = files.get(rel);
    if (text === undefined || text === buf.toString("utf8")) continue;
    const notice = `// Modified by lstack-herdr (https://github.com/Lapis0875/herdr-lstack-layout): generated by mods/lstack-herdr/sync.mjs from cockpit ${version ?? "unknown"}, cockpit's own mod name rewritten to lstack-herdr-cockpit${hooked.has(rel) ? ", lstack-herdr hooks applied" : ""}.\n`;
    const eol = text.startsWith("#!") ? text.indexOf("\n") : -1;
    files.set(rel, eol < 0 ? notice + text : text.slice(0, eol + 1) + notice + text.slice(eol + 1));
  }

  for (const rel of walk(path.join(HERE, "components"))) {
    if (files.has(rel) || assets.has(rel)) fail(`component ${rel} would overwrite an upstream file`);
    const buf = fs.readFileSync(path.join(HERE, "components", rel));
    if (rel.endsWith(".js")) files.set(rel, buf.toString("utf8"));
    else assets.set(rel, buf);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(UP_MOD, "mod.json"), "utf8"));
  assets.set("mod.json", Buffer.from(`${JSON.stringify({ ...manifest, title: "Cockpit (lstack-herdr)" })}\n`));

  const fork = new Map([...[...files].map(([k, v]) => [k, Buffer.from(v)]), ...assets]);
  // The layout and keys first: their warnings belong in the stamp, which is what the fork's toasts read.
  const layout = Buffer.from(buildLayout(warnings));
  const keys = Buffer.from(buildKeys(warnings));
  const stamp = {
    generator: "mods/lstack-herdr/sync.mjs",
    cockpit: version,
    upstream: hash(raw),
    source: hash([...walk(HERE).filter((f) => !f.startsWith("omp/")).map((f) => [f, fs.readFileSync(path.join(HERE, f))])]),
    hooks: HOOKS.length,
    warnings,
  };
  fork.set(STAMP, Buffer.from(`${JSON.stringify(stamp, null, 2)}\n`));

  const svg = path.join(HOME, "layouts", `${UP}.svg`);
  return {
    fork,
    layout,
    preview: fs.existsSync(svg) ? fs.readFileSync(svg) : null,
    keys,
    stamp,
    totals,
  };
}

function sameDir(dir, files) {
  if (!fs.existsSync(dir)) return false;
  const have = [...walk(dir), ...(fs.existsSync(path.join(dir, STAMP)) ? [STAMP] : [])].sort();
  const want = [...files.keys()].sort();
  if (have.length !== want.length || have.some((f, i) => f !== want[i])) return false;
  return want.every((f) => fs.readFileSync(path.join(dir, f)).equals(files.get(f)));
}

const sameFile = (file, buf) => fs.existsSync(file) && fs.readFileSync(file).equals(buf);

/** Writes a file in one step (a sibling temp file renamed over it), so Herdr never reads half of it. */
function atomicWrite(file, buf) {
  const tmp = `${path.dirname(file)}/.${path.basename(file)}.lstack-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/** The new fork beside the old, then swapped in; the old one is removed only once the new one is in place. Staging
 *  happens outside mods/ (same volume, so the renames are moves), where Herdr would take a half-built folder for a mod. */
function writeFork(files) {
  const cache = path.join(os.homedir(), ".cache", "lstack-herdr");
  fs.mkdirSync(cache, { recursive: true });
  const stage = path.join(cache, `${FORK}.new-${process.pid}`);
  const old = path.join(cache, `${FORK}.old-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  for (const [rel, buf] of files) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, rel), buf);
  }
  // Herdr's own files in the fork (its typings) carry over instead of waiting for the next start to come back.
  if (fs.existsSync(FORK_MOD)) for (const f of APP_WRITTEN) if (fs.existsSync(path.join(FORK_MOD, f))) fs.copyFileSync(path.join(FORK_MOD, f), path.join(stage, f));
  if (fs.existsSync(FORK_MOD)) fs.renameSync(FORK_MOD, old);
  try {
    fs.renameSync(stage, FORK_MOD);
  } catch (e) {
    if (fs.existsSync(old)) fs.renameSync(old, FORK_MOD);
    throw e;
  }
  // The new fork is in place; a leftover old copy under ~/.cache/lstack-herdr is harmless, so failing to remove it
  // must not report the swap as failed.
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch {}
}

function main() {
  const json = flag("--json");
  const say = (result) => {
    if (json) console.log(JSON.stringify(result));
    else if (result.ok) {
      console.log(result.changed.length ? `lstack-herdr: updated ${result.changed.join(", ")}` : "lstack-herdr: already up to date");
      for (const w of result.warnings) console.log(`warning: ${w}`);
    } else if (result.phase === "write")
      console.error(
        `lstack-herdr: sync failed while writing, run it again; ${result.written.length ? `already replaced: ${result.written.join(", ")}` : "nothing was replaced"}: ${result.error}`,
      );
    else console.error(`lstack-herdr: sync failed, previous output kept: ${result.error}`);
  };
  let out;
  try {
    out = build();
  } catch (e) {
    say({ ok: false, phase: "build", error: e instanceof SyncError ? e.message : String(e?.stack ?? e) });
    process.exit(1);
  }
  const layoutFile = path.join(HOME, "layouts", `${LAYOUT}.json`);
  const previewFile = path.join(HOME, "layouts", `${LAYOUT}.svg`);
  const keysFile = path.join(HOME, "keys.json");
  const changed = [];
  if (!sameDir(FORK_MOD, out.fork)) changed.push(`mods/${FORK}/`);
  if (!sameFile(layoutFile, out.layout)) changed.push(`layouts/${LAYOUT}.json`);
  if (out.preview && !sameFile(previewFile, out.preview)) changed.push(`layouts/${LAYOUT}.svg`);
  if (!sameFile(keysFile, out.keys)) changed.push("keys.json");
  if (flag("--check")) {
    say({ ok: true, changed, warnings: out.stamp.warnings, cockpit: out.stamp.cockpit, check: true });
    process.exit(changed.length ? 2 : 0);
  }
  // In this order; each one is replaced whole, and `written` says which ones were if a later one fails.
  const writes = [
    [`mods/${FORK}/`, () => writeFork(out.fork)],
    [`layouts/${LAYOUT}.svg`, () => atomicWrite(previewFile, out.preview)],
    [`layouts/${LAYOUT}.json`, () => atomicWrite(layoutFile, out.layout)],
    ["keys.json", () => atomicWrite(keysFile, out.keys)],
  ];
  const written = [];
  try {
    for (const [label, write] of writes) {
      if (!changed.includes(label)) continue;
      write();
      written.push(label);
    }
  } catch (e) {
    say({ ok: false, phase: "write", written, error: `writing failed: ${e.message}` });
    process.exit(1);
  }
  say({ ok: true, changed, warnings: out.stamp.warnings, cockpit: out.stamp.cockpit, rewrites: out.totals });
}

main();
