// Shared Chrome plumbing for the HTML viewer and the Chrome broker (DESIGN B8, ARCHITECTURE §5):
// the browser lookup (Google Chrome → Chromium → Microsoft Edge → Brave), the cache paths
// (`~/.cache/lazuli`, or LAZULI_CACHE_DIR), the discovery file, the broker lock, and the viewer's
// side of the lease protocol (one JSON object per line over TCP 127.0.0.1:leasePort):
//   viewer → broker  {op:"hello", token, fid, pid}      broker → viewer  {ok:true, browserWs, cdpPort, targetId}
//   either way       {op:"ping"} → {ok:true}            refused          {ok:false, error:"auth"|"chrome"}
//   broker → viewer  {event:"chrome-exit", code}        {event:"chrome-ready", browserWs, targetId}
// The open connection is the lease: the broker opened one Chrome tab (`targetId`) for it and closes
// that tab when the connection ends.
// The broker lock is an exclusive flock(2) on `broker.lock`, held by the broker's open file for its
// whole life: the system drops it when the broker ends however it ends, so nothing ever judges or
// removes a stale lock, and the file itself is never deleted (a deleted lock file could be locked
// again under the same name by a second process).

import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, ftruncateSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Browsers in lookup order: the macOS app binary, then commands on PATH. */
export const BROWSERS = Object.freeze([
  { name: "Google Chrome", app: "Google Chrome.app/Contents/MacOS/Google Chrome", commands: ["google-chrome", "google-chrome-stable"] },
  { name: "Chromium", app: "Chromium.app/Contents/MacOS/Chromium", commands: ["chromium", "chromium-browser"] },
  { name: "Microsoft Edge", app: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge", commands: ["microsoft-edge", "microsoft-edge-stable"] },
  { name: "Brave", app: "Brave Browser.app/Contents/MacOS/Brave Browser", commands: ["brave-browser", "brave"] },
]);

// macOS open(2) O_EXLOCK: the open takes an exclusive flock(2) lock (with O_NONBLOCK, or fails EAGAIN).
const O_EXLOCK = 0x20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function executable(p) {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The first installed browser as `{name, path}`, else null. LAZULI_BROWSER, when set, is the only candidate. */
export function findBrowser(env = process.env) {
  if (env.LAZULI_BROWSER) return executable(env.LAZULI_BROWSER) ? { name: path.basename(env.LAZULI_BROWSER), path: env.LAZULI_BROWSER } : null;
  const home = env.HOME || os.homedir();
  const dirs = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const b of BROWSERS) {
    for (const apps of ["/Applications", path.join(home, "Applications")]) {
      const p = path.join(apps, b.app);
      if (executable(p)) return { name: b.name, path: p };
    }
    for (const c of b.commands) {
      for (const d of dirs) {
        const p = path.join(d, c);
        if (executable(p)) return { name: b.name, path: p };
      }
    }
  }
  return null;
}

/** lazuli's cache folder. */
export function cacheDir(env = process.env) {
  return env.LAZULI_CACHE_DIR || path.join(env.HOME || os.homedir(), ".cache", "lazuli");
}

/** The broker's files under `dir`. */
export function chromePaths(dir = cacheDir()) {
  return {
    dir,
    discovery: path.join(dir, "chrome.json"),
    lock: path.join(dir, "broker.lock"),
    profile: path.join(dir, "chrome-profile"),
    log: path.join(dir, "chrome.log"),
  };
}

/** Whether a process with this pid exists. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** The parsed JSON file, or null. */
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Writes JSON readable by the owner only (0600), through a temp file and rename. */
export async function writePrivateJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

/** The discovery record when it has every field a viewer needs, else null. */
export function validDiscovery(d) {
  return d && d.version === 1 && Number.isInteger(d.brokerPid) && Number.isInteger(d.leasePort) && typeof d.token === "string" && d.token ? d : null;
}

/** Tries to take the broker lock without waiting. Returns the open fd holding it (the lock lasts
 *  while the fd is open, and at most as long as the process), or null when another process holds
 *  it. macOS takes it with the open itself (O_EXLOCK); elsewhere flock(1) locks the fd this process
 *  passes it, which this process's open file then keeps holding. */
export function tryLock(file) {
  const { O_RDWR, O_CREAT, O_NONBLOCK } = constants;
  if (process.platform === "darwin") {
    try {
      return openSync(file, O_RDWR | O_CREAT | O_NONBLOCK | O_EXLOCK, 0o600);
    } catch (e) {
      if (e.code === "EAGAIN" || e.code === "EWOULDBLOCK") return null;
      throw e;
    }
  }
  const fd = openSync(file, O_RDWR | O_CREAT, 0o600);
  const r = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
  if (r.status === 0) return fd;
  closeSync(fd);
  if (r.error) throw r.error;
  return null;
}

/** Whether a broker holds the lock now (a probe that takes and at once drops it when free). */
export function lockHeld(P) {
  const fd = tryLock(P.lock);
  if (fd === null) return true;
  closeSync(fd);
  return false;
}

let lockFd = null;

/** Takes the broker lock for this process and writes its pid into the file (for people reading
 *  it). False when another process holds it. */
export function takeLock(P) {
  mkdirSync(P.dir, { recursive: true, mode: 0o700 });
  const fd = tryLock(P.lock);
  if (fd === null) return false;
  lockFd = fd;
  ftruncateSync(fd, 0);
  writeSync(fd, String(process.pid), 0);
  return true;
}

/** Lets the broker lock go (the file stays). */
export function dropLock() {
  if (lockFd === null) return;
  closeSync(lockFd);
  lockFd = null;
}

const leaseError = (code) => Object.assign(new Error(code), { code });

function spawnBroker(brokerPath, dir) {
  const info = { pid: 0, exitCode: null };
  const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: "ignore", env: { ...process.env, LAZULI_CACHE_DIR: dir } });
  info.pid = child.pid ?? 0;
  child.once("exit", (code) => (info.exitCode = code ?? 1));
  child.once("error", () => (info.exitCode = 1));
  child.unref();
  return info;
}

