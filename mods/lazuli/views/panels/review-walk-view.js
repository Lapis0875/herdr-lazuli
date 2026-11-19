// The Review panel's walkthrough mode (DESIGN A3, A5): the changes as steps in reading order, each explained, with
// the notes that say what accepting it signs up for; the diff below shows only the step's hunks. Before one exists
// it offers to write it (a headless agent run, sys/review-walk.js); while it runs it can be stopped; once the
// changes moved on it can be written again, and it copies as Markdown.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import { withAlpha } from "../../ui/tokens.js";
import { Text, Icon, Spinner, Button, IconButton, Badge, Card, Banner } from "../../ui/kit.js";
import { walkthrough, startWalk, stopWalk, walkMarkdown, walkModelName, walkAllowed, loadCached } from "../../sys/review-walk.js";

const NOTE_ICON = { choice: "git-branch", upkeep: "wrench", gap: "triangle-alert", divergence: "git-compare", untested: "circle-help" };
const KNOWN_ERRORS = new Set(["no-steps", "not-json", "lost", "timed-out", "checking", "no-hunks", "too-large", "running", "hc-run", "write", "start"]);
const WIDE = 640;

/** The walkthrough's steps in order, the hunks no step covers last; [] until one is done. */
export function walkSteps(read) {
  const w = walkthrough(read);
  if (w.status !== "done") return [];
  const out = [];
  w.parts.forEach((part, p) => part.steps.forEach((s) => out.push({ ...s, part: p, partTitle: part.title })));
  if (w.uncovered.length) out.push({ id: "uncovered", uncovered: true, hunks: w.uncovered.flatMap((u) => u.hunks), text: "", notes: [], weight: "skim" });
  return out;
}

const errorText = (code) =>
  code === "read-only-unsupported" ? t("routines.run-error.read-only-unsupported") : KNOWN_ERRORS.has(code) ? t(`review.walk.error.${code}`) : code;

/** Starts (or reuses) the walkthrough of a read, in a task whose context may outlive the click. */
function generate(view, read, cx) {
  cx.spawn(async (cx) => {
    await loadCached(read);
    const r = startWalk(cx, read);
    if (r.error) {
      view.say(cx, "error", errorText(r.error));
      return cx.notify();
    }
    view.step = 0;
    view.applyStep();
    cx.notify();
    await r.started;
    view.applyStep();
    cx.notify();
  });
}

function startCard(view, k, read, w) {
  // The agent reads text others wrote: it only runs when the settings' agent can be held to reading.
  const allowed = walkAllowed();
  const refusal = !allowed && w.error !== "read-only-unsupported";
  return v_flex().flex_1().min_h(0).items_center().justify_center().p(16).child(
    Card({
      id: "review-walk-start",
      tone: "panel",
      pad: 16,
      gap: 12,
      children: [
        h_flex().gap(8).items_center().child(Icon("route", { size: 16, color: k.accent })).child(Text(t("review.walk.start.title"), { size: "lg", weight: "semibold" })),
        Text(t("review.walk.start.body"), { size: "sm", tone: "secondary" }),
        ...(w.status === "failed" ? [Banner({ id: "review-walk-failed", tone: "error", title: t("review.walk.failed"), body: errorText(w.error) })] : []),
        ...(refusal ? [Banner({ id: "review-walk-readonly", tone: "warning", title: t("routines.run-error.read-only-unsupported") })] : []),
        h_flex()
          .gap(8)
          .items_center()
          .child(Text(t("review.walk.model", { model: walkModelName() }), { size: "xs", tone: "tertiary", truncate: true }).flex_1())
          .child(
            Button("review-walk-go", t(w.status === "failed" ? "common.retry" : "review.walk.generate"), {
              variant: "primary",
              size: "sm",
              icon: "sparkles",
              disabled: view.preview || !allowed,
              tooltip: allowed ? undefined : t("routines.run-error.read-only-unsupported"),
              onClick: (_e, cx) => generate(view, read, cx),
            }),
          ),
      ],
    }).max_w(460),
  );
}

