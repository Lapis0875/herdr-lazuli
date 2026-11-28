// lazuli's settings (DESIGN C3, ARCHITECTURE §2), opened as a dialog from the sidebar footer and the palette. Every
// change goes to data/lazuli/settings.json through sys/store.js updateSettings and is live at once (the language
// redraws every copy). Sections: language; the headless agent (command, model, parallel routines); GitHub (org scope,
// poll interval); the sidebar's pinned apps; the Assistant's folder (picked through sys/assistant.js, which asks
// before switching while a turn runs, D22); notifications (lazuli's switch, the system status from sys/notify.js and
// asking macOS for permission); files (the PDF zoom, the external editor); Herdr's own settings and keys.
// A `preview: true` copy shows the values and writes nothing.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { closeOverlay, props, run, updates } from "herdr";
import * as store from "../sys/store.js";
import * as assistant from "../sys/assistant.js";
import * as notify from "../sys/notify.js";
import { DEFAULT_PINS, PDF_ZOOMS } from "../sys/state.js";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, IconButton, Button, CheckBox, Segmented, TextInput, Field, SectionHeader, Divider, Spinner } from "../ui/kit.js";
import { quoteWord, splitWords, settingsRow, FolderField } from "./shell/settings-parts.js";
import { snapshotMode } from "./apps/snapshot.js";
import { chooseFolder, FolderConfirm } from "./assistant/folder.js";

const log = (msg) => console.log(`[lazuli/settings] ${msg}`);
const errText = (e) => e?.message ?? String(e);

const POLL_MIN = 30;
const POLL_MAX = 3600;
const PARALLEL_MAX = 10;
const APPS = Object.freeze({ inbox: "inbox", todo: "list-todo", routines: "calendar-clock", assistant: "bot" });
const NEEDS_ASK = new Set(["not-requested", "denied", "failed"]);

export default class Settings {
  constructor(name) {
    this.name = name;
  }

  init(p, _cx) {
    this.props = props() ?? p ?? {};
    this.preview = this.props.preview === true;
    const s = store.settings();
    this.errors = {};
    this.saved = null;
    this.asking = false;
    // Each field keeps its own focus flag: the accent edge while typing, and a commit when it loses the keyboard.
    this.focus = {};
    const field = (key, value, placeholder) => {
      const state = InputState.new({ value, placeholder });
      this.focus[key] = { focused: false };
      state.on("submit", (_e, cx) => this.commit(key, cx));
      state.on("focus", (_e, cx) => {
        this.focus[key].focused = true;
        cx.notify();
      });
      state.on("blur", (_e, cx) => {
        this.focus[key].focused = false;
        this.commit(key, cx);
      });
      return state;
    };
    this.inputs = {
      command: field("command", s.agent.command.map(quoteWord).join(" "), "omp"),
      model: field("model", s.agent.model ?? "", t("settings.agent.modelPlaceholder")),
      parallel: field("parallel", String(s.routines.maxParallel), "3"),
      org: field("org", s.gh.org.join(", "), t("settings.gh.orgPlaceholder")),
      poll: field("poll", String(s.gh.pollSec), "120"),
      editor: field("editor", typeof s.editor === "string" ? s.editor : "", "code"),
    };
  }

  async close() {
    for (const state of Object.values(this.inputs ?? {})) state.release();
  }

  /** Writes a settings change; `key` names what the "saved" note marks. */
  save(key, change, cx) {
    if (this.preview) return;
    cx.spawn(async (cx) => {
      try {
        await store.updateSettings(change);
        this.saved = key;
      } catch (e) {
        log(`not saved: ${errText(e)}`);
        this.errors[key] = t("settings.saveFailed");
      }
      cx.notify();
    });
  }

