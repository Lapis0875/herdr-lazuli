// Words and small shapes the shell views share: elapsed times, short paths, key chords, the CI state of a PR, the
// stage colors, and who waits longest. Every user-visible word goes through the catalog.

import { home } from "herdr";
import { t } from "../../core/i18n.js";
import { tilde } from "../../core/paths.js";
import { FAILED } from "../../core/gh-map.js";
import { STAGES, counts as stageCounts } from "../../core/stage.js";

export { STAGES, stageCounts };

const num = (v) => typeof v === "number" && Number.isFinite(v);

/** A span of time as the shell writes it: "방금", "23분", "1시간", "2일". */
export function dur(ms) {
  if (!num(ms) || ms < 60000) return t("common.dur.now");
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return t("common.dur.min", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.dur.hour", { n: hours });
  return t("common.dur.day", { n: Math.floor(hours / 24) });
}

/** Time since something: "2시간 전". */
export function ago(ms) {
  return num(ms) && ms >= 60000 ? t("common.ago", { when: dur(ms) }) : t("common.dur.now");
}

/** A path with the home folder as "~". */
export function shortPath(path) {
  return typeof path === "string" && path ? tilde(path, home()) : "";
}

const KEY_GLYPH = {
  enter: "↵",
  escape: "esc",
  space: "␣",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  pageup: "⇞",
  pagedown: "⇟",
};
const MOD_GLYPH = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" };
const MOD_ORDER = ["fn", "ctrl", "alt", "shift", "cmd"];

/** A keys.json chord ("cmd-shift-p", "ctrl-k ctrl-s") as macOS writes it: "⇧⌘P", "⌃K ⌃S". */
export function chord(keys) {
  if (typeof keys !== "string" || !keys) return "";
  return keys
    .split(" ")
    .filter(Boolean)
    .map((one) => {
      let key;
      let mods;
      if (one.endsWith("-") && one.length > 1) {
        key = "-";
        mods = one.slice(0, -1).split("-").filter(Boolean);
      } else {
        mods = one.split("-");
        key = mods.pop() ?? "";
      }
      const held = MOD_ORDER.filter((m) => mods.includes(m)).map((m) => MOD_GLYPH[m]).join("");
      const face = KEY_GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
      return `${held}${face}`;
    })
    .join(" ");
}

/** The CI state of a PR row (gh-map `ci`): "pass", "fail", "running", or null without checks. */
export function ciState(pr) {
  const ci = pr?.ci;
  if (typeof ci !== "string" || !ci) return null;
  if (ci === "SUCCESS") return "pass";
  if (FAILED.includes(ci)) return "fail";
  return "running";
}

/** The CI label for a state from ciState. */
export const ciLabel = (state) => t(`shell.ci.${state}`);

/** A PR chip's state: draft, or open. */
export const prState = (pr) => (pr?.isDraft ? "draft" : "open");

/** The dot each stage shows: needs → blocked, working, ready → done, done → idle (a ring). */
export const STAGE_DOT = Object.freeze({ needs: "blocked", working: "working", ready: "done", done: "idle" });

/** The stage's word: "나를 기다림", "작업 중", "머지 준비", "완료". */
export const stageLabel = (stage) => t(`shell.stage.${stage}`);

/** The agents waiting for the person (stage `needs`), longest waiting first. */
export function waitingFirst(rows, now = Date.now()) {
  return rows
    .filter((a) => a.stage === "needs")
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (num(x.a.since) ? x.a.since : now) - (num(y.a.since) ? y.a.since : now) || x.i - y.i)
    .map(({ a }) => a);
}

/** What to call an agent row: its terminal title, else its tab's name, else its program, else its address. */
export function agentName(a) {
  const title = typeof a?.title === "string" ? a.title.trim() : "";
  return title || a?.tab_name || a?.program?.name || a?.address || "";
}

/** A tab's name without the file-tab markers ("● ", "◦ "): the sidebar draws them as state. */
export function plainTabName(name) {
  return typeof name === "string" ? name.replace(/^[●◦]\s+/, "") : "";
}