function runningState(view, k, read, w) {
  return v_flex()
    .flex_1()
    .items_center()
    .justify_center()
    .gap(10)
    .p(16)
    .child(Spinner({ size: 20, label: t("review.walk.running", { model: w.model }) }))
    .child(Text(t("review.walk.running", { model: w.model }), { weight: "medium" }))
    .child(Text(t("review.walk.background"), { size: "sm", tone: "secondary" }).max_w(320).text_center())
    .child(
      Button("review-walk-stop", t("review.walk.stop"), {
        size: "sm",
        icon: "circle-stop",
        disabled: view.preview,
        onClick: (_e, cx) => {
          cx.spawn(async (cx) => {
            await stopWalk(read);
            cx.notify();
          });
        },
      }),
    );
}

function stepList(view, k, steps, w) {
  const rows = [];
  steps.forEach((st, i) => {
    if (!st.uncovered && (i === 0 || steps[i - 1].part !== st.part)) {
      rows.push(Text(st.partTitle ?? t("review.walk.part", { n: st.part + 1 }), { size: "xs", tone: "tertiary", weight: "medium", truncate: true }).px(8).pt(i ? 10 : 2).pb(2));
    } else if (st.uncovered) rows.push(div().h(1).mx(8).my(6).bg(k.line.soft));
    const on = i === view.step;
    const pick = (cx) => {
      view.step = i;
      view.showSteps = false;
      view.applyStep();
      cx.notify();
    };
    rows.push(
      h_flex()
        .id(`review-step-${i}`)
        .min_h(30)
        .px(8)
        .py(4)
        .gap(8)
        .items_center()
        .rounded(k.radius.md)
        .cursor_pointer()
        .role("list_item")
        .aria_selected(on)
        .tab_index(0)
        .bg(on ? k.bg.selected : withAlpha(k.bg.card, 0))
        .hover((s) => s.bg(on ? k.bg.selected : k.bg.hover))
        .focus((s) => s.bg(on ? k.bg.selected : k.bg.hover))
        .on_click((_e, cx) => pick(cx))
        .on_key_down((e, cx) => {
          if (e.keystroke !== "enter" && e.keystroke !== "space") return;
          cx.stop_propagation();
          pick(cx);
        })
        .child(Text(st.uncovered ? "·" : String(i + 1), { size: "xs", tone: "tertiary", mono: true }).w(18).flex_none())
        .child(Text(st.uncovered ? t("review.walk.uncovered") : st.title ?? t("review.walk.step", { n: i + 1 }), { size: "sm", weight: on ? "medium" : undefined, truncate: true }).flex_1())
        .when(st.weight === "key", (e) => e.child(Badge(t("review.walk.key"), { tone: "info" })))
        .when(Boolean(st.outdated), (e) => e.child(Badge(t("review.walk.outdated"), { tone: "warning" }))),
    );
  });
  const cost = w.cost ? ` · $${Number(w.cost).toFixed(3)}` : "";
  return v_flex()
    .id("review-steps")
    .flex_1()
    .min_h(0)
    .child(
      v_flex()
        .id("review-steps-list")
        .flex_1()
        .min_h(0)
        .p(6)
        .gap(1)
        .overflow_y_scrollbar()
        .role("list")
        .child(v_flex().gap(4).p(8).child(Text(w.title ?? t("review.walk.title"), { weight: "semibold" })).child(Text(w.summary ?? "", { size: "sm", tone: "secondary" })))
        .children(rows),
    )
    .child(Text(`${w.model}${cost}`, { size: "xs", tone: "tertiary", truncate: true }).flex_none().px(14).py(6));
}

