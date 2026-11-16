// What the always-shown status bar runs for the call tree: the scan behind the small per-root counts every copy
// reads for a 추정 root (Home's stage, the badge), a toast when a subagent's live record turns failed or aborted (its
// click opens the tree on it), the activity button's badge, the `lstack-herdr-cockpit.tree:*` and
// `.sync` commands, and the toast offering a sync when cockpit was updated.

import { run, notify, shared, setShared, exec, appHome, readTextFile } from "herdr";
import { FORK, KEYS, refresh, liveFailures, reveal, spaceCounts, find, setRunIndex, setOpenCall } from "./lh-tree-data.js";
import { openTreeWindow, closeTreeWindow } from "./lh-tree-view.js";
import { openTranscript } from "./lh-ui.js";

const SYNC = () => `${appHome()}/mods/lstack-herdr/sync.mjs`;
const SYNC_TOASTED = "lstack-herdr.sync.toasted";
// The build this Herdr session last announced (persisted in shared.json). A sync that changes the fork reloads every
// copy, which ends the copy that ran it before it can report, so the reloaded watcher announces the new build instead.
const BUILD_SEEN = "lstack-herdr.sync.build";

/** Starts the watcher in the status bar's copy (one per layout, always alive). */
export function lhWatch(cx) {
  refresh(cx, { force: true, publish: true });
  cx.timer.every(3000, (cx) => {
    refresh(cx, { publish: true });
    toastFailures();
  });
  checkVersion(cx);
  cx.timer.every(60000, (cx) => checkVersion(cx));
}

function toastFailures() {
  const notified = new Set(shared(KEYS.notified) ?? []);
  const fresh = liveFailures().filter((n) => !notified.has(n.key));
  if (!fresh.length) return;
  for (const n of fresh) {
    notified.add(n.key);
    notify({
      title: `하위 에이전트 ${n.status === "aborted" ? "중단" : "실패"}: ${n.name}`,
      body: [n.type, n.task].filter(Boolean).join(" · "),
      level: "error",
      timeout: 10000,
      action: { name: `${FORK}.tree:open:${n.root}:${n.id}` },
    });
  }
  setShared(KEYS.notified, [...notified].slice(-200));
}

/** The activity button's badge: unseen failures in red, else the space's running subagents. */
export function lhTreeBadge() {
  const c = spaceCounts();
  if (c.unseen) return { count: c.unseen, tone: "destructive" };
  if (c.running) return { count: c.running, tone: "working" };
  return null;
}

/** Shows the tree tab on a node: the work view, the panel open on the tree, the node unfolded and selected. */
export function openTreeOn(root, id) {
  if (root) reveal(root, id ?? "");
  run("layout.select", { stack: "center", child: "work" });
  setShared(`${FORK}.app`, "work");
  run("layout.select", { stack: "panel-body", child: "tree" });
  run("layout.show", { id: "panel" });
}

/**
 * `lstack-herdr-cockpit.tree:open:<root>:<id>` (the tab on a node), `.tree:view:<list|run>`, `.tree:window`
 * (창으로 크게 보기; `.tree:window:close`), `.tree:run:<root>:<index|latest>` (the 실행 view's ‹ ›), `.tree:call:<root>:<run>:<card>:<row>`
 * and `.tree:call:close` (a call opened under its row), `.tree:log:<root>:<id>` (기록 열기) and `.sync`; palette,
 * keys and `herdr-app do` reach them. True when it was one of these.
 */
