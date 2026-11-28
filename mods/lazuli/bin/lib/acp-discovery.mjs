import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** An open file description owns this lock until process exit. Never unlink the lock inode. */
export function reserve(path) {
  const { O_CREAT, O_NOFOLLOW, O_NONBLOCK, O_RDWR } = constants;
  const O_EXLOCK = 0x20; // Darwin open(2) takes flock(2) atomically with open.
  const darwin = process.platform === "darwin";
  let fd;
  try {
    fd = openSync(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | (darwin ? O_EXLOCK : 0), 0o600);
  } catch (e) {
    if (darwin && (e.code === "EAGAIN" || e.code === "EWOULDBLOCK")) return null;
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("reservation is not a regular file");
    if (darwin) return fd;
    const r = spawnSync("flock", ["-n", "-E", "75", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    if (r.status === 0) return fd;
    if (r.status !== 75) throw r.error ?? new Error(`flock failed (${r.status ?? r.signal})`);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  closeSync(fd);
  return null;
}

/** ENOENT is the only absence result. Don't follow symlinks or block on a non-regular file. */
export function readDiscoveryFile(path) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  let fd;
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("discovery is not a regular file");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/** Identify exact receipts without exposing the token in a launch command. */
export const fingerprint = (text) => text === null ? "absent" : createHash("sha256").update(text).digest("hex");