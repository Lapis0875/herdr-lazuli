// Creating and changing a routine (DESIGN A3 Routines; the fields of ARCHITECTURE §4.6): name, when (with presets and
// its next runs read back as you type), agent or shell, agent, model, mode, tools, weekly budget, folder, timeout,
// notify, catch-up, paused, worktree, and the prompt or script. A new routine's whole file is written once, only when
// no file of its name exists; a change rewrites the file's front matter (fields it does not manage stay) and body in
// one write, refused when the file changed since it was read. An `agent:` value stays exactly as written (an alias like
// `claude-code`, or one lazuli does not know) until the person picks another agent.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, TextareaState, Textarea } from "gpui-base";
import { pickFolder } from "herdr";
import { t } from "../core/i18n.js";
import * as routines from "../sys/routines.js";
import * as store from "../sys/store.js";
import { frontMatter, parseWhen, describeWhen, slugFor } from "../core/routine-file.js";
import { nextRuns } from "../core/routine-sched.js";
import { tokens, withAlpha } from "../ui/tokens.js";
import { Text, Icon, Button, IconButton, Chip, TextInput, Field, Segmented, CheckBox, trackFocus } from "../ui/kit.js";
import { whenText } from "./apps/routine-text.js";
import { when as whenAt } from "./apps/fmt.js";

const PRESETS = ["every 30m", "hourly", "weekdays 09:00", "daily 09:00", "mon 09:00", "fri 16:00", "on ci-failed", "on review", "manual"];
const AGENTS = ["", "omp", "claude", "codex"];
/** The `agent:` values the scheduler takes, as it reads them (sys/routines.js AGENT_IDS): each to the choice it is. */
const AGENT_ALIASES = Object.freeze({ omp: "omp", claude: "claude", "claude-code": "claude", codex: "codex" });
/** The choice standing for an `agent:` value lazuli does not know, kept as the file has it. */
const AS_WRITTEN = "as-written";
const NOTIFY = ["always", "failed", "never"];
/** File names a new routine tries when the ones before it turn out to be taken. */
const MAX_NAME_TRIES = 20;
/** Text fields and the front-matter key each writes. */
const TEXT_FIELDS = Object.freeze({ name: "name", when: "when", model: "model", mode: "mode", tools: "tools", budget: "budget", cwd: "cwd", timeout: "timeout", catchUp: "catch-up" });
const stop = (_e, cx) => cx.stop_propagation();

/** The text with its front matter set to `fields` ({key: value}; "" removes a key), the other keys kept, and the body. */
export function withFields(text, fields, body) {
  const fm = frontMatter(text ?? "");
  const done = new Set();
  const out = ["---"];
  for (const [k, v] of fm.fields) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) {
      if (!done.has(k) && fields[k] !== "") out.push(`${k}: ${fields[k]}`);
      done.add(k);
    } else out.push(`${k}: ${v}`);
  }
  for (const [k, v] of Object.entries(fields)) if (!done.has(k) && v !== "") out.push(`${k}: ${v}`);
  out.push("---", "", String(body ?? "").trim());
  return `${out.join("\n")}\n`;
}

export class RoutineForm {
  /** Makes the form's text states; call it in the view's init. */
  constructor() {
    this.open = false;
    this.slug = null;
    this.error = null;
    this.saving = false;
    this.kind = "agent";
    // The agent choice ("" default, an id, or AS_WRITTEN), the file's `agent:` text verbatim, and whether the person
    // changed the choice: an untouched choice writes the file's text back unchanged (`claude-code` stays itself).
    this.agent = "";
    this.agentText = "";
    this.agentTouched = false;
    this.notify = "always";
    this.paused = false;
    this.worktree = false;
    this.inputs = {
      name: InputState.new({ placeholder: t("routines.form.namePlaceholder") }),
      when: InputState.new({ placeholder: t("routines.form.whenPlaceholder") }),
      model: InputState.new({ placeholder: t("routines.form.modelPlaceholder") }),
      mode: InputState.new({ placeholder: t("routines.form.modePlaceholder") }),
      tools: InputState.new({ placeholder: t("routines.form.toolsPlaceholder") }),
      budget: InputState.new({ placeholder: t("routines.form.budgetPlaceholder") }),
      cwd: InputState.new({ placeholder: t("routines.form.cwdPlaceholder") }),
      timeout: InputState.new({ placeholder: "30" }),
      catchUp: InputState.new({ placeholder: t("routines.form.catchUpPlaceholder") }),
    };
    this.focus = Object.fromEntries(Object.entries(this.inputs).map(([key, s]) => [key, trackFocus(s)]));
    this.body = TextareaState.new({ placeholder: t("routines.form.bodyPlaceholder"), rows: 8 });
    this.body.set_auto_grow(6, 16);
    this.bodyFocus = trackFocus(this.body);
    this.inputs.when.on("change", (_e, cx) => cx.notify());
  }