/** Gets a lease from the running broker, starting one (detached) when no broker holds the lock.
 *  `onEvent(event, lease)` hears `{type:"chrome-exit", code}`, `{type:"chrome-ready", browserWs,
 *  targetId}` and `{type:"lost"}`. Rejects with `code` "no-browser", "chrome-failed",
 *  "lease-refused" or "broker-timeout". */
export async function acquireLease({ fid, brokerPath, dir = cacheDir(), timeoutMs = 25000, onEvent = () => {} }) {
  const P = chromePaths(dir);
  mkdirSync(P.dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let child = null;
  let failed = 0;
  while (Date.now() < deadline) {
    if (child?.exitCode === 3) throw leaseError("no-browser");
    // A discovery file left by a dead broker names a dead pid, or (reused) a port nobody answers on.
    const d = validDiscovery(await readJson(P.discovery));
    if (d && pidAlive(d.brokerPid)) {
      try {
        return await openLease(d, fid, onEvent);
      } catch (e) {
        if (e.code === "lease-refused") throw e;
      }
    }
    if (!lockHeld(P) && (!child || child.exitCode !== null)) {
      // No broker holds the lock: start one. Of brokers started at once, the one that takes it stays
      // and the others exit 0; three that fail to start Chrome (exit 1) end the wait.
      if (child?.exitCode) failed++;
      if (failed >= 3) throw leaseError("chrome-failed");
      child = spawnBroker(brokerPath, dir);
    }
    await sleep(150);
  }
  throw leaseError(child?.exitCode ? "chrome-failed" : "broker-timeout");
}

function openLease(d, fid, onEvent) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: d.leasePort });
    const decoder = new StringDecoder("utf8");
    let buf = "";
    let lease = null;
    let settled = false;
    // The broker answers once Chrome is up, which can take a restart.
    const timer = setTimeout(() => fail("lease-timeout"), 40000);
    function fail(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(leaseError(code));
    }
    sock.setNoDelay(true);
    sock.on("connect", () => sock.write(JSON.stringify({ op: "hello", token: d.token, fid, pid: process.pid }) + "\n"));
    sock.on("error", () => {});
    sock.on("close", () => {
      if (!lease) fail("lease-closed");
      else lease.ended();
    });
    sock.on("data", (chunk) => {
      buf += decoder.write(chunk);
      if (buf.length > 1 << 20) {
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
        if (!m || typeof m !== "object") continue;
        if (lease) {
          lease.message(m);
        } else if (m.ok === true && typeof m.browserWs === "string" && typeof m.targetId === "string") {
          settled = true;
          clearTimeout(timer);
          lease = new Lease(sock, m, onEvent);
          resolve(lease);
        } else if (m.ok === false) {
          fail(m.error === "auth" ? "lease-refused" : "chrome-failed");
        }
      }
    });
  });
}

class Lease {
  constructor(sock, ready, onEvent) {
    this.sock = sock;
    this.browserWs = ready.browserWs;
    this.cdpPort = ready.cdpPort;
    this.targetId = ready.targetId;
    this.onEvent = onEvent;
    this.closed = false;
    this.heard = Date.now();
    // A broker that stops answering for 45 s counts as gone.
    this.beat = setInterval(() => {
      if (Date.now() - this.heard > 45000) this.sock.destroy();
      else this.send({ op: "ping" });
    }, 15000);
  }

  send(m) {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(m) + "\n");
  }

  message(m) {
    this.heard = Date.now();
    if (m.op === "ping") this.send({ ok: true });
    else if (m.event === "chrome-exit") this.onEvent({ type: "chrome-exit", code: m.code ?? null }, this);
    else if (m.event === "chrome-ready" && typeof m.browserWs === "string" && typeof m.targetId === "string") {
      this.browserWs = m.browserWs;
      this.targetId = m.targetId;
      this.onEvent({ type: "chrome-ready", browserWs: m.browserWs, targetId: m.targetId }, this);
    }
  }

  ended() {
    clearInterval(this.beat);
    if (this.closed) return;
    this.closed = true;
    this.onEvent({ type: "lost" }, this);
  }

  /** Ends the lease; the broker closes its tab. */
  close() {
    this.closed = true;
    clearInterval(this.beat);
    this.sock.destroy();
  }
}
