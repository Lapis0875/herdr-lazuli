// What the three Assistant views share: the layout block ids (K2), where a copy's state and calls come from (the
// service, sys/assistant.js; a sample for preview copies), the relay gate in front of it (K4: a host not known to be
// this Mac draws a gate and never opens anything), the `lazuli.assistant:<verb>` parsing (K7), short row times and
// the dot of a bridge state.

import { div } from "gpui-kit";
import { t } from "../../core/i18n.js";
import { tokens } from "../../ui/tokens.js";
import { activeChild } from "../../sys/bus.js";
import { NODE } from "../../sys/state.js";
import * as service from "../../sys/assistant.js";
import { snapshotMode, hostLocal } from "../apps/snapshot.js";
import { shortDate } from "../apps/fmt.js";
import * as sample from "./sample.js";

/** The layout blocks of the Assistant row (K2). */
export const BLOCK = Object.freeze({ list: "assistant-list", chat: "assistant-chat", info: "assistant-info", files: "assistant-files" });

/** A copy's props → `{pinned, preview}`: `sample: "<name>"` pins the copy to one sample and only draws; `preview: true`
 *  draws the shown sample (`lazuli.assistant:sample:<name>` switches it) and acts on that sample only. The layout's own
 *  copies draw and act on the service. */
export function copyMode(p) {
  const pinned = typeof p?.sample === "string" && sample.SAMPLES.includes(p.sample) ? p.sample : null;
  return { pinned, preview: p?.preview === true || pinned !== null };
}

/** The calls (K4) a copy makes: the sample's for preview copies, else the service's. */
export const callsOf = (mode) => (mode.preview ? sample : service);

/** Whether the Assistant screen is the center view now. */
export const screenShown = () => activeChild(NODE.center) === "assistant";

const EMPTY_LIST = Object.freeze({ groups: [], planned: [{ agent: "nod" }], pickable: [] });

/** The state a copy draws (K4 `AssistantState`). Preview copies draw their sample. A layout copy draws the service's,
 *  unless this window is not known to be the Mac (the K4 relay gate, as Home, Inbox and Recap decide it): a relay
 *  device draws the desktop-only notice and no data, an unanswered host probe the checking state. */
export function viewState(mode) {
  if (mode.preview) return sample.snapshot(mode.pinned ?? undefined);
  const gate = snapshotMode() ? "relay" : hostLocal() ? null : "checking";
  if (gate) return { gate, gateDetail: null, folder: null, hermes: null, bridges: {}, list: EMPTY_LIST, sessions: {}, notices: [] };
  return service.snapshot();
}

/** Whether the state shows chats (no gate in front). */
export const open = (s) => s?.gate === "ok";

/** `assistant:<verb>[:<arg>]` (what sys/bus.js hands every copy for `lazuli.assistant:<verb>`) → `{verb, arg}`; null
 *  for anything else, so another view's command (`lazuli.allow`, `lazuli.stop`, `lazuli.send:…`) never acts on a
 *  chat. */
export function verbOf(command) {
  if (typeof command !== "string" || !command.startsWith("assistant:")) return null;
  const c = command.slice("assistant:".length);
  const i = c.indexOf(":");
  return i < 0 ? { verb: c, arg: "" } : { verb: c.slice(0, i), arg: c.slice(i + 1) };
}

/** Handles `sample:<name>` in any copy: shows that sample in every preview copy. True when it was that verb. */
export function sampleVerb(v, cx) {
  if (v?.verb !== "sample") return false;
  if (sample.use(v.arg)) cx.notify();
  return true;
}

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A list row's time: "now", "12m", "2h", "3d", then "Nov 12". */
export function rowTime(at, now = Date.now()) {
  if (typeof at !== "number") return "";
  const d = Math.max(0, now - at);
  if (d < MIN) return t("common.dur.now");
  if (d < HOUR) return t("common.dur.min", { n: Math.floor(d / MIN) });
  if (d < DAY) return t("common.dur.hour", { n: Math.floor(d / HOUR) });
  if (d < 7 * DAY) return t("common.dur.day", { n: Math.floor(d / DAY) });
  return shortDate(at);
}

const BANNERS = ["agent-exit", "disconnected", "bridge-launch-failed", "bridge-timeout", "auth"];

/** A bridge error code with words of its own (`assistant.banner.<code>`); any other reads as a failed launch. */
export const bannerCode = (code) => (BANNERS.includes(code) ? code : "bridge-launch-failed");

const ERRORS = ["no-folder", "relay", "hermes-missing", "hermes-check-failed", "bridge-launch-failed", "bridge-timeout", "agent-exit", "auth", "disconnected", "busy", "not-found", "too-long", "too-late"];

/** A service call's error code (K4) in words: `rpc:<code>` with its code, the others by name. */
export function errorText(code) {
  const c = String(code ?? "");
  if (c.startsWith("rpc:")) return t("assistant.error.rpc", { code: c.slice(4) });
  return ERRORS.includes(c) ? t(`assistant.error.${c}`) : t("common.error");
}

/** "0:42", "12:05", "1:02:09": a running turn's elapsed time. */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** The dot of a bridge state (K4 `off | starting | ready | error | stopped`), labelled for tooltips and screen readers:
 *  ready a done dot, starting a breathing working dot, off and stopped an idle ring, error an error dot. */
export function BridgeDot(id, state) {
  const k = tokens();
  const known = ["off", "starting", "ready", "error", "stopped"].includes(state) ? state : "off";
  const label = t(`assistant.bridge.${known}`);
  const color = { ready: k.state.done, starting: k.state.working, error: k.state.error }[known] ?? k.state.idle;
  const dot = div()
    .flex_none()
    .size(7)
    .rounded(k.radius.full)
    .map((e) => (known === "off" || known === "stopped" ? e.border(1.5).border_color(color) : e.bg(color)))
    .when(known === "starting", (e) => e.loop("opacity", { from: 0.45, to: 1, period: 1400 }));
  return div()
    .id(id)
    .flex_none()
    .size(20)
    .flex()
    .items_center()
    .justify_center()
    .role("image")
    .accessibility_label(label)
    .tooltip(label)
    .child(dot);
}
