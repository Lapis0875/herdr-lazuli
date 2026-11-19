#!/usr/bin/env node
// lazuli's Chrome broker (DESIGN B8, ARCHITECTURE §5): one shared headless Chrome for every HTML
// viewer. Started detached by the first viewer that finds none; holds the broker lock (an exclusive
// flock on ~/.cache/lazuli/broker.lock, lib/chrome.mjs) for its whole life and publishes
// ~/.cache/lazuli/chrome.json (0600):
//   {version:1, brokerPid, chromePid, leasePort, token, cdpPort, browserWs, browser, startedAt}
// Each viewer holds a lease, one TCP connection to 127.0.0.1:leasePort (protocol in
// lib/chrome.mjs); the broker opens one Chrome tab per lease and closes it when the connection
// ends. A Chrome crash is announced (chrome-exit), Chrome is started once more and every lease gets
// a new tab (chrome-ready); a second crash within a minute of that restart ends the broker.
// It exits `--idle` seconds (default 300) after the last lease closes.
//   node chrome-broker.mjs [--idle <seconds>]
// Exit codes: 0 done (or another broker holds the lock), 1 Chrome failed, 3 no browser installed.

import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, readlink, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { connectCdp } from "./lib/cdp.mjs";
import { chromePaths, dropLock, findBrowser, pidAlive, readJson, takeLock, validDiscovery, writePrivateJson } from "./lib/chrome.mjs";

// Without --force-device-scale-factor, headless screencast frames come at CSS pixels whatever
// deviceScaleFactor a page emulates (a 1170×797 viewport at 2× gave 1170×797 PNGs); with it, frames
// follow each page's emulated factor (2340×1594 at 2×, 1× pages stay 1×).
const FLAGS = ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=2"];
const RESTART_WINDOW_MS = 60000;
const PORT_WAIT_MS = 30000;
const HELLO_WAIT_MS = 5000;

const idleAt = process.argv.indexOf("--idle");
const idleSec = idleAt >= 0 ? Number(process.argv[idleAt + 1]) : 300;
const IDLE_MS = (Number.isFinite(idleSec) && idleSec > 0 ? idleSec : 300) * 1000;
const P = chromePaths();
const LOG = path.join(P.dir, "broker.log");
const STARTED_AT = Date.now();
const TOKEN = randomBytes(24).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let server = null;
let leasePort = 0;
let chrome = null; // {proc, pid, port, browserWs, cdp}
let up = () => {};
let ready = null; // pending while Chrome is starting; resolved once `chrome` is set
function expectChrome() {
  ready = new Promise((r) => (up = r));
}
expectChrome();
let restartedAt = 0;
let stopping = false;
let idleTimer = null;
const leases = new Set(); // {sock, fid, pid, targetId, ready, needsTab}

function log(msg) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {}
}

const send = (L, m) => {
  if (!L.sock.destroyed) L.sock.write(JSON.stringify(m) + "\n");
};

function tokenOk(t) {
  if (typeof t !== "string" || t.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

// ---- Chrome ----

// A Chrome left running on our profile by a broker that died without cleaning up is stopped, so
// the new one does not hand its start over to it. One whose broker is alive (one from before the
// flock lock, which does not hold it) stops this one instead.
async function reclaimProfile() {
  let link;
  try {
    link = await readlink(path.join(P.profile, "SingletonLock"));
  } catch {
    return;
  }
  const pid = Number(/-(\d+)$/.exec(link)?.[1]);
  if (!pidAlive(pid)) return;
  const d = validDiscovery(await readJson(P.discovery));
  if (d && d.chromePid === pid && d.brokerPid !== process.pid && pidAlive(d.brokerPid)) throw new Error("profile in use by another broker");
  const cmd = await new Promise((r) => execFile("ps", ["-o", "command=", "-p", String(pid)], (e, so) => r(e ? "" : String(so))));
  if (!cmd.includes(P.profile)) return;
  log(`stopping orphan chrome ${pid}`);
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 30 && pidAlive(pid); i++) await sleep(100);
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(100);
  }
}