  /** A text field's value, checked and saved when it changed (Enter or leaving the field). */
  commit(key, cx) {
    const text = this.inputs[key].value().trim();
    const s = store.settings();
    delete this.errors[key];
    if (key === "command") {
      const words = splitWords(text);
      if (JSON.stringify(words.length ? words : ["omp"]) === JSON.stringify(s.agent.command)) return;
      this.save(key, (d) => ({ ...d, agent: { ...d.agent, command: words.length ? words : ["omp"] } }), cx);
    } else if (key === "model") {
      if (text === (s.agent.model ?? "")) return;
      this.save(key, (d) => {
        const agent = { ...d.agent };
        if (text) agent.model = text;
        else delete agent.model;
        return { ...d, agent };
      }, cx);
    } else if (key === "parallel") {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1 || n > PARALLEL_MAX) this.errors[key] = t("settings.agent.parallelInvalid", { max: PARALLEL_MAX });
      else if (n !== s.routines.maxParallel) this.save(key, (d) => ({ ...d, routines: { ...d.routines, maxParallel: n } }), cx);
    } else if (key === "org") {
      const orgs = [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
      if (orgs.some((o) => !/^[A-Za-z0-9_.-]+$/.test(o))) this.errors[key] = t("settings.gh.orgInvalid");
      else if (JSON.stringify(orgs) !== JSON.stringify(s.gh.org)) this.save(key, (d) => ({ ...d, gh: { ...d.gh, org: orgs } }), cx);
    } else if (key === "poll") {
      const n = Number(text);
      if (!Number.isInteger(n) || n < POLL_MIN || n > POLL_MAX) this.errors[key] = t("settings.gh.pollInvalid", { min: POLL_MIN, max: POLL_MAX });
      else if (n !== s.gh.pollSec) this.save(key, (d) => ({ ...d, gh: { ...d.gh, pollSec: n } }), cx);
    } else if (key === "editor") {
      if (text === (typeof s.editor === "string" ? s.editor : "")) return;
      this.save(key, (d) => {
        const next = { ...d };
        if (text) next.editor = text;
        else delete next.editor;
        return next;
      }, cx);
    }
    cx?.notify();
  }

  input(key, { mono = false, a11y } = {}) {
    return TextInput(this.inputs[key], { id: `set-${key}`, focused: this.focus[key].focused, invalid: Boolean(this.errors[key]), mono, a11y });
  }

  hint(key, text) {
    return this.saved === key ? t("settings.saved") : text;
  }

  language(k, s) {
    const system = store.resolvedSystemLanguage();
    const items = [
      { key: "system", label: system ? t("settings.language.systemIs", { lang: t(`settings.language.name.${system}`) }) : t("settings.language.system") },
      { key: "ko", label: t("settings.language.name.ko") },
      { key: "en", label: t("settings.language.name.en") },
    ];
    return settingsRow(k, {
      title: t("settings.language.title"),
      hint: t("settings.language.hint"),
      control: Segmented("set-lang", items, s.language, (value, cx) => this.save("language", (d) => ({ ...d, language: value }), cx), { label: t("settings.language.title") }),
    });
  }

  agent(k, s) {
    return v_flex()
      .gap(12)
      .child(Field({ id: "f-command", label: t("settings.agent.command"), hint: this.hint("command", t("settings.agent.commandHint")), error: this.errors.command, control: this.input("command", { mono: true, a11y: t("settings.agent.command") }) }))
      .child(
        h_flex()
          .gap(12)
          .items_start()
          .child(div().flex_1().min_w(0).child(Field({ id: "f-model", label: t("settings.agent.model"), hint: this.hint("model", t("settings.agent.modelHint")), error: this.errors.model, control: this.input("model", { mono: true, a11y: t("settings.agent.model") }) })))
          .child(div().w(150).flex_none().child(Field({ id: "f-parallel", label: t("settings.agent.parallel"), hint: this.hint("parallel", null), error: this.errors.parallel, control: this.input("parallel", { mono: true, a11y: t("settings.agent.parallel") }) }))),
      );
  }

  github() {
    return h_flex()
      .gap(12)
      .items_start()
      .child(div().flex_1().min_w(0).child(Field({ id: "f-org", label: t("settings.gh.org"), hint: this.hint("org", t("settings.gh.orgHint")), error: this.errors.org, control: this.input("org", { mono: true, a11y: t("settings.gh.org") }) })))
      .child(div().w(150).flex_none().child(Field({ id: "f-poll", label: t("settings.gh.poll"), hint: this.hint("poll", t("settings.gh.pollHint")), error: this.errors.poll, control: this.input("poll", { mono: true, a11y: t("settings.gh.poll") }) })));
  }

