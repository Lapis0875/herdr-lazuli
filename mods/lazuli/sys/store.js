// The data every lazuli copy shares: a module-level map (module code runs once per source version and
// is shared by every copy, F3), a snapshot per store under data/lazuli/snap/, and the settings file
// (ARCHITECTURE §2). Views re-render through shared("lazuli.rev"), which every change bumps.

import * as fs from "fs/promises";
import { appHome, checking, exec, readTextFile, writeTextFile, shared, setShared } from "herdr";
import { KEY, STORE_NAME, normalizeSettings } from "./state.js";
import { onLanguageChange, resolveLanguage, setLanguage } from "../core/i18n.js";

const log = (msg) => console.log(`[lazuli/store] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Paths under the app home.

/** `<app home>/data/lazuli`. */
export const dataDir = () => `${appHome()}/data/lazuli`;
/** `<app home>/data/lazuli/snap`. */
export const snapDir = () => `${dataDir()}/snap`;
/** `<app home>/data/lazuli/settings.json`. */
export const settingsPath = () => `${dataDir()}/settings.json`;

function checkName(name) {
  if (typeof name !== "string" || !STORE_NAME.test(name)) throw new TypeError(`lazuli store: bad name ${JSON.stringify(name)}`);
}

/** `<app home>/data/lazuli/snap/<name>.json`. */
export function snapPath(name) {
  checkName(name);
  return `${snapDir()}/${name}.json`;
}

// Atomic replacement, so a relay device never reads half a snapshot and an interrupted write never
// truncates the last good one. writeTextFile replaces a file atomically when it still holds the
// expected text; `known` is the text this module last read or wrote.
const known = new Map();

async function writeReplacing(path, text) {
  for (let tries = 0; tries < 2; tries++) {
    let expected = known.get(path);
    if (expected === undefined) {
      try {
        expected = await readTextFile(path);
      } catch {
        break;
      }
    }
    try {
      await writeTextFile(path, text, expected);
      known.set(path, text);
      return;
    } catch {
      known.delete(path);
    }
  }
  // Too large for readTextFile, or replaced underneath twice: staged, and the latest write wins.
  await writeStaged(path, text);
  known.set(path, text);
}

// The whole text goes to a temp file beside `path` (same folder, so the rename is atomic), then
// `mv -f` renames it over `path` (fs/promises has no rename). On any failure `path` keeps what it
// had, the temp file is removed, and the error is thrown.
async function writeStaged(path, text) {
  const tmp = `${path}.part-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(tmp, text);
    const r = await exec("mv", ["-f", tmp, path], { timeout: 10000 });
    if (r.code !== 0) throw new Error(`mv exited ${r.code}: ${(r.stderr ?? "").trim()}`);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// The store.

const values = new Map();
const times = new Map();
const subscribers = new Map();
const loads = new Map();
const writes = new Map();

/** The value of a store, or undefined before anything set or loaded it. */
export function get(name) {
  return values.get(name);
}

/** Whether a store has a value. */
export function has(name) {
  return values.has(name);
}

/** When the store's value was made (ms), from set() or from its snapshot; null when it has none. */
export function updatedAt(name) {
  return times.get(name) ?? null;
}

/** The store's change counter: how many times it changed (persisted in shared state). */
export function rev(name) {
  const r = shared(KEY.rev);
  return isPlain(r) && typeof r[name] === "number" ? r[name] : 0;
}

/** Bumps the store's change counter, which re-renders every copy. */
export function bump(name) {
  const r = shared(KEY.rev);
  const base = isPlain(r) ? r : {};
  setShared(KEY.rev, { ...base, [name]: (typeof base[name] === "number" ? base[name] : 0) + 1 });
}

function notify(name, value) {
  for (const fn of [...(subscribers.get(name) ?? [])]) {
    try {
      fn(value, name);
    } catch (e) {
      log(`subscriber of ${name} failed: ${errText(e)}`);
    }
  }
}

/** Sets a store's value: subscribers run, every copy re-renders, and (unless `snapshot: false`) its
 *  snapshot file is rewritten in the background. Returns the value. Never call it from render(). */
export function set(name, value, { snapshot = true } = {}) {
  checkName(name);
  values.set(name, value);
  times.set(name, Date.now());
  notify(name, value);
  bump(name);
  if (snapshot) writeSnapshot(name);
  return value;
}

/** `set(name, change(get(name)), options)`. */
export function update(name, change, options) {
  return set(name, change(values.get(name)), options);
}

/** Calls `fn(value, name)` after each set() or load of that store. Returns a function that stops it.
 *  It runs in whatever context set the value: never keep a cx for it. */
export function subscribe(name, fn) {
  checkName(name);
  let fns = subscribers.get(name);
  if (!fns) subscribers.set(name, (fns = new Set()));
  fns.add(fn);
  return () => fns.delete(fn);
}

/** Warm start: a store without a value takes its snapshot's (if any), then every copy re-renders.
 *  Resolves with the store's value (undefined when there is neither). */
export function load(name) {
  checkName(name);
  if (values.has(name)) return Promise.resolve(values.get(name));
  let pending = loads.get(name);
  if (!pending) {
    pending = readSnapshot(name)
      .then((snap) => {
        if (snap && !values.has(name)) {
          values.set(name, snap.value);
          times.set(name, typeof snap.at === "number" ? snap.at : null);
          notify(name, snap.value);
          bump(name);
        }
        return values.get(name);
      })
      .finally(() => loads.delete(name));
    loads.set(name, pending);
  }
  return pending;
}

async function readSnapshot(name) {
  const path = snapPath(name);
  let text;
  try {
    // fs/promises has no 1 MiB cap (readTextFile has), so snapshots of any size written by
    // writeReplacing() load back; a missing file reads as null.
    text = (await fs.exists(path)) ? await fs.readFile(path, "utf8") : null;
  } catch (e) {
    log(`snapshot ${name} not read: ${errText(e)}`);
    return null;
  }
  if (text == null) return null;
  known.set(path, text);
  try {
    const snap = JSON.parse(text);
    return isPlain(snap) && "value" in snap ? snap : null;
  } catch {
    log(`snapshot ${name} is not JSON`);
    return null;
  }
}

// One write per store at a time; changes made meanwhile are written once it ends.
function writeSnapshot(name) {
  if (checking()) return;
  const running = writes.get(name);
  if (running) {
    running.again = true;
    return;
  }
  const job = { again: false };
  writes.set(name, job);
  (async () => {
    try {
      await fs.mkdir(snapDir(), { recursive: true });
      do {
        job.again = false;
        const snap = { version: 1, name, at: times.get(name) ?? Date.now(), value: values.get(name) };
        await writeReplacing(snapPath(name), JSON.stringify(snap));
      } while (job.again);
    } catch (e) {
      log(`snapshot ${name} not written: ${errText(e)}`);
    } finally {
      writes.delete(name);
    }
  })();
}

// Settings.

let lastRaw;
let lastSettings = null;

/** The live settings (shared("lazuli.settings")), complete and normalized. Safe in render(). */
export function settings() {
  const raw = shared(KEY.settings);
  if (!lastSettings || raw !== lastRaw) {
    lastRaw = raw;
    lastSettings = normalizeSettings(raw);
  }
  return lastSettings;
}

// Debug log: off unless settings.json has `"debug": true`. Keeps the last DEBUG_LINES lines in
// data/lazuli/debug.log (rewritten whole; fs/promises has no append), for diagnosing live-window
// behavior that console.log does not surface.
const DEBUG_LINES = 2000;
const debugLines = [];
let debugWrite = null;
let debugAgain = false;

/** Records one line when debugging is on. Safe anywhere outside `herdr-app check`. */
export function debugLog(area, msg) {
  if (checking() || settings().debug !== true) return;
  debugLines.push(`${new Date().toISOString()} [${area}] ${msg}`);
  if (debugLines.length > DEBUG_LINES) debugLines.splice(0, debugLines.length - DEBUG_LINES);
  if (debugWrite) {
    debugAgain = true;
    return;
  }
  const flush = () => {
    debugAgain = false;
    debugWrite = fs
      .writeFile(`${dataDir()}/debug.log`, `${debugLines.join("\n")}\n`)
      .catch(() => {})
      .then(() => {
        debugWrite = null;
        if (debugAgain) flush();
      });
  };
  flush();
}

let systemLanguage = null;
let askingSystem = null;

/** What "system" resolved to on this start ("ko" | "en"), or null before it is known. */
export function resolvedSystemLanguage() {
  return systemLanguage;
}

// The language listener keeps shared("lazuli.language") current: setting it re-renders every copy,
// and the next start uses it before the system language is known again.
onLanguageChange((lang) => {
  if (shared(KEY.language) !== lang) setShared(KEY.language, lang);
});

function applyLanguage(value) {
  if (value.language !== "system") {
    setLanguage(value.language);
    return;
  }
  if (systemLanguage) {
    setLanguage(systemLanguage);
    return;
  }
  const warm = shared(KEY.language);
  if (warm === "ko" || warm === "en") setLanguage(warm);
  if (!askingSystem) askingSystem = askSystemLanguage();
}

// "system" resolves once per start (ARCHITECTURE §2).
async function askSystemLanguage() {
  let output = null;
  if (!checking()) {
    try {
      output = (await exec("defaults", ["read", "-g", "AppleLanguages"], { timeout: 5000 })).stdout;
    } catch (e) {
      log(`system language not read: ${errText(e)}`);
    }
  }
  systemLanguage = resolveLanguage("system", output);
  if (settings().language === "system") setLanguage(systemLanguage);
}

function publishSettings(value) {
  if (JSON.stringify(value) !== JSON.stringify(shared(KEY.settings))) setShared(KEY.settings, value);
  applyLanguage(value);
  return value;
}

async function readSettingsFile() {
  const text = await readTextFile(settingsPath());
  if (text == null) return normalizeSettings(null);
  try {
    return normalizeSettings(JSON.parse(text));
  } catch (e) {
    log(`settings.json is not JSON, keeping the live settings: ${errText(e)}`);
    return settings();
  }
}

let loading = null;

/** Reads settings.json once per source version (defaults when absent), publishes it as the live copy
 *  and applies its language. Every copy calls it in init; later calls return the same promise. */
export function loadSettings() {
  if (!loading) {
    applyLanguage(settings());
    loading = readSettingsFile()
      .then(publishSettings)
      .catch((e) => {
        log(`settings not loaded: ${errText(e)}`);
        return settings();
      });
  }
  return loading;
}

let saving = Promise.resolve();

/** Changes the settings: `change(draft)` edits the draft (a normalized copy of what is on disk) or
 *  returns a replacement object. The result is written to settings.json (a concurrent write makes it
 *  read and apply again), published as the live copy, and its language applied. Changes run one at a
 *  time. Resolves with the new settings. */
export function updateSettings(change) {
  const next = saving.catch(() => {}).then(() => writeSettings(change));
  saving = next;
  return next;
}

function edited(base, change) {
  const draft = normalizeSettings(base);
  const out = change(draft);
  return normalizeSettings(isPlain(out) ? out : draft);
}

async function writeSettings(change) {
  if (checking()) return publishSettings(edited(settings(), change));
  const path = settingsPath();
  await fs.mkdir(dataDir(), { recursive: true });
  for (let tries = 0; ; tries++) {
    const text = await readTextFile(path);
    let base = null;
    if (text != null) {
      try {
        base = JSON.parse(text);
      } catch {
        // A hand-broken file is kept aside, and the edit starts from the live settings.
        if (tries === 0) await fs.writeFile(`${path}.corrupt-${Date.now()}`, text);
        base = settings();
      }
    }
    const value = edited(base, change);
    try {
      await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`, text);
      return publishSettings(value);
    } catch (e) {
      if (tries >= 2) throw e;
    }
  }
}
