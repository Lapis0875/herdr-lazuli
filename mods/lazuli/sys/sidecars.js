// The PDF renderer sidecar (DESIGN B9, ARCHITECTURE §5; spikes S4, S5):
// - build: when the layout starts, the `status` copy hashes bin/pdfd.swift and, if
//   ~/.cache/lazuli/bin/pdfd-<sha8> is missing, compiles it with `swiftc -O` in a task no view owns;
//   shared("lazuli.pdfd") = {state: "absent"|"building"|"ready"|"failed", bin, reason} follows it (`bin` is
//   the binary, the one wanted when failed). A failed build posts one toast (not again across starts for
//   the same failure of the same source) and names the fallback: pdftocairo when found, else "Open in Preview".
// - launch: only when a PDF opens. `hc run --bg --json --cwd ~ --label lazuli.sidecar=pdfd -- <bin> --cache
//   <H>/data/lazuli/cache/pdf --discovery ~/.cache/lazuli/pdfd-<sha8 of H>.json --idle 300`. A running daemon
//   is reused through this home's discovery file when it runs the same binary and renders into this home's
//   cache; any other is left alone and this home launches its own. Such a terminal has no parent and shows
//   nowhere; it stays as "finished" after the daemon exits until `hc rm`, which the reaper does.
//
// Reason codes (shared state `reason`): no-source, no-swiftc, timeout, compile, install. Connect error
// codes: checking, unavailable, launch-failed, launch-timeout.

import * as fs from "fs/promises";
import { createHash } from "crypto";
import { appHome, checking, exec, hc, home, notify, readTextFile, setShared, shared, terminals } from "herdr";
import { KEY } from "./state.js";
import { debugLog } from "./store.js";
import { t } from "../core/i18n.js";

export const LABEL = "lazuli.sidecar";
export const LABEL_VALUE = "pdfd";
export const IDLE_SEC = 300;
export const BUILD_TIMEOUT_MS = 600000;
export const STATES = Object.freeze(["absent", "building", "ready", "failed"]);
/** Catalog keys of the build-failure toast (area `filetab`). */
export const TOAST = Object.freeze({
  title: "filetab.pdf.build-failed",
  pdftocairo: "filetab.pdf.build-failed-cairo",
  preview: "filetab.pdf.build-failed-preview",
});

const LAUNCH_WAIT_MS = 10000;
const POLL_MS = 50;
const REAP_MS = 60000;
/** Other builds' binaries are kept this long: another Herdr home may still launch them. */
const KEEP_OLD_DAYS = 30;

/** Console and, with `"debug": true` in settings.json, data/lazuli/debug.log. */
const log = (msg) => {
  console.log(`[lazuli/sidecars] ${msg}`);
  debugLog("sidecars", msg);
};
const errText = (e) => e?.message ?? String(e);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const basename = (p) => String(p).slice(String(p).lastIndexOf("/") + 1);
const dirname = (p) => String(p).slice(0, Math.max(0, String(p).lastIndexOf("/"))) || "/";

/** Where pdfd's pieces live. The binary is shared by every app home; the discovery file is per app home
 *  (`pdfd-<first 8 hex of sha256(appHome)>.json`), since a daemon renders into one home's data folder. */
export function pdfdPaths() {
  const cache = `${home()}/.cache/lazuli`;
  const homeTag = String(createHash("sha256").update(appHome()).digest("hex")).slice(0, 8);
  return {
    src: `${appHome()}/mods/lazuli/bin/pdfd.swift`,
    binDir: `${cache}/bin`,
    discovery: `${cache}/pdfd-${homeTag}.json`,
    renders: `${appHome()}/data/lazuli/cache/pdf`,
  };
}

/** shared("lazuli.pdfd"), complete: `{state, bin, reason}`. Safe in render(). */
export function pdfdState() {
  const v = shared(KEY.pdfd);
  if (!isObj(v) || !STATES.includes(v.state)) return { state: "absent", bin: null, reason: null };
  return {
    state: v.state,
    bin: typeof v.bin === "string" && v.bin ? v.bin : null,
    reason: typeof v.reason === "string" && v.reason ? v.reason : null,
  };
}

function setState(next) {
  const cur = pdfdState();
  if (cur.state === next.state && cur.bin === next.bin && cur.reason === next.reason) return;
  setShared(KEY.pdfd, next);
}

// Build.

let build = null; // {promise, started}
let lastBuild = null; // the last finished build's result, this source version
let fallback; // undefined until looked for; then {kind: "pdftocairo", bin} | {kind: "preview"}
let toasted = false;

