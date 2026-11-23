// The Assistant's chat (`view: "assistant"`, block assistant-chat, K2; D10, D16–D20, D28, D29, A5–A9): the selected
// session's header (title, profile, running time, model menu, Fork), a banner when its Hermes bridge is down, the
// transcript, the plan dock, and the composer. Before a folder and Hermes are ready (or on a relay device) the block
// shows the gate instead (gate.js).
//
// Data: the service (sys/assistant.js, K4) read through snapshot() in render and called inside cx.spawn; preview
// copies draw and seed from views/assistant/sample.js. This copy opens the Assistant (`open`, which starts the default
// profile's bridge) each time the screen is shown on a window known to be the Mac; a relay device never opens it.
// Commands (K7, this copy acts on them): `lazuli.assistant:focus`, `:stop`, `:attach:<rel>`, `:allow`, `:deny`,
// `:send:<text>`; every copy takes `:sample:<name>`. The `lazuli.key:<keystroke>` test hook reaches key().
// A copy with `props.sample` or `props.preview` only draws.

import { props, home } from "herdr";
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, IconButton, Button, Spinner, Chip, Banner, Empty, Menu, MenuItem, Spacer } from "../ui/kit.js";
import { Notice } from "./apps/ui.js";
import { tilde } from "./apps/fmt.js";
import { probeHost, hostLocal } from "./apps/snapshot.js";
import { blockShown } from "./panels/common.js";
import * as sample from "./assistant/sample.js";
import { BLOCK, copyMode, callsOf, screenShown, viewState, open, verbOf, sampleVerb, elapsed, errorText, bannerCode } from "./assistant/common.js";
import { isRunning } from "../core/assistant-chat.js";
import { agentOf, routeText } from "../core/assistant-agents.js";
import { selectedChat, runningSince, pendingPermissions, currentModel, modelChoices, modelIdFor, bridgeError } from "./assistant/model.js";
import { Transcript, Scrolls } from "./assistant/transcript.js";
import { PlanDock } from "./assistant/cards.js";
import { Composer } from "./assistant/composer.js";
import { Gate } from "./assistant/gate.js";
import { chooseFolder, FolderConfirm } from "./assistant/folder.js";
import { MenuButton, MenuPopover } from "./assistant/menu.js";

const HOST_MS = 2000;
const TICK_MS = 1000;
// How often the copy looks whether the screen came into view (the Home watch's pace).
const SHOW_MS = 500;

export default class Assistant {
  constructor(name) {
    this.name = name;
  }

  init(p, cx) {
    this.props = props() ?? p ?? {};
    this.mode = copyMode(this.props);
    this.svc = callsOf(this.mode);
    // What this copy shows of a session: expanded items (`tool:<id>`, `thought:<index>`), the plan dock, the open More
    // and model menus, and each session's scroll.
    this.expanded = new Set();
    this.planOpen = true;
    this.more = null;
    this.modelMenu = false;
    this.scrolls = new Scrolls();
    this.notice = new Notice();
    this.handle = cx.focus_handle();
    this.composer = new Composer(this, cx);
    // The folder question (D22, folder.js) and whether open() ran for the current showing of the screen.
    this.folderAsk = null;
    this.folderError = null;
    this.opened = false;
    this.seen = -1;
    this.seed();
    // The countdown of an approval and the running time move once a second while they show.
    cx.timer.every(TICK_MS, (cx) => {
      if (!this.mode.preview && !blockShown(BLOCK.chat)) return;
      const chat = this.chat();
      if (chat && (isRunning(chat) || pendingPermissions(chat).length)) cx.notify();
    });
    if (this.mode.preview) return;
    probeHost(cx);
    cx.timer.every(HOST_MS, (cx) => {
      if (!hostLocal()) probeHost(cx);
    });
    this.watch(cx);
    cx.timer.every(SHOW_MS, (cx) => this.watch(cx));
  }

  /** Opens the Assistant once per showing of the screen on the Mac (K4: idempotent per show); a relay device, or a
   *  host not yet known to be local, opens nothing. */
  watch(cx) {
    if (!screenShown()) {
      this.opened = false;
      return;
    }
    if (this.opened || !hostLocal()) return;
    this.opened = true;
    cx.spawn(async (cx) => {
      await this.svc.open(cx);
      cx.notify();
    });
  }