function stepDetail(view, k, read, w, s, steps, cx, narrow) {
  const n = steps.length;
  const head = h_flex()
    .gap(6)
    .items_center()
    .child(IconButton("review-step-prev", "chevron-left", t("review.walk.prev"), { disabled: view.step === 0, onClick: (_e, cx) => { view.moveStep(-1); cx.notify(); } }))
    .child(
      narrow
        ? Button("review-step-list", `${view.step + 1} / ${n}`, { variant: "ghost", size: "sm", tooltip: t("review.walk.list"), onClick: (_e, cx) => { view.showSteps = !view.showSteps; cx.notify(); } })
        : Text(`${view.step + 1} / ${n}`, { size: "xs", tone: "tertiary", mono: true, nowrap: true }),
    )
    .child(IconButton("review-step-next", "chevron-right", t("review.walk.next"), { disabled: view.step >= n - 1, onClick: (_e, cx) => { view.moveStep(1); cx.notify(); } }))
    .child(Text(s.uncovered ? t("review.walk.uncovered") : s.title ?? t("review.walk.step", { n: view.step + 1 }), { weight: "semibold", truncate: true }).flex_1())
    .when(s.weight === "skim" && !s.uncovered, (e) => e.child(Badge(t("review.walk.skim"))))
    .when(!w.fresh && !view.preview, (e) =>
      e.child(
        IconButton("review-walk-regen", "refresh-cw", t("review.walk.regenerate"), {
          disabled: !walkAllowed(),
          tooltip: walkAllowed() ? t("review.walk.regenerate") : t("routines.run-error.read-only-unsupported"),
          onClick: (_e, cx) => generate(view, read, cx),
        }),
      ),
    )
    .child(
      IconButton("review-walk-copy", "copy", t("review.walk.copy"), {
        onClick: (_e, cx) => {
          cx.write_to_clipboard(walkMarkdown(w));
          view.say(cx, "success", t("review.walk.copied"));
          cx.notify();
        },
      }),
    );
  const notes = (s.notes ?? []).map((note) =>
    h_flex()
      .gap(8)
      .p(8)
      .items_start()
      .rounded(k.radius.md)
      .bg(withAlpha(k.state.warning, 0.1))
      .child(Icon(NOTE_ICON[note.kind] ?? "info", { size: 14, color: k.state.warning }).mt(3))
      .child(v_flex().flex_1().min_w(0).gap(2).child(Text(t(`review.note.${note.kind}`), { size: "sm", weight: "medium" })).child(Text(note.text, { size: "sm" }))),
  );
  const uncovered = s.uncovered
    ? (w.uncovered ?? []).map((u) =>
        v_flex()
          .gap(2)
          .child(Text(u.path, { size: "xs", tone: "secondary", mono: true, truncate: true }))
          .when(Boolean(u.note) || u.generated, (e) => e.child(Text(u.note || t("review.walk.generated"), { size: "sm" }))),
      )
    : [];
  const detail = v_flex()
    .id("review-step-detail")
    .flex_none()
    .max_h(narrow ? 260 : 320)
    .overflow_y_scrollbar()
    .gap(8)
    .p(12)
    .border_b_1()
    .border_color(k.line.soft)
    .child(head)
    .when(Boolean(s.text), (e) => e.child(Text(s.text)))
    .children(uncovered)
    .children(notes)
    .when(Boolean(s.outdated), (e) => e.child(Text(t("review.walk.moved", { count: s.missing }), { size: "xs", tone: "warning" })));
  const body = narrow && view.showSteps ? stepList(view, k, steps, w) : view.diff.render({ narrow });
  return v_flex().flex_1().min_w(0).min_h(0).child(detail).child(body);
}

/** The walkthrough mode's body for a read. */
export function WalkBody(view, k, read, cx) {
  const w = walkthrough(read);
  if (w.status === "none" || w.status === "failed") return startCard(view, k, read, w);
  if (w.status === "running") return runningState(view, k, read, w);
  const steps = walkSteps(read);
  if (!steps.length) return startCard(view, k, read, { status: "failed", error: "no-steps" });
  const s = steps[Math.min(view.step, steps.length - 1)];
  const detail = stepDetail(view, k, read, w, s, steps, cx, view.width < WIDE);
  if (view.width < WIDE) return detail;
  return h_flex()
    .flex_1()
    .min_h(0)
    .child(v_flex().w(240).flex_none().h_full().border_r_1().border_color(k.line.soft).child(stepList(view, k, steps, w)))
    .child(detail);
}