async function exists(path) {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}

async function removeQuietly(path) {
  try {
    await exec("rm", ["-f", path]);
  } catch {
    // Nothing to remove.
  }
}

/** The fallback renderer: `{kind: "pdftocairo", bin}` when pdftocairo is found (Homebrew's folders
 *  included), else `{kind: "preview"}` ("Open in Preview"). Looked for once per source version. */
export async function detectFallback() {
  if (fallback !== undefined) return fallback;
  let bin = "";
  try {
    const r = await exec("/bin/sh", ["-c", 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; command -v pdftocairo']);
    bin = r.code === 0 ? r.stdout.split("\n")[0].trim() : "";
  } catch (e) {
    log(`pdftocairo lookup failed: ${errText(e)}`);
  }
  fallback = bin.startsWith("/") ? { kind: "pdftocairo", bin } : { kind: "preview" };
  return fallback;
}

/** The fallback found so far, or null before detectFallback() ran. Safe in render(). */
export const pdfFallback = () => fallback ?? null;

function ready(bin) {
  const r = { state: "ready", bin, reason: null };
  setState(r);
  return r;
}

/** Records a failed build: `bin` names the binary that was wanted (null when the source is unreadable).
 *  The toast comes once per start, and not again when `before` (the state this build started from,
 *  persisted across starts) already held the same failure of the same source. */
async function failed(reason, detail, bin = null, before = null) {
  log(`pdfd build failed (${reason})${detail ? `: ${detail}` : ""}`);
  const fb = await detectFallback();
  const r = { state: "failed", bin, reason };
  setState(r);
  const repeat = before?.state === "failed" && before.reason === reason && before.bin === bin;
  if (!toasted && !repeat) {
    toasted = true;
    notify({ title: t(TOAST.title), body: t(TOAST[fb.kind]), level: "warning", timeout: 10000 });
  }
  return r;
}

async function runBuild() {
  const before = pdfdState();
  const p = pdfdPaths();
  let bytes;
  try {
    bytes = await fs.readFile(p.src);
  } catch (e) {
    return failed("no-source", errText(e), null, before);
  }
  const sha8 = String(createHash("sha256").update(bytes).digest("hex")).slice(0, 8);
  const bin = `${p.binDir}/pdfd-${sha8}`;
  const fail = (reason, detail) => failed(reason, detail, bin, before);
  if (await exists(bin)) return ready(bin);
  setState({ state: "building", bin, reason: null });
  try {
    const r = await exec("mkdir", ["-p", p.binDir]);
    if (r.code !== 0) return fail("install", r.stderr.trim());
  } catch (e) {
    return fail("install", errText(e));
  }
  // Built beside the target and renamed into place: a binary that exists is complete.
  const tmp = `${bin}.build-${Date.now()}`;
  const started = Date.now();
  let r;
  try {
    r = await exec("swiftc", ["-O", p.src, "-o", tmp], { timeout: BUILD_TIMEOUT_MS });
  } catch (e) {
    await removeQuietly(tmp);
    return fail(Date.now() - started >= BUILD_TIMEOUT_MS - 1000 ? "timeout" : "no-swiftc", errText(e));
  }
  if (r.code !== 0) {
    await removeQuietly(tmp);
    const text = (r.stderr || r.stdout).trim();
    // Without Xcode's command line tools /usr/bin/swiftc is a stub that names xcrun's missing tools.
    const missing = /xcrun: error|invalid active developer path|no developer tools/i.test(text);
    return fail(missing ? "no-swiftc" : "compile", text.split("\n").slice(-5).join(" | "));
  }
  try {
    const mv = await exec("mv", ["-f", tmp, bin]);
    if (mv.code !== 0) return fail("install", mv.stderr.trim());
  } catch (e) {
    return fail("install", errText(e));
  }
  log(`built ${bin} in ${Math.round((Date.now() - started) / 1000)} s`);
  try {
    await exec("find", [p.binDir, "-maxdepth", "1", "-name", "pdfd-*", "!", "-name", basename(bin), "-mtime", `+${KEEP_OLD_DAYS}`, "-delete"]);
  } catch {
    // Old binaries stay.
  }
  return ready(bin);
}

/**
 * The renderer binary: `{state: "ready", bin}` or `{state: "failed", reason}`. Starts a build when none
 * ran in this source version, or when `recheck` (layout start: the source may have changed); otherwise
 * answers the last result. Concurrent callers share one build. The build runs in a task no view owns, so
 * closing the copy that asked does not stop it. Needs a live cx (init, a handler or a task).
 */
export function buildPdfd(cx, { recheck = false } = {}) {
  if (checking()) return Promise.resolve(pdfdState());
  if (build && Date.now() - build.started < BUILD_TIMEOUT_MS + 60000) return build.promise;
  if (!recheck && lastBuild) return Promise.resolve(lastBuild);
  const promise = new Promise((resolve) => {
    cx.spawn(
      async () => {
        let r;
        try {
          r = await runBuild();
        } catch (e) {
          r = await failed("install", errText(e));
        }
        lastBuild = r;
        if (build?.promise === promise) build = null;
        resolve(r);
      },
      { owner: null },
    );
  });
  build = { promise, started: Date.now() };
  return promise;
}

// Daemon.

let launching = null;

/** The discovery file: `{version, pid, port, token, startedAt, bin, cache}`, or null when absent or bad. */
export async function readDiscovery() {
  let text;
  try {
    text = await readTextFile(pdfdPaths().discovery);
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;
  try {
    const d = JSON.parse(text);
    const ok =
      isObj(d) &&
      Number.isInteger(d.port) && d.port > 0 && d.port < 65536 &&
      typeof d.token === "string" && d.token.length >= 16 &&
      Number.isInteger(d.pid) &&
      typeof d.startedAt === "number" &&
      typeof d.bin === "string" &&
      typeof d.cache === "string";
    return ok ? d : null;
  } catch {
    return null;
  }
}

/** A daemon this home may use: built from the same source (`pdfd-<sha8>` names one) and rendering into
 *  this home's cache (the `--cache` argument it was given, as launch() passes it). */
const usable = (d, bin) => basename(d.bin) === basename(bin) && d.cache === pdfdPaths().renders;

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return (await exec("/bin/kill", ["-0", String(pid)])).code === 0;
  } catch {
    return false;
  }
}

/** Removes every finished pdfd terminal (`hc rm`). A terminal whose process still runs is never
 *  removed, whatever state terminals() reports. Resolves with how many went. */
export async function reapPdfd() {
  if (checking()) return 0;
  let n = 0;
  for (const term of terminals() ?? []) {
    if (term?.labels?.[LABEL] !== LABEL_VALUE || term.state === "live") continue;
    if (await pidAlive(term.pid)) {
      log(`not removing ${term.address}: state ${term.state} but pid ${term.pid} runs`);
      continue;
    }
    try {
      const r = await hc(["rm", term.address]);
      if (r.code === 0) {
        n++;
        log(`removed finished pdfd terminal ${term.address} (state ${term.state})`);
      }
    } catch (e) {
      log(`hc rm ${term.address} failed: ${errText(e)}`);
    }
  }
  return n;
}

/** Stops the daemon a client found unresponsive: a fresh connection to it got no hello answer, so it
 *  would never idle out. Only called with such a `stale` discovery. */
async function stopHung(pid) {
  for (const term of terminals() ?? []) {
    if (term?.labels?.[LABEL] !== LABEL_VALUE || term.state !== "live" || term.pid !== pid) continue;
    log(`stopping unresponsive pdfd pid ${pid} (${term.address})`);
    try {
      await hc(["kill", term.address]);
      await hc(["rm", term.address]);
    } catch (e) {
      log(`stopping ${term.address} failed: ${errText(e)}`);
    }
  }
}

async function launch(cx, bin, stale) {
  const fresh = (d) => d && usable(d, bin) && (!stale || d.token !== stale.token);
  const before = await readDiscovery();
  if (fresh(before)) return before;
  if (!(await exists(bin))) {
    // Removed underneath (another home's cleanup): build again.
    const r = await buildPdfd(cx, { recheck: true });
    if (r.state !== "ready") return { error: "unavailable", reason: r.reason };
    bin = r.bin;
  }
  await reapPdfd();
  if (stale && Number.isInteger(stale.pid)) await stopHung(stale.pid);
  const p = pdfdPaths();
  try {
    await fs.mkdir(p.renders, { recursive: true });
  } catch (e) {
    log(`cannot create ${p.renders}: ${errText(e)}`);
  }
  const at = Date.now();
  let address = null;
  log(`launching ${bin}${stale ? ` (pid ${stale.pid} on port ${stale.port} did not answer)` : ""}`);
  try {
    const r = await hc([
      "run", "--bg", "--json", "--cwd", home(), "--label", `${LABEL}=${LABEL_VALUE}`, "--",
      bin, "--cache", p.renders, "--discovery", p.discovery, "--idle", String(IDLE_SEC),
    ]);
    if (r.code !== 0) {
      log(`hc run failed: ${(r.stderr || r.stdout).trim()}`);
      return { error: "launch-failed" };
    }
    for (const line of r.stdout.split("\n")) {
      try {
        const v = JSON.parse(line);
        if (isObj(v) && typeof v.address === "string") address = v.address;
      } catch {
        // Not the JSON line.
      }
    }
  } catch (e) {
    log(`hc run failed: ${errText(e)}`);
    return { error: "launch-failed" };
  }
  log(`hc run started pdfd as terminal ${address ?? "(no address in the answer)"}`);
  for (let waited = 0; waited < LAUNCH_WAIT_MS; waited += POLL_MS) {
    await cx.sleep(POLL_MS);
    const d = await readDiscovery();
    if (fresh(d) && d.startedAt >= at - 1000) {
      log(`pdfd pid ${d.pid} listens on port ${d.port} (${Date.now() - at} ms)`);
      return d;
    }
    const term = address ? (terminals() ?? []).find((x) => x?.address === address) : null;
    if (term && term.state !== "live" && !(await pidAlive(term.pid))) {
      log(`pdfd ${address} ended at start`);
      await reapPdfd();
      return { error: "launch-failed" };
    }
  }
  log(`pdfd ${address} wrote no discovery file in ${LAUNCH_WAIT_MS} ms`);
  return { error: "launch-timeout" };
}

/**
 * Where to reach the daemon: the discovery `{port, token, pid, …}`, or `{error}` (codes above;
 * `unavailable` carries the build `reason`). Waits for a build in progress. Reuses a running daemon of the
 * same binary; otherwise launches one, in a task no view owns, and waits up to 10 s for its discovery
 * file. Pass `stale` (that discovery) only when a fresh connection to its daemon got no hello answer:
 * that daemon is then stopped and replaced, unless another client replaced it already.
 */
export async function connectPdfd(cx, { stale = null } = {}) {
  if (checking()) return { error: "checking" };
  const built = await buildPdfd(cx);
  if (built.state !== "ready" || !built.bin) return { error: "unavailable", reason: built.reason ?? null };
  if (!stale) {
    const d = await readDiscovery();
    if (d && usable(d, built.bin)) {
      log(`reusing pdfd pid ${d.pid} on port ${d.port}`);
      return d;
    }
    log(d ? `pdfd pid ${d.pid} is another build or home (${basename(d.bin)}, ${d.cache}); launching ${basename(built.bin)}` : "no pdfd running; launching one");
  }
  if (!launching) {
    const bin = built.bin;
    launching = new Promise((resolve) => {
      cx.spawn(
        async (tcx) => {
          let r;
          try {
            r = await launch(tcx, bin, stale);
          } catch (e) {
            log(`launch failed: ${errText(e)}`);
            r = { error: "launch-failed" };
          }
          launching = null;
          resolve(r);
        },
        { owner: null },
      );
    });
  }
  return launching;
}

let reaper = null; // {task} while the reaper runs: one per source version

/**
 * Layout start, in the `status` copy: checks the source hash and builds when needed (a build in flight
 * is shared, not repeated), then removes finished daemon terminals now and every minute. The reaper is a
 * task no view owns, so it outlives the copy that started it; calling this again while it runs starts no
 * second one. Safe to call with a new cx after stopSidecars().
 */
export function startSidecars(cx) {
  if (checking()) return;
  buildPdfd(cx, { recheck: true });
  if (reaper) return;
  const mine = { task: null };
  reaper = mine;
  mine.task = cx.spawn(
    async (tcx) => {
      // tcx.sleep throws once this source version is replaced, which ends an old reaper.
      while (reaper === mine) {
        try {
          await reapPdfd();
        } catch (e) {
          log(`reap failed: ${errText(e)}`);
        }
        await tcx.sleep(REAP_MS);
      }
    },
    { owner: null },
  );
}

/** Layout gone (the `status` copy closes): stops the reaper so startSidecars() can start it again. A
 *  running daemon (it idles out by itself), a build in flight and a launch in flight are left alone. */
export function stopSidecars() {
  const r = reaper;
  reaper = null;
  r?.task?.cancel();
}

/** Opens a PDF in Preview (the last fallback, and for encrypted files). Resolves whether it opened. */
export async function openInPreview(file) {
  try {
    return (await exec("open", ["-a", "Preview", file])).code === 0;
  } catch {
    return false;
  }
}

/** pdftocairo's sibling poppler tool (`pdfinfo`, `pdftotext`) next to it. */
export const popplerTool = (cairoBin, name) => `${dirname(cairoBin)}/${name}`;