  /** The state drawn now, and its selected session. */
  state() {
    return viewState(this.mode);
  }

  chat(s = this.state()) {
    return open(s) ? selectedChat(s) : null;
  }

  /** A preview copy takes the shown sample's seed (expanded items, the plan dock, an open More, the composer) when the
   *  sample changes. Layout copies start empty. */
  seed() {
    if (!this.mode.preview || sample.revision() === this.seen) return;
    this.seen = sample.revision();
    const s = sample.viewSeed(this.mode.pinned ?? undefined);
    this.expanded = new Set(s.expand ?? []);
    this.planOpen = s.planOpen ?? true;
    this.more = s.more ?? null;
    this.modelMenu = false;
    this.scrolls = new Scrolls();
    this.composer.set(s.text ?? "", s.attachments ?? []);
  }

  focus(_cx) {
    this.composer.box.focus();
  }

  // Actions.

  /** Runs one service call; its error shows for a few seconds. A drawing-only copy acts on nothing. */
  act(cx, call, after) {
    if (this.mode.preview) return;
    cx.spawn(async (cx) => {
      const r = await call(cx);
      // A refused answer after expiry already stands in the transcript (K5 rule 4).
      if (r?.error && r.error !== "too-late") this.notice.show(cx, { tone: "error", text: errorText(r.error) });
      after?.(cx);
      cx.notify();
    });
  }

