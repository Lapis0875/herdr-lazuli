// The UI language an HTML viewer follows while it runs (DESIGN C3): the `language` of lazuli's
// settings.json, resolved as the mod resolves it (sys/state.js normalizeSettings, core/i18n.js
// resolveLanguage): "ko" and "en" as set; "system", or anything else, from macOS AppleLanguages.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLanguage } from "../../core/i18n.js";
import { watchFile } from "./source.mjs";

/** settings.json of the app home this file is installed in: `<app home>/mods/lazuli/bin/lib/` →
 *  `<app home>/data/lazuli/settings.json`. */
export function defaultSettingsPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..", "data", "lazuli", "settings.json");
}

let appleLanguages = null;
// `defaults read -g AppleLanguages`, read once; "" when it cannot be read (English).
const readAppleLanguages = () =>
  (appleLanguages ??= new Promise((resolve) =>
    execFile("defaults", ["read", "-g", "AppleLanguages"], { timeout: 5000 }, (e, so) => resolve(e ? "" : String(so))),
  ));

/** Starts from `initial` ("ko" or "en") and calls `onChange(lang)` each time the settings file asks
 *  for another language. The folder is watched and the file polled each second (source.mjs
 *  watchFile). A missing file or one that is not JSON (a write in progress) keeps the language. */
export function followLanguage(file, initial, onChange) {
  let current = initial;
  let seq = 0;
  async function check() {
    const n = ++seq;
    let setting;
    try {
      setting = JSON.parse(await readFile(file, "utf8"))?.language;
    } catch {
      return;
    }
    const lang = setting === "ko" || setting === "en" ? setting : resolveLanguage("system", await readAppleLanguages());
    if (n !== seq || lang === current) return;
    current = lang;
    onChange(lang);
  }
  watchFile(file, (exists) => {
    if (exists) check();
  });
  check();
}