  pins(k, s) {
    const order = [...s.pins.filter((p) => APPS[p]), ...DEFAULT_PINS.filter((p) => !s.pins.includes(p))];
    const pinned = (app) => s.pins.includes(app);
    const setPins = (next, cx) => this.save("pins", (d) => ({ ...d, pins: next }), cx);
    const moveBy = (app, by, cx) => {
      const list = s.pins.filter((p) => p !== app);
      const at = Math.max(0, Math.min(list.length, s.pins.indexOf(app) + by));
      list.splice(at, 0, app);
      setPins(list, cx);
    };
    return v_flex()
      .gap(2)
      .children(
        order.map((app, i) =>
          h_flex()
            .id(`pin-${app}`)
            .h(k.row.md)
            .gap(8)
            .items_center()
            .child(Icon(APPS[app], { size: 14, color: k.text.secondary }))
            .child(
              div()
                .flex_1()
                .child(
                  CheckBox(`pin-check-${app}`, pinned(app), (on, cx) => setPins(on ? [...s.pins, app] : s.pins.filter((p) => p !== app), cx), {
                    label: t(`shell.app.${app}`),
                    disabled: this.preview,
                  }),
                ),
            )
            .when(pinned(app), (e) =>
              e
                .child(IconButton(`pin-up-${app}`, "chevron-up", t("settings.pins.up"), { disabled: this.preview || i === 0, onClick: (_e, cx) => moveBy(app, -1, cx) }))
                .child(IconButton(`pin-down-${app}`, "chevron-down", t("settings.pins.down"), { disabled: this.preview || i >= s.pins.length - 1, onClick: (_e, cx) => moveBy(app, 1, cx) })),
            ),
        ),
      );
  }

  /** The Assistant's folder: the path, Choose folder…, and the D22 question when a turn runs (folder.js). A relay
   *  device cannot set it: the Assistant runs only on the Mac (D5). */
  assistantFolder(s) {
    const relay = snapshotMode();
    return FolderField({
      id: "f-assistant",
      label: t("settings.assistant.folder"),
      path: s.assistant?.folder ?? null,
      unset: t("settings.assistant.unset"),
      hint: relay ? t("settings.assistant.relay") : this.hint("assistant", t("settings.assistant.folderHint")),
      error: this.folderError,
      button: Button("set-assistant-folder", t("settings.assistant.choose"), {
        icon: "folder-open",
        disabled: this.preview || relay,
        onClick: (_e, cx) =>
          chooseFolder(this, assistant, cx, (_cx, r) => {
            if (r?.ok) this.saved = "assistant";
          }),
      }),
    });
  }

  notifications(k, s) {
    const status = notify.systemStatus();
    const state = status.state;
    const busy = this.asking || state === "checking" || state === "unknown";
    const tone = state === "authorized" ? k.state.success : state === "disabled" ? k.text.tertiary : NEEDS_ASK.has(state) || state === "missing" ? k.state.warning : k.text.secondary;
    return v_flex()
      .gap(10)
      .child(
        CheckBox("set-notify", s.notifications.system, (on, cx) => this.save("notify", (d) => ({ ...d, notifications: { ...d.notifications, system: on } }), cx), {
          label: t("settings.notify.system"),
          disabled: this.preview,
        }),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .role("status")
          .child(busy ? Spinner({ size: 14 }) : Icon(state === "authorized" ? "circle-check" : "info", { size: 14, color: tone }))
          .child(div().flex_1().min_w(0).text_size(k.fontSize.sm).text_color(tone).child(t(notify.SYSTEM_TEXT[state] ?? notify.SYSTEM_TEXT.unknown)))
          .when(NEEDS_ASK.has(state) && !this.preview, (e) =>
            e.child(
              Button("set-notify-ask", t("settings.notify.ask"), {
                size: "sm",
                variant: "primary",
                disabled: this.asking,
                onClick: (_e, cx) => {
                  this.asking = true;
                  cx.spawn(async (cx) => {
                    try {
                      await notify.requestPermission();
                    } catch (err) {
                      log(`permission failed: ${errText(err)}`);
                    }
                    this.asking = false;
                    cx.notify();
                  });
                  cx.notify();
                },
              }),
            ),
          )
          .when(!busy && !this.preview, (e) =>
            e.child(
              Button("set-notify-check", t("settings.notify.recheck"), {
                size: "sm",
                variant: "ghost",
                icon: "refresh-cw",
                onClick: (_e, cx) => cx.spawn(async (cx) => {
                  await notify.recheck().catch(() => null);
                  cx.notify();
                }),
              }),
            ),
          ),
      );
  }

