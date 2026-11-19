// lazuli's UI text: `t(key, vars)` over the merged catalogs, `{name}` placeholders, fallback
// ko → en → key, and the language choice (C3, ARCHITECTURE §2). Pure: the store reads the setting
// and the system language and calls setLanguage (sys/store.js).

import { catalogs } from "./catalog/index.js";

/** The UI languages. */
export const LANGUAGES = Object.freeze(["ko", "en"]);

let current = "en";
const listeners = new Set();

/** The language `t` uses now: "ko" or "en". */
export function language() {
  return current;
}

/** Switches the language `t` uses; anything but "ko" means English. Calls every listener with the new
 *  language when it changes. Returns whether it changed. */
export function setLanguage(lang) {
  const next = lang === "ko" ? "ko" : "en";
  if (next === current) return false;
  current = next;
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch (e) {
      console.log(`[lazuli/i18n] language listener failed: ${e?.message ?? e}`);
    }
  }
  return true;
}

/** Calls `fn(lang)` after every language change. Returns a function that stops it. */
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Fills `{name}` with `vars.name`. A placeholder whose value is missing stays as written. */
export function format(text, vars) {
  if (!vars) return text;
  return text.replace(PLACEHOLDER, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined ? String(vars[name]) : whole,
  );
}

/** The placeholder names in a text, sorted, each once. */
export function placeholders(text) {
  return [...new Set(Array.from(String(text).matchAll(PLACEHOLDER), (m) => m[1]))].sort();
}

/** The text for a key in a language, following ko → en, or null when no catalog has it.
 *  An empty text counts as missing. */
export function lookup(lang, key, table = catalogs) {
  for (const l of lang === "ko" ? ["ko", "en"] : ["en"]) {
    const text = table[l]?.[key];
    if (typeof text === "string" && text !== "") return text;
  }
  return null;
}

/** `t` for an explicit language and catalog table: the text, else the key itself, then filled. */
export function translate(lang, key, vars, table = catalogs) {
  return format(lookup(lang, key, table) ?? key, vars);
}

/** The UI text for a key in the current language. */
export function t(key, vars) {
  return translate(current, key, vars);
}

/** The entries of `defaults read -g AppleLanguages` output, in order:
 *  `(\n    "ko-KR",\n    en\n)` → `["ko-KR", "en"]`. Anything else → []. */
export function parseAppleLanguages(output) {
  if (typeof output !== "string") return [];
  return output
    .replace(/[()]/g, "")
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1").trim())
    .filter(Boolean);
}

/** The UI language for a settings value: "ko" and "en" as set; "system" (or anything else) follows
 *  the first entry of AppleLanguages: Korean when it is `ko` or `ko-…`, else English. */
export function resolveLanguage(setting, appleLanguagesOutput) {
  if (setting === "ko" || setting === "en") return setting;
  const [first] = parseAppleLanguages(appleLanguagesOutput);
  return first && /^ko(?:[-_]|$)/i.test(first) ? "ko" : "en";
}

/** The line AI prompts end with, so AI-written text follows the setting (C3). */
export function promptLanguageLine(lang = current) {
  return lang === "ko" ? "Answer in Korean." : "Answer in English.";
}
