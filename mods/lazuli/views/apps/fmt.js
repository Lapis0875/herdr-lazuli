// Time, money and size as the app views write them, in the current language (catalog area `home.fmt.*`). QuickJS has
// no Intl, so dates are spelled from catalog names and local Date getters.

import { t } from "../../core/i18n.js";

const MIN = 60000;
const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");

/** A span of milliseconds, short: "<1m", "6m", "1h 20m", "3h", "2d" (Korean: "6분", "1시간 20분"). */
export function span(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / MIN);
  if (m < 1) return t("home.fmt.lessMin");
  if (m < 60) return t("home.fmt.min", { n: m });
  const h = Math.floor(m / 60);
  if (h < 10 && m % 60) return t("home.fmt.hourMin", { h, m: m % 60 });
  if (h < 48) return t("home.fmt.hour", { n: h });
  return t("home.fmt.day", { n: Math.floor(h / 24) });
}

/** Seconds as a span: "35m", "1h 20m". */
export const secs = (s) => span((Number(s) || 0) * 1000);

/** How long ago `at` (ms) was: "just now", "6m ago". */
export function ago(at, now = Date.now()) {
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  const d = now - at;
  return d < MIN ? t("home.fmt.justNow") : t("home.fmt.ago", { time: span(d) });
}

/** How long until `at`: "in 6m". */
export function until(at, now = Date.now()) {
  return t("home.fmt.in", { time: span(at - now) });
}

/** "14:12". */
export function clock(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local midnight of the day holding `at`. */
const dayStart = (at) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "14:12" today, "Yesterday 14:12", "Tomorrow 09:00", else "Nov 19 14:12". */
export function when(at, now = Date.now()) {
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  const days = Math.round((dayStart(at) - dayStart(now)) / DAY);
  if (days === 0) return clock(at);
  if (days === -1) return t("home.fmt.yesterday", { time: clock(at) });
  if (days === 1) return t("home.fmt.tomorrow", { time: clock(at) });
  return t("home.fmt.dayTime", { date: shortDate(at), time: clock(at) });
}

/** "Nov 19" / "11월 19일". */
export function shortDate(at) {
  const d = new Date(at);
  return t("home.fmt.shortDate", { month: t(`home.fmt.month.${d.getMonth() + 1}`), day: d.getDate() });
}

/** "Thursday, November 19" / "11월 19일 목요일". */
export function longDate(at) {
  const d = new Date(at);
  return t("home.fmt.longDate", { month: t(`home.fmt.monthLong.${d.getMonth() + 1}`), day: d.getDate(), weekday: t(`home.fmt.weekday.${d.getDay()}`) });
}

/** The short weekday name of a "YYYY-MM-DD" day or a time: "Mon" / "월". */
export function weekdayOf(day) {
  const d = typeof day === "string" ? new Date(`${day}T12:00:00`) : new Date(day);
  return Number.isNaN(d.getTime()) ? "" : t(`home.fmt.wd.${d.getDay()}`);
}

/** "$38.40", "$124", "–" for nothing. */
export function money(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "–";
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** "12.3k", "4.1M" tokens. */
export function tokensText(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** The first non-empty line of a text, at most `max` characters. */
export function firstLine(text, max = 200) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return Array.from(line ?? "").slice(0, max).join("");
}

/** A path with the home folder as `~`. */
export function tilde(path, home) {
  const p = String(path ?? "");
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/** A text in parts, in order: plain runs `{text}` and its links `{text, link}` (links as sys/todo.js gives them). */
export function linkParts(text, links) {
  const out = [];
  let at = 0;
  for (const link of links) {
    const i = text.indexOf(link.label, at);
    if (i < 0) continue;
    if (i > at) out.push({ text: text.slice(at, i) });
    out.push({ text: link.label, link });
    at = i + link.label.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** A PR's unresolved thread count as shown: "N+" when sys/gh.js could not page them all (`threadsPartial`: a lower
 *  bound). */
export const threadCount = (pr) => (pr?.threadsPartial === true ? `${pr?.threads ?? 0}+` : String(pr?.threads ?? 0));