// Starts Chrome, waits for its DevTools port, publishes the discovery file, then resolves `ready`.
async function launch() {
  await reclaimProfile();
  await mkdir(P.profile, { recursive: true, mode: 0o700 });
  const portFile = path.join(P.profile, "DevToolsActivePort");
  await rm(portFile, { force: true });
  const out = await open(P.log, "w", 0o600);
  let proc;
  try {
    proc = spawn(browser.path, [...FLAGS, `--user-data-dir=${P.profile}`, "about:blank"], { stdio: ["ignore", "ignore", out.fd] });
  } finally {
    await out.close();
  }
  const exited = new Promise((r) => {
    proc.once("exit", (code, signal) => r({ code, signal }));
    proc.once("error", (e) => r({ code: null, signal: null, error: String(e?.message ?? e) }));
  });
  const deadline = Date.now() + PORT_WAIT_MS;
  let port = 0, wsPath = "";
  for (;;) {
    const early = await Promise.race([exited, sleep(50).then(() => null)]);
    if (early) throw new Error(`chrome exited before its DevTools port: ${early.error ?? early.code ?? early.signal}`);
    try {
      const [p, w] = (await readFile(portFile, "utf8")).split("\n");
      if (Number(p) > 0 && w?.startsWith("/devtools/browser/")) {
        port = Number(p);
        wsPath = w.trim();
        break;
      }
    } catch {}
    if (Date.now() > deadline) {
      try { proc.kill("SIGKILL"); } catch {}
      throw new Error("chrome did not open its DevTools port");
    }
  }
  const browserWs = `ws://127.0.0.1:${port}${wsPath}`;
  let cdp;
  try {
    cdp = await connectCdp(browserWs);
  } catch (e) {
    try { proc.kill("SIGKILL"); } catch {}
    throw e;
  }
  const c = { proc, pid: proc.pid, port, browserWs, cdp };
  chrome = c;
  exited.then((r) => onChromeExit(c, r));
  await writePrivateJson(P.discovery, {
    version: 1, brokerPid: process.pid, chromePid: c.pid, leasePort, token: TOKEN,
    cdpPort: port, browserWs, browser: browser.name, startedAt: STARTED_AT,
  });
  log(`chrome ${c.pid} up on ${port}`);
  up();
}

function onChromeExit(c, r) {
  if (stopping || chrome !== c) return;
  chrome = null;
  expectChrome();
  c.cdp.close();
  const code = r.code ?? r.signal ?? null;
  log(`chrome ${c.pid} exited: ${code}`);
  for (const L of leases) {
    L.needsTab = L.ready;
    L.targetId = null;
    send(L, { event: "chrome-exit", code });
  }
  if (restartedAt && Date.now() - restartedAt < RESTART_WINDOW_MS) {
    log("chrome crashed again soon after a restart; stopping");
    shutdown(1);
    return;
  }
  restartedAt = Date.now();
  relaunch();
}

async function relaunch() {
  try {
    await launch();
  } catch (e) {
    log(`restart failed: ${e?.message ?? e}`);
    shutdown(1);
    return;
  }
  for (const L of [...leases]) {
    if (!L.needsTab) continue;
    L.needsTab = false;
    const targetId = await tabFor(L);
    if (!targetId) {
      L.sock.destroy();
      continue;
    }
    L.targetId = targetId;
    send(L, { event: "chrome-ready", browserWs: chrome.browserWs, targetId });
  }
}

async function openTab() {
  return (await chrome.cdp.call("Target.createTarget", { url: "about:blank", newWindow: true })).targetId;
}

function closeTab(targetId) {
  chrome?.cdp.call("Target.closeTarget", { targetId }).catch(() => {});
}

// A new tab for a lease once Chrome is up; null when the lease ended or Chrome keeps failing.
async function tabFor(L) {
  for (let i = 0; i < 3 && !stopping; i++) {
    while (!chrome && !stopping) await ready;
    if (stopping || L.sock.destroyed) return null;
    try {
      const id = await openTab();
      if (L.sock.destroyed) {
        closeTab(id);
        return null;
      }
      return id;
    } catch {
      await sleep(200);
    }
  }
  return null;
}