  /** Opens the form: empty for a new routine, filled from the file for `slug`. */
  show(cx, slug, onDone) {
    this.open = true;
    this.slug = slug ?? null;
    this.error = null;
    this.saving = false;
    this.text = null;
    this.onDone = onDone;
    this.kind = "agent";
    this.agent = "";
    this.agentText = "";
    this.agentTouched = false;
    this.notify = "always";
    this.paused = false;
    this.worktree = false;
    for (const [key, s] of Object.entries(this.inputs)) s.set_value(key === "when" && !slug ? "weekdays 09:00" : "");
    this.body.set_value("");
    if (!slug) {
      this.inputs.name.focus();
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      const text = await routines.readFile(slug).catch(() => null);
      if (!this.open || this.slug !== slug) return;
      if (text == null) {
        this.error = t("routines.form.gone");
        cx.notify();
        return;
      }
      this.text = text;
      const fm = frontMatter(text);
      const get = (key) => {
        for (let i = fm.fields.length - 1; i >= 0; i--) if (fm.fields[i][0] === key) return fm.fields[i][1];
        return "";
      };
      for (const [field, key] of Object.entries(TEXT_FIELDS)) this.inputs[field].set_value(get(key));
      this.kind = get("run").toLowerCase() === "shell" ? "shell" : "agent";
      const agent = get("agent");
      this.agentText = agent;
      this.agent = agent === "" ? "" : AGENT_ALIASES[agent.toLowerCase()] ?? AS_WRITTEN;
      const n = get("notify").toLowerCase();
      this.notify = ["never", "no", "off"].includes(n) ? "never" : ["failed", "failures", "errors"].includes(n) ? "failed" : "always";
      const truthy = (key) => ["true", "yes", "on", "1"].includes(get(key).toLowerCase());
      this.paused = truthy("paused");
      this.worktree = truthy("worktree");
      this.body.set_value(fm.body);
      this.body.focus();
      cx.notify();
    });
    cx.notify();
  }

  close(cx) {
    this.open = false;
    cx.notify();
  }

  /** The front-matter fields the form writes. */
  fields() {
    const v = (key) => this.inputs[key].value().trim();
    const out = {};
    for (const [field, key] of Object.entries(TEXT_FIELDS)) out[key] = v(field);
    out.run = this.kind === "shell" ? "shell" : "";
    out.agent = !this.agentTouched || this.agent === AS_WRITTEN ? this.agentText : this.agent;
    out.notify = this.notify === "always" ? "" : this.notify;
    out.paused = this.paused ? "true" : "";
    out.worktree = this.worktree ? "true" : "";
    return out;
  }

  /** What is wrong with the form, or null. */
  problem() {
    const w = parseWhen(this.inputs.when.value());
    if (w.error) return whenText(describeWhen(w, this.inputs.when.value()));
    if (!this.body.value().trim()) return this.kind === "shell" ? t("routines.form.noScript") : t("routines.form.noPrompt");
    const timeout = this.inputs.timeout.value().trim().replace(/m+$/, "");
    if (timeout && !/^\+?\d+$/.test(timeout)) return t("routines.form.badTimeout");
    if (timeout && Number(timeout) <= 0) return t("routines.form.badTimeout");
    return null;
  }

  save(cx) {
    if (this.saving) return;
    const problem = this.problem();
    if (problem) {
      this.error = problem;
      cx.notify();
      return;
    }
    const fields = this.fields();
    const body = this.body.value();
    const isNew = !this.slug;
    this.saving = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const slug = isNew ? await this.createWhole(fields, body) : await this.saveWhole(fields, body);
        this.open = false;
        this.saving = false;
        this.onDone?.(cx, slug, isNew);
      } catch (e) {
        this.saving = false;
        this.error = t("routines.form.saveFailed", { error: e?.message ?? String(e) });
      }
      cx.notify();
    });
    cx.notify();
  }

  /** A new routine: its whole definition (every field, the body) written once, to a file name nobody holds. The
   *  write is conditional (`expected` null refuses an existing file), so a failure leaves no half-made routine. */
  async createWhole(fields, body) {
    const name = fields.name || t("routines.form.untitled");
    const text = withFields("", { ...fields, name }, body);
    const taken = new Set((routines.data()?.routines ?? []).map((r) => r.slug));
    for (let tries = 0; tries < MAX_NAME_TRIES; tries++) {
      const slug = slugFor(name, [...taken]);
      try {
        await routines.saveFile(slug, text, null);
        return slug;
      } catch (e) {
        // Refused because a file of that name exists (one the list did not show yet): the next name.
        if ((await routines.readFile(slug).catch(() => null)) == null) throw e;
        taken.add(slug);
      }
    }
    throw new Error(t("routines.form.noName"));
  }

  /** An existing routine: its front matter and body rewritten in one write, refused when the file changed since it
   *  was read. An empty name keeps the one the file has. */
  async saveWhole(fields, body) {
    if (this.text == null) throw new Error(t("routines.form.gone"));
    const before = this.text;
    const name = fields.name || frontMatter(before).fields.find(([k]) => k === "name")?.[1] || "";
    const after = withFields(before, { ...fields, name }, body);
    if (after !== before) await routines.saveFile(this.slug, after, this.text);
    return this.slug;
  }

  pickFolder(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: t("routines.form.pick") }).catch(() => null);
      if (dir) this.inputs.cwd.set_value(dir);
      cx.notify();
    });
  }

  /** Keys while the form shows: esc closes, ⌘⏎ saves. True when it took the key. */
  key(e, cx) {
    if (e.keystroke === "escape") {
      this.close(cx);
      return true;
    }
    if (e.keystroke === "cmd-enter") {
      this.save(cx);
      return true;
    }
    return false;
  }

  // Drawing.

  preview() {
    const k = tokens();
    const text = this.inputs.when.value();
    const w = parseWhen(text);
    const said = whenText(describeWhen(w, text));
    if (w.error) return h_flex().gap(6).items_center().child(Icon("triangle-alert", { size: 13, color: k.state.error })).child(Text(said, { size: "sm", tone: "error" }).flex_1().whitespace_normal());
    const now = Date.now();
    const next = nextRuns({ slug: "\u0000preview", when: w, paused: false }, { marks: {} }, now, 3);
    return h_flex()
      .gap(6)
      .flex_wrap()
      .items_center()
      .child(Icon("calendar-clock", { size: 13, color: k.state.success }))
      .child(Text(said, { size: "sm" }))
      .children(next.map((at, i) => Chip(whenAt(at, now), { mono: true, tone: i === 0 ? "pr" : "default" })))
      .when(w.kind === "every", (e) => e.child(Text(t("routines.form.fromLast"), { size: "xs", tone: "tertiary" })));
  }

  input(key, opts = {}) {
    return TextInput(this.inputs[key], { id: `rf-${key}`, focused: this.focus[key].focused, ...opts });
  }

  render() {
    const k = tokens();
    const command = store.settings().agent.command?.[0] ?? "omp";
    const agentItems = AGENTS.map((id) => ({ key: id || "default", label: id ? t(`routines.agent.${id}`) : t("routines.form.agentDefault", { command }) }));
    if (this.agentText && this.agent === AS_WRITTEN) agentItems.push({ key: AS_WRITTEN, label: t("routines.form.agentAsWritten", { name: this.agentText }) });
    const pickAgent = (key, cx) => {
      this.agent = key === "default" ? "" : key;
      this.agentTouched = true;
      cx.notify();
    };
    const row = (...children) => h_flex().gap(12).items_start().children(children.map((c) => div().flex_1().min_w(0).child(c)));
    const body = v_flex()
      .id("rf-body")
      .flex_1()
      .min_h(0)
      .p(22)
      .gap(14)
      .overflow_y_scrollbar()
      .child(v_flex().gap(4).child(Text(this.slug ? t("routines.form.editTitle") : t("routines.form.newTitle"), { size: "lg", weight: "semibold" })).child(Text(t("routines.form.intro"), { size: "sm", tone: "secondary" }).whitespace_normal()))
      .child(Field({ id: "rf-f-name", label: t("routines.form.name"), control: this.input("name") }))
      .child(
        Field({
          id: "rf-f-when",
          label: t("routines.form.when"),
          control: v_flex()
            .gap(6)
            .child(h_flex().flex_wrap().gap(4).children(PRESETS.map((p) => Chip(p, { id: `rf-preset-${p}`, mono: true, tone: this.inputs.when.value().trim() === p ? "pr" : "default", onClick: (_e, cx) => (this.inputs.when.set_value(p), cx.notify()) }))))
            .child(this.input("when", { mono: true, icon: "clock", invalid: Boolean(parseWhen(this.inputs.when.value()).error) }))
            .child(this.preview()),
        }),
      )
      .child(Field({ id: "rf-f-kind", label: t("routines.form.kind"), control: Segmented("rf-kind", [{ key: "agent", label: t("routines.form.kindAgent"), icon: "bot" }, { key: "shell", label: t("routines.form.kindShell"), icon: "terminal" }], this.kind, (key, cx) => ((this.kind = key), cx.notify())) }))
      .when(this.kind === "agent", (e) =>
        e
          .child(Field({ id: "rf-f-agent", label: t("routines.form.agent"), hint: this.agent === AS_WRITTEN ? t("routines.form.agentUnknown") : undefined, control: Segmented("rf-agent", agentItems, this.agent || "default", pickAgent) }))
          .child(row(Field({ id: "rf-f-model", label: t("routines.form.model"), hint: t("routines.form.modelHint"), control: this.input("model", { mono: true }) }), Field({ id: "rf-f-mode", label: t("routines.form.mode"), hint: t("routines.form.modeHint"), control: this.input("mode", { mono: true }) })))
          .child(row(Field({ id: "rf-f-tools", label: t("routines.form.tools"), hint: t("routines.form.toolsHint"), control: this.input("tools", { mono: true }) }), Field({ id: "rf-f-budget", label: t("routines.form.budget"), hint: t("routines.form.budgetHint"), control: this.input("budget", { mono: true }) }))),
      )
      .child(
        Field({
          id: "rf-f-body",
          label: this.kind === "shell" ? t("routines.form.script") : t("routines.form.prompt"),
          control: div()
            .w_full()
            .px(10)
            .py(6)
            .rounded(k.radius.md)
            .border_1()
            .border_color(this.bodyFocus.focused ? k.accent : k.line.strong)
            .bg(k.bg.card)
            .on_click(() => this.body.focus())
            .child(Textarea.new(this.body).w_full().font_family(this.kind === "shell" ? k.fonts.mono : k.fonts.ui).text_size(k.fontSize.md).text_color(k.text.primary)),
        }),
      )
      .child(
        Field({
          id: "rf-f-cwd",
          label: t("routines.form.cwd"),
          hint: this.kind === "shell" ? t("routines.form.cwdShell") : t("routines.form.cwdAgent"),
          control: h_flex().gap(6).items_center().child(this.input("cwd", { mono: true, icon: "folder" })).child(IconButton("rf-pick", "folder", t("routines.form.pick"), { onClick: (_e, cx) => this.pickFolder(cx) })),
        }),
      )
      .child(row(Field({ id: "rf-f-timeout", label: t("routines.form.timeout"), hint: t("routines.form.timeoutHint"), control: this.input("timeout", { mono: true }) }), Field({ id: "rf-f-catchup", label: t("routines.form.catchUp"), hint: t("routines.form.catchUpHint"), control: this.input("catchUp", { mono: true }) })))
      .child(Field({ id: "rf-f-notify", label: t("routines.form.notify"), control: Segmented("rf-notify", NOTIFY.map((n) => ({ key: n, label: t(`routines.notify.${n}`) })), this.notify, (key, cx) => ((this.notify = key), cx.notify())) }))
      .child(
        v_flex()
          .gap(8)
          .child(CheckBox("rf-worktree", this.worktree, (v, cx) => ((this.worktree = v), cx.notify()), { label: t("routines.form.worktree") }))
          .child(Text(t("routines.form.worktreeHint"), { size: "xs", tone: "tertiary" }).pl(24).whitespace_normal())
          .child(CheckBox("rf-paused", this.paused, (v, cx) => ((this.paused = v), cx.notify()), { label: t("routines.form.paused") })),
      );
    const foot = h_flex()
      .flex_none()
      .px(22)
      .py(12)
      .gap(8)
      .items_center()
      .border_t(1)
      .border_color(k.line.soft)
      .when(Boolean(this.error), (e) => e.child(h_flex().flex_1().min_w(0).gap(6).items_center().role("alert").child(Icon("circle-x", { size: 13, color: k.state.error })).child(Text(this.error, { size: "sm", tone: "error" }).flex_1().whitespace_normal())))
      .when(!this.error, (e) => e.child(div().flex_1()))
      .child(Button("rf-cancel", t("common.cancel"), { variant: "ghost", kbd: "esc", onClick: (_e, cx) => this.close(cx) }))
      .child(Button("rf-save", this.slug ? t("common.save") : t("routines.form.create"), { variant: "primary", icon: this.slug ? "check" : "plus", kbd: "⌘⏎", disabled: this.saving, onClick: (_e, cx) => this.save(cx) }));
    const card = v_flex()
      .id("rf-card")
      .w(640)
      .max_w_full()
      .h_full()
      .max_h(860)
      .rounded(k.radius.lg + 2)
      .border_1()
      .border_color(k.line.soft)
      .bg(k.bg.popover)
      .shadow_lg()
      .overflow_hidden()
      .role("dialog")
      .accessibility_label(this.slug ? t("routines.form.editTitle") : t("routines.form.newTitle"))
      .on_mouse_down("left", stop)
      .child(body)
      .child(foot);
    return div()
      .id("rf-scrim")
      .absolute()
      .inset_0()
      .bg(withAlpha(k.bg.app, 0.72))
      .on_mouse_down("left", (_e, cx) => this.close(cx))
      .child(v_flex().size_full().p(20).items_center().justify_center().child(card));
  }
}