  toggle(cx, id) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    cx.notify();
  }

  /** Enter (`how: "send"`) sends, or steers while a turn runs; ⌥Enter or ⌘Enter (`"queue"`) adds a chip. A typed
   *  `/queue x` is a chip and `/model x` the model menu's choice; anything else, a typed `/steer x` or a command too,
   *  goes to the agent (K4 slash routing, core/assistant-agents.js routeText). */
  submit(cx, how) {
    const s = this.state();
    const chat = this.chat(s);
    if (!chat || this.mode.preview || bridgeError(s, chat.profile)) return;
    const text = this.composer.value().trim();
    const attachments = [...this.composer.attachments];
    if (how === "queue") {
      if (!text) return;
      this.composer.set("", attachments);
      this.act(cx, (cx) => this.svc.queue(cx, chat.key, text));
      return;
    }
    if (!text && !attachments.length) return;
    const route = routeText(text, chat.agent);
    if (route.route === "queue") {
      this.composer.set("", attachments);
      this.act(cx, (cx) => this.svc.queue(cx, chat.key, route.text));
    } else if (route.route === "model") {
      this.composer.set("", attachments);
      this.act(cx, (cx) => this.svc.setModel(cx, chat.key, modelIdFor(chat, route.model)));
    } else {
      this.composer.set("", []);
      this.scrolls.of(chat.key).follow = true;
      this.act(cx, (cx) => this.svc.send(cx, chat.key, { text, attachments }));
    }
    cx.notify();
  }

  stop(cx) {
    const chat = this.chat();
    if (chat) this.act(cx, (cx) => this.svc.stopTurn(cx, chat.key));
  }

  unqueue(cx, id) {
    const chat = this.chat();
    if (!chat || this.mode.preview) return;
    this.svc.unqueue(chat.key, id);
    cx.notify();
  }

  resumeQueue(cx) {
    const chat = this.chat();
    if (chat) this.act(cx, (cx) => this.svc.resumeQueue(cx, chat.key));
  }

  answer(cx, key, requestId, optionId) {
    this.more = null;
    this.act(cx, (cx) => this.svc.answerPermission(cx, key, requestId, optionId));
  }

  /** `lazuli.assistant:allow` / `:deny`: answered with the agent's quick answer (Hermes: allow_once, deny). The target
   *  is the selected session's newest pending request, else its newest closed one (expired, or cancelled by the agent):
   *  that answer still goes to the service, which refuses it as too late and puts the "too late" notice in the
   *  transcript (AT-08), so the transcript follows to show it. Answered requests are not asked again. */
  answerNewest(cx, verb) {
    const chat = this.chat();
    const optionId = agentOf(chat?.agent)?.quickAnswers?.[verb];
    if (!chat || !optionId) return;
    const newest = (states) =>
      Object.entries(chat.permissions ?? {})
        .filter(([, p]) => states.includes(p?.state))
        .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))[0];
    const target = newest(["pending"]) ?? newest(["expired", "cancelled"]);
    if (!target) return;
    this.scrolls.of(chat.key).follow = true;
    this.answer(cx, chat.key, target[0], optionId);
  }

  fork(cx) {
    const chat = this.chat();
    if (chat) this.act(cx, (cx) => this.svc.fork(cx, chat.key));
  }

  setModel(cx, id) {
    const chat = this.chat();
    this.modelMenu = false;
    if (chat) this.act(cx, (cx) => this.svc.setModel(cx, chat.key, id));
  }

  retryBridge(cx, profile) {
    this.act(cx, (cx) => this.svc.retryBridge(cx, profile));
  }

  /** The gates' Retry: the service checks the folder and Hermes again, then opens (K4). */
  recheck(cx) {
    this.act(cx, (cx) => this.svc.recheck(cx));
  }

  /** The gates' folder button: the picker, and the D22 question when a turn runs (folder.js). */
  pickFolder(cx) {
    if (this.mode.preview) return;
    chooseFolder(this, this.svc, cx);
  }

  copy(cx, text) {
    cx.write_to_clipboard(text);
    this.notice.show(cx, { tone: "success", text: t("assistant.gate.copied"), ms: 2000 });
  }

  command(command, cx) {
    const v = verbOf(command);
    if (!v) return;
    if (sampleVerb(v, cx)) {
      this.seed();
      return;
    }
    if (this.mode.preview) return;
    if (v.verb === "focus") this.composer.box.focus();
    else if (v.verb === "stop") this.stop(cx);
    else if (v.verb === "attach" && v.arg) {
      this.composer.attach(v.arg);
      this.composer.box.focus();
    } else if (v.verb === "allow" || v.verb === "deny") this.answerNewest(cx, v.verb);
    else if (v.verb === "send" && v.arg) {
      this.composer.set(v.arg, this.composer.attachments);
      this.submit(cx, "send");
    } else return;
    cx.notify();
  }

  /** The `lazuli.key:` test hook: the composer's keys, then the transcript's scroll keys. */
  key(e, cx) {
    const chat = this.chat();
    if (!chat) return false;
    const taken = this.composer.key(e, cx, chat, this.svc.folderFiles()) || (!this.composer.focus.focused && this.scrolls.key(chat.key, e.keystroke));
    if (taken) cx.notify();
    return taken;
  }

  // Drawing.

  header(s, chat, now) {
    const k = tokens();
    const head = h_flex().h(40).flex_none().pl(12).pr(6).gap(6).items_center().border_b_1().border_color(k.line.soft);
    if (!chat) return head.child(Text(t("assistant.chat.label"), { size: "sm", weight: "semibold", nowrap: true }));
    const running = isRunning(chat);
    const since = runningSince(chat);
    const model = currentModel(chat);
    const busy = running || this.mode.preview;
    const label = model ? t("assistant.chat.model", { model: model.name }) : undefined;
    const menu =
      busy || !model
        ? Button("ac-model", model?.name ?? "—", { variant: "ghost", size: "sm", disabled: true, tooltip: running ? t("assistant.chat.modelBusy") : label, a11y: label })
            .font_family(k.fonts.mono)
            .text_size(k.fontSize.xs)
            .child(Icon("chevron-down", { size: 12, color: k.text.tertiary }))
        : MenuPopover("ac-model-menu", {
            trigger: MenuButton("ac-model", model.name, { open: this.modelMenu, mono: true, a11y: label, tooltip: this.modelMenu ? undefined : label }),
            open: this.modelMenu,
            anchor: "top_right",
            onOpen: (value) => {
              this.modelMenu = value;
            },
            menu: () =>
              Menu({
                id: "ac-models",
                width: 260,
                label: t("assistant.chat.models"),
                children: modelChoices(chat).map((m) => MenuItem(`ac-m-${m.id}`, { label: m.name, detail: m.detail || undefined, checked: m.current, onClick: (_e, cx) => this.setModel(cx, m.id) })),
              }),
          });
    return head
      .child(Text(chat.title || t("assistant.list.untitled"), { size: "sm", weight: "semibold", truncate: true, tone: chat.title ? "primary" : "secondary" }).flex_shrink_1())
      .child(Chip(chat.profile, { mono: true }))
      .child(Spacer())
      .when(running, (e) =>
        e.child(
          h_flex()
            .flex_none()
            .gap(6)
            .mr(4)
            .items_center()
            .child(Spinner({ size: 13 }))
            .child(Text(t("assistant.chat.running", { time: elapsed(now - (since ?? now)) }), { size: "xs", tone: "tertiary", nowrap: true })),
        ),
      )
      .child(menu)
      .child(IconButton("ac-fork", "git-fork", t("assistant.chat.fork"), { disabled: running || this.mode.preview || !(chat.items?.length), onClick: (_e, cx) => this.fork(cx) }));
  }

  body(s, chat, now) {
    const k = tokens();
    if (!chat) return div().flex_1().flex().items_center().justify_center().child(Empty({ id: "ac-none", icon: "message-square", title: t("assistant.chat.noSession") }));
    if (chat.loaded === false) {
      return h_flex().flex_1().gap(8).items_center().justify_center().role("status").child(Spinner({ size: 14 })).child(Text(t("assistant.chat.loading"), { size: "sm", tone: "secondary" }));
    }
    if (!chat.items?.length && !Object.keys(chat.permissions ?? {}).length) {
      return div()
        .flex_1()
        .flex()
        .items_center()
        .justify_center()
        .child(Empty({ id: "ac-intro", icon: "bot", title: t("assistant.chat.emptyTitle", { profile: chat.profile }), body: t("assistant.chat.emptyBody", { folder: tilde(s.folder ?? "", home()) }) }));
    }
    return Transcript(this, chat, now).bg(k.bg.card);
  }

  render(_cx) {
    const k = tokens();
    const now = Date.now();
    const s = this.state();
    const ask = FolderConfirm(this, this.svc, s.folder);
    const root = ViewRoot("ac-root", { bg: k.bg.card })
      .relative()
      .track_focus(this.handle)
      .accessibility_label(t("assistant.chat.label"))
      .on_key_down((e, cx) => {
        const chat = this.chat();
        if (chat && !this.composer.focus.focused && this.scrolls.key(chat.key, e.keystroke)) {
          cx.stop_propagation();
          cx.notify();
        }
      });
    if (!open(s)) {
      return root
        .child(this.header(s, null, now))
        .child(Gate(this, s))
        .when(Boolean(this.folderError), (e) => e.child(h_flex().absolute().left(12).right(12).top(48).child(Banner({ id: "ac-folder-error", tone: "error", title: this.folderError }))))
        .when(Boolean(ask), (e) => e.child(ask));
    }
    const chat = selectedChat(s);
    const down = chat && bridgeError(s, chat.profile) ? bannerCode(bridgeError(s, chat.profile)) : null;
    const banner = this.notice.render("ac-notice", t("common.close"));
    return root
      .child(this.header(s, chat, now))
      .when(Boolean(down), (e) =>
        e.child(
          div()
            .flex_none()
            .px(12)
            .pt(10)
            .child(
              Banner({
                id: "ac-bridge",
                tone: "error",
                title: t(`assistant.banner.${down}`),
                body: t(`assistant.banner.${down}.body`),
                actions: [{ id: "ac-bridge-retry", label: t("assistant.banner.retry"), icon: "refresh-cw", onClick: (_e, cx) => this.retryBridge(cx, chat.profile) }],
              }),
            ),
        ),
      )
      .child(this.body(s, chat, now))
      .when(Boolean(chat?.plan?.entries?.length), (e) => e.child(PlanDock(this, chat.plan)))
      .when(Boolean(chat), (e) => e.child(this.composer.render(chat, { running: isRunning(chat), offline: Boolean(down), files: this.svc.folderFiles(), preview: this.mode.preview })))
      .when(Boolean(banner), (e) => e.child(h_flex().absolute().left(12).right(12).top(48).child(banner)))
      .when(Boolean(ask), (e) => e.child(ask));
  }
}