export function lhCommand(c, cx) {
  if (c === "sync") {
    runSync(cx);
    return true;
  }
  if (c.startsWith("tree:open:")) {
    const rest = c.slice("tree:open:".length);
    const at = rest.indexOf(":");
    if (at < 0) openTreeOn(rest, "");
    else openTreeOn(rest.slice(0, at), rest.slice(at + 1));
    return true;
  }
  if (c.startsWith("tree:view:")) {
    setShared(KEYS.view, c.endsWith(":run") ? "run" : "list");
    openTreeOn(null, null);
    return true;
  }
  if (c.startsWith("tree:run:")) {
    const [root, index] = c.slice("tree:run:".length).split(":");
    if (root) setRunIndex(root, /^\d+$/.test(index ?? "") ? Number(index) : null);
    return true;
  }
  if (c === "tree:call:close") {
    setOpenCall(null);
    return true;
  }
  if (c.startsWith("tree:call:")) {
    const [root, run, card, ...row] = c.slice("tree:call:".length).split(":");
    if (root && /^\d+$/.test(run ?? "") && row.length) setOpenCall({ root, run: Number(run), card: card ?? "", row: row.join(":"), file: null });
    return true;
  }
  if (c === "tree:window") {
    openTreeWindow();
    return true;
  }
  if (c === "tree:window:close") {
    closeTreeWindow();
    return true;
  }
  if (c.startsWith("tree:log:")) {
    const rest = c.slice("tree:log:".length);
    const at = rest.indexOf(":");
    if (at > 0) openTranscript(find(rest.slice(0, at), rest.slice(at + 1)));
    return true;
  }
  return false;
}

async function versions() {
  const read = async (p) => {
    try {
      return JSON.parse((await readTextFile(p)) ?? "null");
    } catch {
      return null;
    }
  };
  const [install, stamp] = await Promise.all([read(`${appHome()}/cockpit.json`), read(`${appHome()}/mods/${FORK}/.lstack-sync.json`)]);
  const build = stamp?.upstream && stamp?.source ? `${stamp.upstream}:${stamp.source}` : null;
  return { upstream: install?.version ?? null, built: stamp?.cockpit ?? null, build, warnings: stamp?.warnings ?? [] };
}

function checkVersion(cx) {
  cx.spawn(async () => {
    const v = await versions();
    announceBuild(v);
    if (!v.upstream || v.upstream === v.built || shared(SYNC_TOASTED) === v.upstream) return;
    setShared(SYNC_TOASTED, v.upstream);
    notify({
      title: `cockpit ${v.upstream} updated · Sync`,
      body: `lstack-herdr는 cockpit ${v.built ?? "?"}에서 만들어졌습니다. 눌러서 새 cockpit으로 포크를 다시 만듭니다. 끝나면 Herdr를 재시작하세요.`,
      level: "info",
      timeout: 30000,
      action: { name: `${FORK}.sync` },
    });
  });
}

/**
 * Herdr's mod runtime never frees a block's module after a reload, so each rebuilt fork (≈25 MB per load) adds up
 * toward its memory limit until every mod fails; restarting Herdr releases it, and terminals keep running.
 */
function announceBuild(v) {
  if (!v.build) return;
  const seen = shared(BUILD_SEEN);
  setShared(BUILD_SEEN, v.build);
  if (!seen || seen === v.build) return;
  notify({
    title: `lstack-herdr: cockpit ${v.built ?? ""}로 다시 만들었습니다`,
    body: ["메모리 누적을 막으려면 Herdr를 재시작하세요 (터미널은 유지됩니다).", ...v.warnings.map((w) => `주의: ${w}`)].join("\n"),
    level: v.warnings.length ? "warning" : "success",
    timeout: 30000,
  });
}

function runSync(cx) {
  notify({ title: "lstack-herdr: sync 중…", level: "info", timeout: 2500 });
  cx.spawn(async () => {
    let out;
    try {
      const r = await exec("node", [SYNC(), "--json"]);
      out = JSON.parse(r.stdout || "{}");
      if (!out.ok && !out.error) out.error = r.stderr || `sync exited ${r.code}`;
    } catch (e) {
      out = { ok: false, error: String(e?.message ?? e) };
    }
    if (!out.ok && out.phase === "write")
      notify({
        title: "lstack-herdr sync 실패 · 일부만 바뀜, Sync를 다시 실행하세요",
        body: `이미 바뀐 것: ${out.written?.length ? out.written.join(", ") : "없음"}\n${out.error}`,
        level: "error",
        timeout: 30000,
      });
    else if (!out.ok) notify({ title: "lstack-herdr sync 실패 · 이전 포크 유지", body: out.error, level: "error", timeout: 30000 });
    else if (!out.changed?.length)
      notify({
        title: "lstack-herdr: 이미 최신입니다",
        body: (out.warnings ?? []).map((w) => `주의: ${w}`).join("\n") || undefined,
        level: out.warnings?.length ? "warning" : "success",
        timeout: out.warnings?.length ? 30000 : 5000,
      });
  });
}