async function stopChrome(c) {
  const gone = new Promise((r) => {
    if (c.proc.exitCode !== null || c.proc.signalCode !== null) r();
    else c.proc.once("exit", () => r());
  });
  const within = (ms) => Promise.race([gone.then(() => true), sleep(ms).then(() => false)]);
  try { await c.cdp.call("Browser.close", {}, null, { timeoutMs: 2000 }); } catch {}
  c.cdp.close();
  if (await within(3000)) return;
  try { c.proc.kill("SIGTERM"); } catch {}
  if (await within(3000)) return;
  try { c.proc.kill("SIGKILL"); } catch {}
  await within(2000);
}

// ---- leases ----

function armIdle() {
  if (stopping || leases.size || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!leases.size) {
      log("idle; stopping");
      shutdown(0);
    }
  }, IDLE_MS);
}

function disarmIdle() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

function onConnection(sock) {
  const L = { sock, fid: "", pid: null, targetId: null, ready: false, needsTab: false, authed: false };
  sock.setNoDelay(true);
  const helloTimer = setTimeout(() => sock.destroy(), HELLO_WAIT_MS);
  const decoder = new StringDecoder("utf8");
  let buf = "";
  sock.on("data", (chunk) => {
    buf += decoder.write(chunk);
    if (buf.length > 65536) {
      sock.destroy();
      return;
    }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m && typeof m === "object") onMessage(L, m, helloTimer);
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    clearTimeout(helloTimer);
    if (!leases.delete(L)) return;
    if (L.targetId && !stopping) closeTab(L.targetId);
    L.targetId = null;
    armIdle();
  });
}

async function onMessage(L, m, helloTimer) {
  if (L.authed) {
    if (m.op === "ping") send(L, { ok: true });
    return;
  }
  clearTimeout(helloTimer);
  if (m.op !== "hello" || !tokenOk(m.token)) {
    send(L, { ok: false, error: "auth" });
    L.sock.end();
    return;
  }
  L.authed = true;
  L.fid = String(m.fid ?? "");
  L.pid = Number.isInteger(m.pid) ? m.pid : null;
  leases.add(L);
  disarmIdle();
  const targetId = await tabFor(L);
  if (!targetId || !chrome) {
    if (!L.sock.destroyed) {
      send(L, { ok: false, error: "chrome" });
      L.sock.end();
    }
    return;
  }
  L.targetId = targetId;
  L.ready = true;
  send(L, { ok: true, browserWs: chrome.browserWs, cdpPort: chrome.port, targetId });
}

// ---- life ----

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  disarmIdle();
  for (const L of leases) L.sock.destroy();
  server?.close();
  const c = chrome;
  chrome = null;
  if (c) await stopChrome(c);
  const d = await readJson(P.discovery);
  if (d?.brokerPid === process.pid) await rm(P.discovery, { force: true });
  dropLock();
  log(`stopped (${code})`);
  process.exit(code);
}

async function main() {
  if (!takeLock(P)) process.exit(0);
  try { writeFileSync(LOG, "", { mode: 0o600 }); } catch {}
  browser = findBrowser();
  if (!browser) {
    log("no browser installed");
    dropLock();
    process.exit(3);
  }
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(0));
  process.on("uncaughtException", (e) => {
    log(`uncaught: ${e?.stack ?? e}`);
    shutdown(1);
  });
  process.on("unhandledRejection", (e) => log(`unhandled: ${e?.stack ?? e}`));
  server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  leasePort = server.address().port;
  log(`broker ${process.pid} on lease port ${leasePort}, ${browser.name}`);
  try {
    await launch();
  } catch (e) {
    log(`chrome failed: ${e?.message ?? e}`);
    await shutdown(1);
    return;
  }
  armIdle();
}

main();