  files(k, s) {
    const zooms = PDF_ZOOMS.map((z) => ({ key: String(z), label: z === "fit" ? t("settings.pdf.fit") : `${z}%` }));
    return v_flex()
      .gap(12)
      .child(
        settingsRow(k, {
          title: t("settings.pdf.zoom"),
          hint: t("settings.pdf.zoomHint"),
          control: Segmented("set-pdf", zooms, String(s.pdf.zoom), (value, cx) => this.save("pdf", (d) => ({ ...d, pdf: { ...d.pdf, zoom: value === "fit" ? "fit" : Number(value) } }), cx), { label: t("settings.pdf.zoom") }),
        }),
      )
      .child(Field({ id: "f-editor", label: t("settings.editor.command"), hint: this.hint("editor", t("settings.editor.hint")), error: this.errors.editor, control: this.input("editor", { mono: true, a11y: t("settings.editor.command") }) }));
  }

  herdr() {
    const ready = updates()?.app?.ready;
    return h_flex()
      .gap(8)
      .flex_wrap()
      .when(Boolean(ready), (e) => e.child(Button("set-update", t("settings.herdr.update", { version: ready }), { variant: "primary", icon: "refresh-cw", disabled: this.preview, onClick: () => run("app.update") })))
      .child(Button("set-herdr", t("settings.herdr.open"), { icon: "settings", disabled: this.preview, onClick: () => run("app.settings") }))
      .child(Button("set-keys", t("settings.herdr.keys"), { icon: "keyboard", disabled: this.preview, onClick: () => run("app.help") }));
  }

  section(id, icon, title, body) {
    return v_flex().id(id).gap(10).child(SectionHeader({ icon, title })).child(body);
  }

  render(_cx) {
    const k = tokens();
    const s = store.settings();
    const overlay = props()?.overlay ?? this.props.overlay;
    const sections = [
      this.section("sec-lang", "languages", t("settings.language.section"), this.language(k, s)),
      this.section("sec-agent", "bot", t("settings.agent.section"), this.agent(k, s)),
      this.section("sec-gh", "git-pull-request", t("settings.gh.section"), this.github()),
      this.section("sec-pins", "pin", t("settings.pins.section"), this.pins(k, s)),
      this.section("sec-assistant", "bot", t("settings.assistant.section"), this.assistantFolder(s)),
      this.section("sec-notify", "bell", t("settings.notify.section"), this.notifications(k, s)),
      this.section("sec-files", "file-text", t("settings.files.section"), this.files(k, s)),
      this.section("sec-herdr", "layers", t("settings.herdr.section"), this.herdr()),
    ];
    const ask = FolderConfirm(this, assistant, s.assistant?.folder, (_cx, r) => {
      if (r?.ok) this.saved = "assistant";
    });
    return ViewRoot("lz-settings", { bg: overlay ? k.bg.popover : k.bg.card })
      .relative()
      .child(
        h_flex()
          .flex_none()
          .h(48)
          .pl(20)
          .pr(10)
          .gap(10)
          .items_center()
          .border_b(1)
          .border_color(k.line.soft)
          .child(Icon("settings", { size: 16, color: k.text.secondary }))
          .child(Text(t("settings.title"), { size: "lg", weight: "semibold" }))
          .child(div().flex_1())
          .when(this.preview, (e) => e.child(Text(t("settings.preview"), { size: "sm", tone: "tertiary" })))
          .when(Boolean(overlay), (e) => e.child(IconButton("set-close", "x", t("common.close"), { onClick: () => closeOverlay(overlay) }))),
      )
      .child(
        v_flex()
          .id("set-scroll")
          .flex_1()
          .min_h(0)
          .px(20)
          .py(16)
          .gap(18)
          .overflow_y_scrollbar()
          .children(sections.flatMap((sec, i) => (i ? [Divider(), sec] : [sec]))),
      )
      .child(
        h_flex()
          .flex_none()
          .h(36)
          .px(20)
          .items_center()
          .border_t(1)
          .border_color(k.line.soft)
          .child(Text(t("settings.file", { path: "data/lazuli/settings.json" }), { size: "xs", tone: "tertiary", truncate: true })),
      )
      .when(Boolean(ask), (e) => e.child(ask));
  }
}
