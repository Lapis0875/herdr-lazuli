// The Inbox's detail pane (DESIGN A3 Inbox): the selected PR's facts and actions (open, merge, rerun failed jobs, an AI
// plan, send to an agent), then what gh fetches on demand: the failing job with its tests and log tail, the unresolved
// review threads, the files. Details come from sys/gh.js `detail` (kept 180 s; render reads `peek`); plans run with
// aiRun and outlive the view (kept per PR in this module, every copy redraws when one lands).

import { div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { run, shared, setShared, pickFolder } from "herdr";
import { t } from "../core/i18n.js";
import * as gh from "../sys/gh.js";
import * as fleet from "../sys/fleet.js";
import * as store from "../sys/store.js";
import { aiRun, aiStop } from "../sys/routines.js";
import { tokens } from "../ui/tokens.js";
import { Text, Icon, Button, Chip, PrChip, CiChip, BranchChip, Spinner, Empty, Badge } from "../ui/kit.js";
import { LogBlock, PaneHeading } from "./apps/ui.js";
import { failing, runFor, planPrompt, agentPrompt } from "./apps/inbox-model.js";
import { aiReadOnly } from "./apps/agents.js";
import { ago, money, threadCount } from "./apps/fmt.js";

const list = (v) => (Array.isArray(v) ? v : []);
const PLAN_REV = "lazuli.apps.plans";

// ---------------------------------------------------------------------------------------------------------------------
// Details.

/** The detail kinds a row shows, with their arguments. */
export function kindsOf(it) {
  if (!it || it.kind === "merged") return [];
  const pr = { slug: gh.slugOf(it.pr), number: it.pr.number };
  const out = [["threads", pr], ["files", pr]];
  // The failing check's own Actions job (else its runs, its commit, its branch), as sys/gh.js picks it for this PR.
  const ci = (it.kind === "ci" || failing(it.pr)) ? gh.ciArgs(it.pr) : null;
  if (ci) out.unshift(["failed", ci], ["log", ci]);
  return out;
}

const asked = new Map();
const keyOf = (kind, args) => `${kind} ${JSON.stringify(args)}`;

/** Asks gh for the row's details that are not kept; redraws the asking copy as each lands. */
export function ensureDetails(cx, it) {
  for (const [kind, args] of kindsOf(it)) {
    const key = keyOf(kind, args);
    if (gh.peek(kind, args) || asked.get(key)?.loading) continue;
    const was = asked.get(key);
    if (was?.error && Date.now() - was.at < 60000) continue;
    asked.set(key, { loading: true });
    cx.spawn(async (cx) => {
      const r = await gh.detail(kind, args);
      asked.set(key, r.error ? { error: r.error, at: Date.now() } : { at: Date.now() });
      try {
        cx.notify();
      } catch {
        // The view closed meanwhile.
      }
    });
  }
}

/** A detail as render sees it: `{value, loading, error}`. */
function detail(kind, args) {
  const kept = gh.peek(kind, args);
  const a = asked.get(keyOf(kind, args));
  return { value: kept?.value ?? null, loading: Boolean(a?.loading), error: a?.error ?? null };
}

/** The details a prompt quotes: `{failed, log, threads}` values. */
export function detailsFor(it) {
  const out = {};
  for (const [kind, args] of kindsOf(it)) out[kind] = gh.peek(kind, args)?.value ?? null;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans.

const plans = new Map();
const bumpPlans = () => setShared(PLAN_REV, (Number(shared(PLAN_REV)) || 0) + 1);

/** A row's plan: `{id, token, running, fetching, text, usd, error, detail, at}`, or null. With `error` set the plan
 *  failed, and any `text` it left is incomplete. */
export const planOf = (key) => plans.get(key) ?? null;

/** The text of a row's finished, complete plan, or null: the only plan that goes on to an agent. */
export function planText(key) {
  const p = planOf(key);
  return p && !p.running && !p.error && p.text ? p.text : null;
}

/** The PR's checkout, verified: the folder of an agent whose branch and GitHub remote sys/fleet.js matched to this very
 *  PR (its head repo and branch). `{cwd, space, local}` (`local`: on this machine), or null: a folder merely in the
 *  same repo may be on another branch or another fork's checkout. */
export function checkoutOf(pr) {
  const row = fleet.rows().find((a) => a.pr?.url && a.pr.url === pr?.url && a.cwd);
  return row ? { cwd: row.cwd, space: row.space ?? null, local: fleet.machineOf(row.address) === null } : null;
}

/** Runs a headless agent that plans the row's work (A5), read-only: it reads, it changes nothing, it runs no command.
 *  So what it reads is fetched here first, by lazuli's own gh: the PR's diff (`gh.detail("diff")`), beside the CI
 *  and review details already kept. A diff that cannot be loaded starts no plan (`diff-failed`); an agent that cannot
 *  run read-only is not started (`read-only-unsupported`). The run is local: a checkout on another machine is not
 *  its folder. */
export function startPlan(cx, it) {
  if (planOf(it.key)?.running) return;
  const at = checkoutOf(it.pr);
  const cwd = at?.local ? at.cwd : null;
  const token = {};
  plans.set(it.key, { id: null, token, running: true, fetching: true, text: "", usd: null, error: null, detail: null, at: Date.now() });
  bumpPlans();
  cx.spawn(
    async (cx) => {
      const got = await gh.detail("diff", { slug: gh.slugOf(it.pr), number: it.pr.number }).catch((e) => ({ error: { message: e?.message ?? String(e) } }));
      if (planOf(it.key)?.token !== token) return;
      if (got?.error || !got?.value) {
        // The head moved twice while sys/gh.js read it: a note to try again, not a failure.
        const moved = got?.error?.kind === "moved";
        plans.set(it.key, { id: null, token, running: false, fetching: false, text: "", usd: null, error: moved ? "moved" : "diff-failed", detail: got?.error?.message ?? null, at: Date.now() });
        bumpPlans();
        return;
      }
      const r = aiRun(cx, { prompt: planPrompt(it, detailsFor(it), got.value), ...(cwd ? { cwd } : {}), timeoutMs: 15 * 60000, readOnly: true });
      plans.set(it.key, { ...planOf(it.key), id: r.id, fetching: false });
      bumpPlans();
      const out = await r.done;
      if (planOf(it.key)?.token !== token) return;
      plans.set(it.key, { id: r.id, token, running: false, fetching: false, text: out.text?.trim() ?? "", usd: out.usd ?? null, error: out.ok ? null : out.error ?? "failed", detail: null, at: Date.now() });
      bumpPlans();
    },
    { owner: null },
  );
}

/** Stops a running plan (one still loading its diff never starts). */
export function stopPlan(cx, it) {
  const p = planOf(it.key);
  if (!p?.running) return;
  if (p.id) {
    cx.spawn(async () => aiStop(p.id));
    return;
  }
  plans.set(it.key, { ...p, token: null, running: false, fetching: false, error: "stopped", at: Date.now() });
  bumpPlans();
}

/** Opens a new agent tab on the row's work (its first message is the prompt, the plan included), in the PR's verified
 *  checkout. Without one the person picks the folder first (the agent writes and pushes there); a cancelled pick
 *  starts nothing. */
export function startAgent(cx, it) {
  const prompt = agentPrompt(it, detailsFor(it), planText(it.key));
  const launch = (cwd, space) => {
    run("tab.new", { ...(space ? { space } : {}), folder: cwd, argv: store.settings().agent.command, task: prompt, focus: true });
    run("layout.select", { stack: "center", child: "work" });
  };
  const at = checkoutOf(it.pr);
  if (at) {
    launch(at.cwd, at.space);
    return;
  }
  cx.spawn(async (cx) => {
    const dir = await pickFolder({ prompt: t("inbox.agent.pickFolder", { ref: `${it.pr.repo}#${it.pr.number}`, branch: it.pr.branch ?? "" }) }).catch(() => null);
    if (dir) launch(dir, null);
    cx.notify();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawing.

function section(title, icon, count, body) {
  return v_flex().gap(6).child(PaneHeading(title, { icon, count })).children(body);
}

function state(d, emptyText) {
  if (d.loading && !d.value) return [h_flex().gap(6).items_center().child(Spinner({ size: 12 })).child(Text(t("common.loading"), { size: "sm", tone: "tertiary" }))];
  if (d.error && !d.value) return [Text(t("inbox.detail.failed", { error: d.error.message ?? d.error.kind }), { size: "sm", tone: "error" })];
  return emptyText ? [Text(emptyText, { size: "sm", tone: "tertiary" })] : [];
}

function ciPart(it) {
  const k = tokens();
  const ci = gh.ciArgs(it.pr);
  const f = detail("failed", ci);
  const log = detail("log", ci);
  const out = [];
  const ciRun = runFor(it);
  const job = f.value?.job ?? ciRun?.failed?.job;
  const step = f.value?.step ?? ciRun?.failed?.step;
  // No exact job, run or commit known for this PR (sys/gh.js asked nothing): a neutral note, not an error.
  const unknown = f.value?.source === "unavailable" || log.value?.source === "unavailable";
  out.push(
    section(t("inbox.detail.ci"), "circle-x", null, [
      job ? Text(step ? t("inbox.detail.jobStep", { job, step }) : t("inbox.detail.job", { job }), { size: "sm" }) : null,
      ...list(it.pr.failedChecks).length > 1 ? [Text(t("inbox.detail.checks", { names: it.pr.failedChecks.join(", ") }), { size: "xs", tone: "tertiary" }).whitespace_normal()] : [],
      unknown ? Text(t("inbox.detail.ciUnknown"), { size: "sm", tone: "tertiary" }).whitespace_normal() : null,
      ...(f.value ? [] : state(f)),
    ].filter(Boolean)),
  );
  const tests = list(f.value?.tests);
  if (tests.length) {
    out.push(section(t("inbox.detail.tests"), "circle-x", tests.length, tests.slice(0, 12).map((name, i) => h_flex().id(`ib-test-${i}`).gap(6).items_center().min_w(0).child(Icon("circle-x", { size: 12, color: k.state.error })).child(Text(name, { size: "sm", mono: true, truncate: true }).flex_1()))));
  }
  const lines = list(log.value?.lines);
  if (unknown && !lines.length) return out;
  out.push(section(t("inbox.detail.log"), "scroll-text", null, lines.length ? [LogBlock("ib-log", lines.slice(-60), { maxHeight: 260 })] : state(log, log.value ? t("inbox.detail.logNone") : null)));
  return out;
}

function threadsPart(it) {
  const k = tokens();
  const d = detail("threads", { slug: gh.slugOf(it.pr), number: it.pr.number });
  const threads = list(d.value?.threads);
  // `partial`: more threads than sys/gh.js pages in, or a page it could not read; the count is then a lower bound.
  const partial = d.value?.partial === true;
  const note = partial ? Text(t("inbox.detail.threadsPartial"), { size: "xs", tone: "tertiary" }).whitespace_normal() : null;
  if (!threads.length) return [section(t("inbox.detail.threads"), "message-square", partial ? "0+" : 0, partial ? [note] : state(d, d.value ? t("inbox.detail.threadsNone") : null))];
  return [
    section(
      t("inbox.detail.threads"),
      "message-square",
      partial ? `${threads.length}+` : threads.length,
      threads.slice(0, 12).map((th, i) =>
        v_flex()
          .id(`ib-thread-${i}`)
          .gap(3)
          .p(8)
          .rounded(k.radius.md)
          .bg(k.bg.raised)
          .border_1()
          .border_color(k.line.soft)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .child(Text(th.author ?? "?", { size: "xs", weight: "semibold", nowrap: true }))
              .child(Text(`${th.path ?? ""}${th.line ? `:${th.line}` : ""}`, { size: "xs", mono: true, tone: "tertiary", truncate: true }).flex_1())
              .when(th.outdated === true, (e) => e.child(Badge(t("inbox.detail.outdated"), { variant: "text", tone: "tertiary" })))
              .when(list(th.comments).length > 1, (e) => e.child(Text(t("inbox.detail.replies", { n: th.comments.length - 1 }), { size: "xs", tone: "tertiary", nowrap: true }))),
          )
          .child(Text(String(th.body ?? "").trim().split("\n").slice(0, 4).join("\n"), { size: "sm" }).whitespace_normal()),
      ).concat(note ? [note] : []),
    ),
  ];
}

function filesPart(it) {
  const k = tokens();
  const d = detail("files", { slug: gh.slugOf(it.pr), number: it.pr.number });
  const files = list(d.value?.files);
  if (!files.length) return [section(t("inbox.detail.files"), "files", 0, state(d, d.value ? t("inbox.detail.filesNone") : null))];
  const add = files.reduce((s, f) => s + (f.additions ?? 0), 0);
  const del = files.reduce((s, f) => s + (f.deletions ?? 0), 0);
  return [
    section(t("inbox.detail.files"), "files", files.length, [
      h_flex().gap(8).child(Text(`+${add}`, { size: "xs", mono: true, color: k.diff.add })).child(Text(`−${del}`, { size: "xs", mono: true, color: k.diff.remove })),
      ...files.slice(0, 60).map((f, i) =>
        h_flex()
          .id(`ib-file-${i}`)
          .h(k.row.sm)
          .gap(8)
          .items_center()
          .min_w(0)
          .child(Text(f.path ?? "", { size: "sm", mono: true, truncate: true }).flex_1())
          .child(Text(`+${f.additions ?? 0}`, { size: "xs", mono: true, color: k.diff.add }))
          .child(Text(`−${f.deletions ?? 0}`, { size: "xs", mono: true, color: k.diff.remove })),
      ),
      ...(files.length > 60 ? [Text(t("inbox.detail.moreFiles", { n: files.length - 60 }), { size: "xs", tone: "tertiary" })] : []),
    ]),
  ];
}

/** Why a plan failed, in words. */
function planError(p) {
  if (p.error === "read-only-unsupported") return t("routines.run-error.read-only-unsupported");
  if (p.error === "diff-failed") return t("inbox.plan.diffFailed", { error: p.detail || t("inbox.plan.noReason") });
  if (p.error === "stopped") return t("inbox.plan.stopped");
  return t("inbox.plan.failed", { error: p.error });
}

/** The plan pane: running (loading the diff, then planning), failed (always said, any text it left marked incomplete
 *  and never handed to an agent), or done (with the hand-off). */
function planPart(v, it) {
  const k = tokens();
  const p = planOf(it.key);
  if (!p) return [];
  const body = [];
  const again = Button("ib-plan-again", t("inbox.plan.again"), { size: "sm", variant: "ghost", icon: "sparkles", disabled: !v.live || !aiReadOnly(), tooltip: aiReadOnly() ? undefined : t("routines.run-error.read-only-unsupported"), onClick: (_e, cx) => v.plan(cx, it) });
  const text = (label) =>
    v_flex()
      .gap(4)
      .when(Boolean(label), (e) => e.child(Badge(label, { tone: "warning", icon: "triangle-alert" })))
      .child(div().p(10).rounded(k.radius.md).bg(k.bg.surface).border_1().border_color(k.line.soft).text_color(k.text.primary).text_size(k.fontSize.sm).child(TextView.markdown(`ib-plan-${it.pr.number}`, p.text).selectable(true)));
  if (p.running) {
    const label = p.fetching ? t("inbox.plan.fetching") : t("inbox.plan.running");
    body.push(
      h_flex()
        .gap(8)
        .items_center()
        .child(Spinner({ size: 12, label }))
        .child(Text(label, { size: "sm", tone: "secondary" }).flex_1())
        .child(Button("ib-plan-stop", t("inbox.plan.stop"), { size: "sm", variant: "ghost", icon: "circle-stop", onClick: (_e, cx) => stopPlan(cx, it) })),
    );
  } else if (p.error) {
    // A PR that changed while it was read is retried, not failed: a plain note.
    const retry = p.error === "moved";
    body.push(Text(retry ? t("inbox.plan.moved") : planError(p), { size: "sm", tone: retry ? "secondary" : "error" }).whitespace_normal().role(retry ? "status" : "alert"));
    if (p.text) body.push(text(t("inbox.plan.incomplete")));
    body.push(h_flex().gap(6).items_center().child(div().flex_1()).child(again));
  } else {
    body.push(text(null));
    body.push(
      h_flex()
        .gap(6)
        .flex_wrap()
        .items_center()
        .child(Text([ago(p.at), typeof p.usd === "number" ? money(p.usd) : ""].filter(Boolean).join(" · "), { size: "xs", tone: "tertiary" }))
        .child(div().flex_1())
        .child(again)
        .child(Button("ib-plan-agent", t("inbox.plan.newAgent"), { size: "sm", icon: "play", disabled: !v.live, onClick: (_e, cx) => v.startAgent(cx, it) })),
    );
  }
  return [section(t("inbox.plan.title"), "map", null, body)];
}

function chips(it) {
  const pr = it.pr;
  const out = [];
  if (it.kind === "merged") return [Chip(t("inbox.chip.merged"), { icon: "git-merge", tone: "merged" })];
  if (pr.isDraft) out.push(Chip(t("inbox.chip.draft"), { icon: "git-pull-request-draft" }));
  if (it.kind === "review") out.push(Chip(pr.isDirect ? t("inbox.chip.direct") : t("inbox.chip.team"), { icon: pr.isDirect ? "user" : "users", tone: pr.isDirect ? "wait" : "default" }));
  if (pr.review === "APPROVED") out.push(Chip(t("home.chip.approved"), { icon: "check", tone: "ok" }));
  else if (pr.review === "CHANGES_REQUESTED") out.push(Chip(t("home.chip.changes"), { icon: "message-square", tone: "fail" }));
  else if (it.kind !== "review") out.push(Chip(t("inbox.chip.awaiting"), { icon: "clock" }));
  const ciRun = runFor(it);
  const ci = ciRun?.isRunning ? "running" : { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "running", EXPECTED: "pending" }[pr.ci];
  if (ci) out.push(CiChip(ci, ciRun && ci !== "pass" && ciRun.total ? t("inbox.chip.ciCount", { state: t(`home.ci.${ci}`), done: ciRun.done, total: ciRun.total }) : t(`home.ci.${ci}`)));
  if (pr.threads > 0) out.push(Chip(t("home.chip.threads", { n: threadCount(pr) }), { icon: "message-square" }));
  return out;
}

/** The pane for the selected row (null: an empty state), as the Inbox row's own flex child. `v`: the Inbox view, for
 *  its actions. */
export function DetailPane(v, it) {
  const k = tokens();
  if (!it) return v_flex().flex_1().min_w(0).min_h(0).child(Empty({ id: "ib-detail-empty", icon: "inbox", title: t("inbox.detail.none"), body: t("inbox.detail.noneBody") }));
  const pr = it.pr;
  const sub = [
    it.kind === "merged" ? t("inbox.detail.mergedAt", { time: ago(Date.parse(pr.mergedAt)) }) : pr.author ? t("inbox.detail.by", { author: pr.authorName || pr.author }) : "",
    it.kind !== "merged" && pr.updatedAt ? t("inbox.detail.updated", { time: ago(Date.parse(pr.updatedAt)) }) : "",
  ].filter(Boolean);
  const ciRun = runFor(it);
  const canRerun = Boolean(ciRun?.workflowId) && !ciRun?.isRunning && (it.kind === "ci" || failing(pr));
  const actions = h_flex()
    .flex_wrap()
    .gap(6)
    .items_center()
    .child(Button("ib-open", t("inbox.action.open"), { size: "sm", icon: "external", kbd: "O", onClick: (_e, cx) => v.open(cx, it) }))
    .when(it.kind === "mine" || it.kind === "ci", (e) => e.child(Button("ib-merge", t("inbox.action.merge"), { size: "sm", icon: "git-merge", kbd: "M", variant: pr.review === "APPROVED" && pr.ci === "SUCCESS" ? "primary" : "secondary", disabled: !v.live || pr.isDraft, tooltip: pr.isDraft ? t("inbox.action.mergeDraft") : undefined, onClick: (_e, cx) => v.askMerge(cx, it) })))
    .when(canRerun, (e) => e.child(Button("ib-rerun", t("inbox.action.rerun"), { size: "sm", icon: "refresh-cw", kbd: "R", disabled: !v.live || v.busy, onClick: (_e, cx) => v.rerun(cx, it) })))
    .when(it.kind !== "merged", (e) => e.child(Button("ib-plan", planOf(it.key) ? t("inbox.plan.again") : t("inbox.action.plan"), { size: "sm", icon: "sparkles", kbd: "P", disabled: !v.live || Boolean(planOf(it.key)?.running) || !aiReadOnly(), tooltip: aiReadOnly() ? undefined : t("routines.run-error.read-only-unsupported"), onClick: (_e, cx) => v.plan(cx, it) })))
    .child(Button("ib-send", t("inbox.action.send"), { size: "sm", icon: "send", kbd: "S", disabled: !v.live, onClick: (_e, cx) => v.askSend(cx, it) }));
  const parts = [...planPart(v, it)];
  if (it.kind === "ci" || failing(pr)) parts.push(...ciPart(it));
  if (it.kind !== "merged") parts.push(...threadsPart(it), ...filesPart(it));
  else parts.push(section(t("inbox.detail.merge"), "git-merge", null, [Text(pr.mergeSha ? t("inbox.detail.sha", { sha: pr.mergeSha.slice(0, 10) }) : "", { size: "sm", mono: true, tone: "secondary" })]));
  return v_flex()
    .id("ib-detail")
    .flex_1()
    .min_w(0)
    .min_h(0)
    .overflow_y_scrollbar()
    .child(
      v_flex()
        .p(18)
        .gap(14)
        .child(
          v_flex()
            .gap(6)
            .child(h_flex().gap(8).items_center().child(PrChip(pr.number, { state: it.kind === "merged" ? "merged" : pr.isDraft ? "draft" : "open" })).child(Text(pr.slug ?? pr.repo ?? "", { size: "sm", mono: true, tone: "tertiary", truncate: true }).flex_1()))
            .child(Text(pr.title || pr.branch || "", { size: "lg", weight: "semibold" }).whitespace_normal())
            .child(
              h_flex()
                .gap(8)
                .flex_wrap()
                .items_center()
                .when(Boolean(pr.branch), (e) => e.child(BranchChip(pr.branch)))
                .when(Boolean(pr.base), (e) => e.child(Icon("chevron-right", { size: 12, color: k.text.tertiary })).child(BranchChip(pr.base)))
                .child(Text(sub.join(" · "), { size: "sm", tone: "tertiary", truncate: true }).flex_1()),
            )
            .child(h_flex().flex_wrap().gap(4).children(chips(it))),
        )
        .child(actions)
        .children(parts),
    );
}
