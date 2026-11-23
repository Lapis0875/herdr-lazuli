// Canned states of the approved prototype (docs/mockups/assistant/), made the way the service makes its own: the list
// by core/assistant-list.js `buildList` from rows shaped like `mapRows`, and every chat by core/assistant-chat.js
// `reduce` over the ACP updates and service events Hermes 0.17.0 sends (docs/spikes/S9). It answers the K4 calls
// with the service's names, signatures and result shapes; preview copies (`props.preview`, `props.sample`) draw it,
// and a render harness can drive the views through it without Hermes. Nothing here talks to Hermes: a sent prompt
// ends at once with a one-line answer saying so (a turn with no answer would read as failed, K5 rule 11); a steer gets
// Hermes's acknowledgement text.
//
// Module scope is shared by every copy (ARCHITECTURE F3): one sample shows in all three views at once.
// `use(name)` switches it (`lazuli.assistant:sample:<name>`); `props().sample` pins one copy to a sample.
// Sample text is in the language lazuli shows; Hermes's own words (command descriptions, approval details, mode and
// model names, its steer acknowledgement) stay as Hermes sends them.

import { home } from "herdr";
import { language } from "../../core/i18n.js";
import { emptyChat, reduce, isRunning, canAnswer, queueHead } from "../../core/assistant-chat.js";
import { buildList } from "../../core/assistant-list.js";

/** The samples, in the prototype's order. */
export const SAMPLES = Object.freeze([
  "chat", "tools", "approval", "stopped", "new", "error",
  "checking", "gate-folder", "gate-missing", "gate-hermes", "gate-check", "gate-relay",
]);

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ID = {
  review: "7c3f2a1e-9b4d-4f6a-8e21-5d0c9a7b3e12",
  receipts: "a91d4c22-0e5f-4b8a-9c37-2f6e1d8b4a05",
  trip: "3e8b5f90-1c2d-4a7e-b6f4-8d9a0c1e2f34",
  gifts: "c5d7e9f1-2a3b-4c5d-8e7f-9a0b1c2d3e4f",
  scratch: "e2f4a6b8-c0d1-4e3f-a5b7-c9d1e3f5a7b9",
  thanks: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
  outline: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
  notes: "9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a",
  spend: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  subs: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  runs: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f",
  fresh: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
};
const PROFILE_OF = { outline: "doc-writer", notes: "doc-writer", spend: "data-analyst", subs: "data-analyst", runs: "data-analyst" };
const profileOf = (id) => PROFILE_OF[id] ?? "default";
const keyOf = (id) => `${profileOf(id)}/${ID[id]}`;

const MODELS = () => ({
  availableModels: [
    { modelId: "openai-codex:gpt-5.5", name: "gpt-5.5", description: "Provider: OpenAI Codex • current" },
    { modelId: "openai-codex:gpt-5.6-sol", name: "gpt-5.6-sol", description: "Provider: OpenAI Codex" },
    { modelId: "openai-codex:gpt-5.6-luna", name: "gpt-5.6-luna", description: "Provider: OpenAI Codex" },
    { modelId: "openai-codex:gpt-6-luna", name: "gpt-6-luna", description: "Provider: OpenAI Codex" },
  ],
  currentModelId: "openai-codex:gpt-5.5",
});

const MODES = () => ({
  availableModes: [
    { id: "default", name: "Default", description: "Ask before edits." },
    { id: "accept_edits", name: "Accept Edits", description: "Auto-allow workspace and /tmp edits; still asks for sensitive paths." },
    { id: "dont_ask", name: "Don't Ask", description: "Auto-allow file edits for this session except sensitive paths." },
  ],
  currentModeId: "default",
});

// Hermes 0.17.0's advertised commands (docs/spikes/S9/02-session-new.jsonl).
const COMMANDS = [
  { name: "help", description: "List available commands" },
  { name: "model", description: "Show current model and provider, or switch models", input: { hint: "model name to switch to" } },
  { name: "tools", description: "List available tools with descriptions" },
  { name: "context", description: "Show conversation message counts by role" },
  { name: "reset", description: "Clear conversation history" },
  { name: "compact", description: "Compress conversation context" },
  { name: "steer", description: "Inject guidance into the currently running agent turn", input: { hint: "guidance for the active turn" } },
  { name: "queue", description: "Queue a prompt to run after the current turn finishes", input: { hint: "prompt to run next" } },
  { name: "version", description: "Show Hermes version" },
];

// Hermes's approval options (acp_adapter/permissions.py:41-69); an edit approval carries two (edit_approval.py).
const OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
  { optionId: "deny_always", name: "Deny always", kind: "reject_always" },
];
const EDIT_OPTIONS = [OPTIONS[0], OPTIONS[3]];

/** The sqlite row stats of `mapRows` (core/assistant-list.js statsOf). */
const STATS = (input, output, calls, usd, status = "estimated") => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: Math.round(input * 0.2), cacheWriteTokens: 0,
  reasoningTokens: Math.round(output * 0.2), estimatedCostUsd: usd, actualCostUsd: null, costStatus: status, apiCallCount: calls,
});

/** Files of the sample folder for the @ menu (images excluded, as the service's list is). */
const FOLDER_FILES = Object.freeze(["notes.md", "todo.md", "journal/2026-11-23.md", "journal/2026-11-22.md", "inbox/ideas.md", "receipts/2026-11/summary.md", "receipts/2026-10/summary.md"]);

// ACP updates and service events, as the service feeds them to `reduce`.
const up = (update) => ({ type: "update", update });
const ev = {
  commands: () => up({ sessionUpdate: "available_commands_update", availableCommands: COMMANDS }),
  sent: (requestId, text, extra = {}) => ({ type: "prompt-sent", requestId, kind: "prompt", text, ...extra }),
  done: (requestId, stopReason = "end_turn", usage) => ({ type: "prompt-done", requestId, stopReason, ...(usage ? { usage } : {}) }),
  user: (text) => up({ sessionUpdate: "user_message_chunk", content: { type: "text", text } }),
  thought: (text) => up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }),
  said: (text) => up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
  tool: (toolCallId, kind, title, extra = {}) => up({ sessionUpdate: "tool_call", toolCallId, kind, title, status: "pending", ...extra }),
  toolSet: (toolCallId, status, extra = {}) => up({ sessionUpdate: "tool_call_update", toolCallId, status, ...extra }),
  text: (text) => ({ type: "content", content: { type: "text", text } }),
  plan: (entries) => up({ sessionUpdate: "plan", entries: entries.map(([content, status]) => ({ content, status, priority: "medium" })) }),
  usage: (used, size = 272000) => up({ sessionUpdate: "usage_update", used, size }),
  title: (title) => up({ sessionUpdate: "session_info_update", title }),
  permission: (requestId, toolCall, options) => ({ type: "permission", requestId, toolCall, options }),
  answered: (requestId, optionId) => ({ type: "permission-answered", requestId, optionId }),
  stats: (stats) => ({ type: "stats", stats }),
  queued: (text, chipId) => ({ type: "queued", text, chipId }),
  loaded: () => ({ type: "loaded", models: MODELS(), modes: MODES() }),
};

/** A chat after `steps` (`[time, event]`, in order). `live`: made in this run (else replayed from history). */
function chatOf(id, title, updatedAt, steps, { live = true } = {}) {
  const start = emptyChat(keyOf(id), { profile: profileOf(id), sessionId: ID[id], agent: "hermes", title, updatedAt, loaded: live, models: MODELS(), modes: MODES() });
  return steps.reduce((c, [t, e]) => reduce(c, e, t), start);
}

function build(name, now, ko) {
  const L = (k, e) => (ko ? k : e);
  const folder = `${home()}/Assistant`;
  let n = 0;
  const rid = () => `lz:${++n}`;

  const titles = {
    review: L("주간 회고 초안 정리", "Draft the weekly review"),
    receipts: L("11월 영수증 분류", "Sort November receipts"),
    trip: L("여행 일정 비교표", "Compare trip itineraries"),
    gifts: L("집들이 선물 목록", "Housewarming gift ideas"),
    scratch: L("scratch 폴더 정리", "Clean up the scratch folder"),
    thanks: L("올해 고마웠던 일 모으기", "Collect this year's thank-yous"),
    outline: L("분기 보고서 개요", "Q4 report outline"),
    notes: L("디자인 리뷰 회의록 요약", "Design review notes summary"),
    spend: L("월별 지출 추이", "Monthly spending trend"),
    subs: L("구독 서비스 정리", "Review subscriptions"),
    runs: L("운동 기록 요약", "Summarize workout logs"),
  };
  const ages = { review: 0, receipts: 2 * HOUR, trip: 26 * HOUR, gifts: 3 * DAY, scratch: 15 * MIN, thanks: 5 * MIN, outline: 4 * DAY, notes: 11 * DAY, spend: 2 * DAY, subs: 6 * DAY, runs: 9 * DAY };
  const stats = { review: STATS(96000, 9400, 12, 0.42), receipts: STATS(47000, 4100, 7, 0.18), trip: STATS(21000, 1600, 4, 0.07), gifts: STATS(8000, 700, 2, 0.02), scratch: STATS(11000, 1200, 4, 0.05), thanks: STATS(28900, 604, 3, null, "unknown"), outline: STATS(15000, 1900, 3, 0.06), notes: STATS(9000, 500, 2, 0.03), spend: STATS(30000, 2100, 5, 0.11), subs: STATS(7000, 600, 2, 0.02), runs: STATS(6000, 400, 2, 0.02) };

  // Finished chats the list holds; selecting one shows its replay.
  const replays = {
    review: [L("notes.md로 주간 회고 초안을 써 줘", "Draft a weekly review from notes.md"), L("초안을 `review/2026-w47.md`에 저장했습니다.", "I saved the draft as `review/2026-w47.md`.")],
    receipts: [L("receipts 폴더에 있는 11월 영수증을 정리해 줘", "Sort out the November receipts in the receipts folder"), L("11월 영수증 **7건**, 합계 **₩182,400**입니다.", "**7 receipts** for November, **₩182,400** in total.")],
    trip: [
      L("부산과 강릉 2박 일정을 비용과 이동 시간으로 비교해 줘", "Compare two nights in Busan and Gangneung by cost and travel time"),
      L(
        "| | 부산 | 강릉 |\n|---|---|---|\n| KTX 왕복 | ₩119,600 · 2시간 40분 | ₩55,200 · 1시간 50분 |\n| 숙소 2박 | ₩210,000 | ₩180,000 |\n| 합계 | **₩329,600** | **₩235,200** |\n\n이동이 짧고 저렴한 쪽은 **강릉**입니다.",
        "| | Busan | Gangneung |\n|---|---|---|\n| KTX return | ₩119,600 · 2h 40m | ₩55,200 · 1h 50m |\n| Two nights | ₩210,000 | ₩180,000 |\n| Total | **₩329,600** | **₩235,200** |\n\n**Gangneung** is shorter to reach and cheaper.",
      ),
    ],
    gifts: [L("예산 5만 원 안에서 집들이 선물 다섯 개만 추천해 줘", "Suggest five housewarming gifts under ₩50,000"), L("1. 디퓨저 세트\n2. 원두와 드리퍼\n3. 리넨 행주 세트\n4. 작은 화분\n5. 캔들 워머", "1. A diffuser set\n2. Coffee beans and a dripper\n3. Linen dish towels\n4. A small potted plant\n5. A candle warmer")],
    scratch: [L("scratch 폴더에 뭐가 있는지 알려 줘", "Tell me what is in the scratch folder"), L("임시 파일 14개, 모두 지난달 것입니다.", "14 temporary files, all from last month.")],
    thanks: [L("journal 폴더에서 올해 고마웠던 일을 30개 뽑아 줘", "Pick 30 things I was grateful for this year from the journal folder"), L("journal에서 41건을 찾았습니다.", "I found 41 entries in the journal.")],
    outline: [L("분기 보고서 목차를 잡아 줘", "Outline the Q4 report"), L("## 목차\n1. 요약\n2. 지표\n3. 다음 분기 계획", "## Outline\n1. Summary\n2. Metrics\n3. Next quarter")],
    notes: [L("디자인 리뷰 회의록을 세 줄로 요약해 줘", "Summarize the design review notes in three lines"), L("- 사이드바 밀도 유지\n- 아이콘 선 굵기 1.75\n- 다크 모드 대비 재측정", "- Keep the sidebar density\n- Icon stroke 1.75\n- Re-measure dark-mode contrast")],
    spend: [L("올해 월별 지출 추이를 정리해 줘", "Lay out this year's monthly spending"), L("가장 많이 쓴 달은 **8월**입니다.", "The biggest month was **August**.")],
    subs: [L("구독 서비스 목록을 정리해 줘", "List my subscriptions"), L("구독 6개, 월 ₩58,900입니다.", "Six subscriptions, ₩58,900 a month.")],
    runs: [L("이번 달 운동 기록을 요약해 줘", "Summarize this month's workouts"), L("12회, 총 54km를 달렸습니다.", "12 runs, 54 km in total.")],
  };
  const replay = (id) => {
    const at = now - ages[id];
    const [asked, answer] = replays[id];
    return chatOf(id, titles[id], at, [[at, ev.user(asked)], [at, ev.said(answer)], [at, ev.loaded()], [at, ev.commands()], [at, ev.usage(18600)], [at, ev.stats(stats[id])]], { live: false });
  };

  const todoOld = L("# 할 일\n\n- [x] 디자인 리뷰 메모 정리\n- [ ] 영수증 스캔\n- [ ] 여행 숙소 예약\n", "# To-do\n\n- [x] Tidy the design review notes\n- [ ] Scan receipts\n- [ ] Book trip lodging\n");

  /** A whole sample state: `sessions` (chats by key; others replay), `rows` (default's ids, newest first after
   *  buildList's sort), `local` sessions made this run, the selection, bridges and collapsed groups. */
  const make = ({ chats = [], selected, local = [], bridges = {}, collapsed = ["data-analyst"], extraRows = {} }) => {
    const sessions = {};
    for (const id of Object.keys(replays)) sessions[keyOf(id)] = replay(id);
    for (const c of chats) sessions[c.key] = c;
    const row = (id) => ({ id: ID[id], title: titles[id], cwd: folder, model: "openai-codex:gpt-5.5", messageCount: 2, startedAt: now - ages[id] - HOUR, updatedAt: now - ages[id], stats: stats[id], ...(extraRows[id] ?? {}) });
    return {
      gate: "ok",
      gateDetail: null,
      folder,
      hermes: { path: `${home()}/.local/bin/hermes`, version: "0.17.0" },
      bridges: { default: { state: "ready" }, "doc-writer": { state: "off" }, "data-analyst": { state: "error", error: "bridge-launch-failed" }, ...bridges },
      sessions,
      notices: [],
      // What buildList is fed (snapshot() derives `list` from it on every call).
      source: {
        profiles: [
          { profile: "default", rows: ["review", "receipts", "trip", "gifts", "scratch", "thanks"].map(row) },
          { profile: "doc-writer", rows: ["outline", "notes"].map(row) },
          { profile: "data-analyst", rows: ["spend", "subs", "runs"].map(row) },
          ...["accessibility-auditor", "api-designer", "architect", "backend-engineer", "code-reviewer", "debugger", "devops-engineer", "frontend-engineer", "performance-optimizer", "prompt-engineer", "sql-expert", "test-writer"].map((profile) => ({ profile, rows: [] })),
        ],
        local,
        ui: { v: 1, folder, selected: selected ? { agent: "hermes", profile: profileOf(selected), session: ID[selected] } : null, collapsed },
      },
    };
  };
  const gate = (g, detail = null, extra = {}) => ({
    state: { gate: g, gateDetail: detail, folder: g === "no-folder" ? null : folder, hermes: null, bridges: {}, sessions: {}, notices: [], source: null, ...extra },
    view: {},
  });

  switch (name) {
    case "chat": {
      const t0 = now - 42 * SEC;
      const [p, s] = [rid(), rid()];
      const c = chatOf("review", titles.review, now, [
        [t0, ev.commands()],
        [t0, ev.sent(p, L("notes.md로 주간 회고 초안을 쓰고, 다음 주 할 일은 todo.md에 정리해 줘", "Draft a weekly review from notes.md and put next week's to-dos in todo.md"))],
        [t0 + 1 * SEC, ev.plan([[L("노트에서 이번 주 항목 모으기", "Collect this week's entries from the notes"), "in_progress"], [L("todo.md에 다음 주 할 일 정리", "Put next week's to-dos in todo.md"), "pending"], [L("회고 초안 쓰기", "Write the review draft"), "pending"]])],
        [t0 + 2 * SEC, ev.thought(L("notes.md를 먼저 읽고 날짜별로 묶자. 할 일은 todo.md 맨 아래 목록에 넣으면 된다.", "Read notes.md first and group it by day. The to-dos go in the list at the end of todo.md."))],
        [t0 + 4 * SEC, ev.tool("call_read_1", "read", L("notes.md 읽기", "Read notes.md"), { locations: [{ path: "notes.md" }], rawInput: { path: "notes.md" } })],
        [t0 + 4.2 * SEC, ev.toolSet("call_read_1", "completed")],
        [t0 + 12 * SEC, ev.tool("call_edit_1", "edit", L("todo.md 수정", "Edit todo.md"), {
          locations: [{ path: "todo.md" }],
          content: [{ type: "diff", path: "todo.md", oldText: todoOld, newText: L("# 할 일\n\n- [x] 디자인 리뷰 메모 정리\n- [ ] 11월 영수증 분류 (금요일까지)\n- [ ] 분기 보고서 개요 공유\n- [ ] 여행 숙소 예약\n", "# To-do\n\n- [x] Tidy the design review notes\n- [ ] Sort November receipts (by Friday)\n- [ ] Share the Q4 report outline\n- [ ] Book trip lodging\n") }],
        })],
        [t0 + 13.1 * SEC, ev.toolSet("call_edit_1", "completed")],
        [t0 + 14 * SEC, ev.plan([[L("노트에서 이번 주 항목 모으기", "Collect this week's entries from the notes"), "completed"], [L("todo.md에 다음 주 할 일 정리", "Put next week's to-dos in todo.md"), "completed"], [L("회고 초안 쓰기", "Write the review draft"), "in_progress"]])],
        [t0 + 20 * SEC, ev.sent(s, L("회의 얘기는 두세 줄로 줄여 줘", "Keep the meetings to two or three lines"), { kind: "steer" })],
        [t0 + 21 * SEC, ev.said(`\u23E9 Steer queued for the active turn: ${L("회의 얘기는 두세 줄로 줄여 줘", "Keep the meetings to two or three lines")}`)],
        [t0 + 21 * SEC, ev.done(s)],
        [t0 + 30 * SEC, ev.said(L("### 이번 주 회고 · 11월 17–23일\n\n**회의:** 월요일 기획, 목요일 리뷰. 결정 사항은 todo.md로 옮겼습니다.\n\n**아쉬운 일:** 여행 숙소 예약을 또 미뤄", "### Weekly review · Nov 17–23\n\n**Meetings:** Monday planning, Thursday review. Decisions moved to todo.md.\n\n**Slipped:** trip lodging is still not"))],
        [t0 + 31 * SEC, ev.queued(L("다음 주 일정도 캘린더 형식으로 정리해 줘", "Also lay out next week as a calendar"), "q1")],
        [t0 + 33 * SEC, ev.queued(L("영수증 합계도 내 줘", "Total the receipts too"), "q2")],
        [t0 + 34 * SEC, ev.usage(42100)],
        [t0 + 34 * SEC, ev.stats(stats.review)],
      ]);
      // The previous turn's usage, as its PromptResponse left it.
      c.usage = { ...c.usage, lastTurn: { inputTokens: 3200, outputTokens: 410 } };
      return { state: make({ chats: [c], selected: "review" }), view: { expand: ["tool:call_edit_1"], planOpen: true, focus: true } };
    }
    case "tools": {
      const t0 = now - 25 * SEC;
      const p = rid();
      const c = chatOf("receipts", titles.receipts, now, [
        [t0, ev.commands()],
        [t0, ev.sent(p, L("receipts 폴더에 있는 11월 영수증을 정리해 줘", "Sort out the November receipts in the receipts folder"))],
        [t0 + 2 * SEC, ev.thought(L("receipts/2026-11의 파일 이름에 날짜와 가게 이름이 들어 있다. 목록부터 보자.\n\n분류는 식비, 교통, 도서면 충분해 보인다.", "The files in receipts/2026-11 carry the date and the shop in their names. List them first.\n\nFood, transport and books look like enough categories."))],
        [t0 + 5 * SEC, ev.tool("call_ls", "execute", "ls -1 receipts/2026-11", { content: [ev.text("$ ls -1 receipts/2026-11")] })],
        [t0 + 6.5 * SEC, ev.toolSet("call_ls", "completed", { content: [ev.text(L("2026-11-03_스타벅스.pdf\n2026-11-05_코레일.pdf\n2026-11-08_교보문고.pdf\n2026-11-12_김밥천국.pdf\n2026-11-15_코레일.pdf\n2026-11-19_스타벅스.pdf\n2026-11-21_한솥.pdf", "2026-11-03_starbucks.pdf\n2026-11-05_korail.pdf\n2026-11-08_kyobo-books.pdf\n2026-11-12_kimbap-cafe.pdf\n2026-11-15_korail.pdf\n2026-11-19_starbucks.pdf\n2026-11-21_hansot.pdf"))] })],
        [t0 + 12 * SEC, ev.said(L("11월 영수증 **7건**을 찾았습니다. 합계는 **₩182,400**입니다.\n\n- 식비 4건 · ₩96,000\n- 교통 2건 · ₩41,400\n- 도서 1건 · ₩45,000\n\n표로 만들어 `receipts/2026-11/summary.md`에 저장할까요?", "I found **7 receipts** for November, **₩182,400** in total.\n\n- Food: 4 · ₩96,000\n- Transport: 2 · ₩41,400\n- Books: 1 · ₩45,000\n\nShall I save a table to `receipts/2026-11/summary.md`?"))],
        [t0 + 13 * SEC, ev.usage(18600)],
        [t0 + 13 * SEC, ev.done(p, "end_turn", { inputTokens: 2400, outputTokens: 312, totalTokens: 2712 })],
        [t0 + 14 * SEC, ev.stats(stats.receipts)],
      ]);
      // The weekly review keeps running in the background: its row spins.
      const review = reduce(replay("review"), ev.sent(rid(), L("회고 초안을 한 번 더 다듬어 줘", "Polish the review draft once more"), { via: "prompt" }), now - 15 * SEC);
      return {
        state: make({ chats: [c, review], selected: "receipts", extraRows: { receipts: { updatedAt: now } } }),
        view: { expand: ["thought:1", "tool:call_ls"], picker: true, text: L("좋아, 저장해 줘. 지난달 표와도 비교해 줘", "Yes, save it. Compare with last month's table too"), attachments: ["receipts/2026-10/summary.md"] },
      };
    }
    case "approval": {
      const t0 = now - 145 * SEC;
      const [p1, p2] = [rid(), rid()];
      const todoNew = L(`${todoOld}- [ ] 우체국 등기 찾기\n- [ ] 세탁소 맡기기\n- [ ] 엄마께 전화\n`, `${todoOld}- [ ] Pick up the registered mail\n- [ ] Drop off the dry cleaning\n- [ ] Call Mom\n`);
      const rm = `rm -r ${folder}/scratch`;
      const c = chatOf("scratch", titles.scratch, now, [
        [t0, ev.commands()],
        [t0, ev.sent(p1, L("todo.md에 내일 할 일 세 개 추가해 줘", "Add three things for tomorrow to todo.md"))],
        [t0 + 5 * SEC, ev.tool("call_edit_2", "edit", L("todo.md 수정", "Edit todo.md"), { locations: [{ path: "todo.md" }], content: [ev.text(L("todo.md 편집 준비 중. 허가 요청에 diff가 있습니다.", "Preparing write to todo.md. Approval prompt shows the diff."))] })],
        [t0 + 6 * SEC, ev.permission("b:3", { toolCallId: "edit-approval-1", title: L("todo.md 수정", "Edit todo.md"), kind: "edit", content: [{ type: "diff", path: "todo.md", oldText: todoOld, newText: todoNew }] }, EDIT_OPTIONS)],
        [t0 + 67 * SEC, { type: "tick" }],
        [t0 + 67 * SEC, ev.toolSet("call_edit_2", "failed")],
        [t0 + 70 * SEC, ev.answered("b:3", "allow_once")],
        [t0 + 72 * SEC, ev.said(L("수정 허가를 받지 못해 todo.md는 그대로 두었습니다.", "The edit wasn't allowed, so todo.md is unchanged."))],
        [t0 + 73 * SEC, ev.done(p1, "end_turn", { inputTokens: 1100, outputTokens: 96 })],
        [t0 + 80 * SEC, ev.sent(p2, L("scratch 폴더는 지워도 돼. 비워 줘", "You can delete the scratch folder. Clear it out."))],
        [t0 + 82 * SEC, ev.plan([[L("scratch 폴더 내용 확인", "Check what is in the scratch folder"), "completed"], [L("scratch 폴더 지우기", "Delete the scratch folder"), "in_progress"]])],
        [t0 + 131 * SEC, ev.tool("call_rm", "execute", "rm -r scratch", { content: [ev.text("$ rm -r scratch")] })],
        [t0 + 131 * SEC, ev.toolSet("call_rm", "in_progress")],
        [t0 + 132 * SEC, ev.permission("b:5", { toolCallId: "perm-check-2", title: `Dangerous command: recursive delete: ${rm}`, kind: "execute", content: [ev.text(`Dangerous command: recursive delete\n$ ${rm}`)] }, OPTIONS)],
        [t0 + 132 * SEC, ev.usage(9800)],
        [t0 + 132 * SEC, ev.stats(stats.scratch)],
      ]);
      return { state: make({ chats: [c], selected: "scratch", extraRows: { scratch: { updatedAt: now } } }), view: { more: "b:5", planOpen: false } };
    }
    case "stopped": {
      const t0 = now - 60 * SEC;
      const p = rid();
      const c = chatOf("thanks", titles.thanks, now, [
        [t0, ev.commands()],
        [t0, ev.sent(p, L("journal 폴더에서 올해 고마웠던 일을 30개 뽑아 줘", "Pick 30 things I was grateful for this year from the journal folder"))],
        [t0 + 1 * SEC, ev.plan([[L("journal에서 감사 표현 찾기", "Find expressions of thanks in the journal"), "completed"], [L("30개 골라 날짜와 함께 쓰기", "Pick 30 and write them with dates"), "in_progress"], [L("월별로 묶기", "Group them by month"), "pending"]])],
        [t0 + 2 * SEC, ev.thought(L("‘고마’, ‘감사’로 찾고 날짜가 붙은 항목만 고르자.", "Search for “grateful” and “thanks”, keep only dated entries."))],
        [t0 + 5 * SEC, ev.tool("call_grep", "search", L("journal에서 ‘고마’ 검색 · 41건", "Search journal for “grateful” · 41 matches"), { rawInput: { pattern: "고마|감사", path: "journal" } })],
        [t0 + 5.6 * SEC, ev.toolSet("call_grep", "completed")],
        [t0 + 20 * SEC, ev.said(L("1. 1월 3일 · 이사를 도와준 민수\n2. 1월 18일 · 첫 하프 마라톤 완주\n3. 2월 2일 · 엄마가 보내 준 김치\n4. 2월 14일 · 팀이 마감을 하루 앞당겨 끝냄\n5. 3월 9일 · 도서관에서 찾은 절판된 책", "1. Jan 3 · Minsu helping with the move\n2. Jan 18 · Finishing my first half marathon\n3. Feb 2 · The kimchi Mom sent\n4. Feb 14 · The team finishing a day early\n5. Mar 9 · An out-of-print book at the library"))],
        [t0 + 25 * SEC, ev.queued(L("결과는 날짜순으로 정리해 줘", "Sort the results by date"), "q3")],
        [t0 + 30 * SEC, ev.done(p, "cancelled", { inputTokens: 28900, outputTokens: 604 })],
        [t0 + 30 * SEC, { type: "queue-paused" }],
        [t0 + 30 * SEC, ev.usage(31700)],
        [t0 + 31 * SEC, ev.stats(stats.thanks)],
      ]);
      return { state: make({ chats: [c], selected: "thanks", extraRows: { thanks: { updatedAt: now }, review: { updatedAt: now - 12 * MIN } } }), view: { hover: keyOf("review"), text: "/", focus: true } };
    }
    case "new": {
      const c = chatOf("fresh", null, now, [[now, ev.commands()], [now, ev.usage(11369)]]);
      return {
        state: make({ chats: [c], selected: "fresh", local: [{ profile: "default", sessionId: ID.fresh, title: null, updatedAt: now, cwd: folder }], bridges: { "doc-writer": { state: "starting" } } }),
        view: { text: "@", focus: true },
      };
    }
    case "error": {
      const t0 = now - 90 * SEC;
      const p = rid();
      let c = replay("receipts");
      c = [
        [t0, ev.sent(p, L("지난달과 비교해서 표로 저장해 줘", "Compare with last month and save a table"))],
        [t0 + 2 * SEC, { type: "prompt-failed", requestId: p, error: { code: -32603, message: "Internal error" } }],
        [t0 + 3 * SEC, { type: "disconnected" }],
      ].reduce((s, [t, e]) => reduce(s, e, t), c);
      return { state: make({ chats: [c], selected: "receipts", bridges: { default: { state: "error", error: "agent-exit" } } }), view: {} };
    }
    case "checking":
      return gate("checking");
    case "gate-folder":
      return gate("no-folder");
    case "gate-missing":
      return gate("folder-missing");
    case "gate-hermes":
      return gate("hermes-missing", { looked: ["PATH", `${home()}/.local/bin/hermes`] });
    case "gate-check":
      return gate("hermes-check-failed", {
        code: 1,
        output: "Traceback (most recent call last):\n  File \"…/acp_adapter/entry.py\", line 151, in _run_check\n    import acp  # noqa: F401\nModuleNotFoundError: No module named 'acp'",
      });
    case "gate-relay":
      return gate("relay", null, { folder: null });
    default:
      return build("chat", now, ko);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The shown sample.

let currentName = "chat";
let version = 0;
// Built samples by `${name}:${lang}`; a switch to a sample builds it afresh (its countdowns start again).
const built = new Map();

const ok = (extra = {}) => Promise.resolve({ ok: true, ...extra });
const fail = (error) => Promise.resolve({ error });

/** The sample every copy without `props().sample` shows. */
export const current = () => currentName;

/** Bumped by every switch: a view that saw an older one takes the new sample's view seed. */
export const revision = () => version;

/** Shows sample `name` in every copy (unknown names are ignored). Returns whether it switched. */
export function use(name) {
  if (!SAMPLES.includes(name)) return false;
  currentName = name;
  for (const k of [...built.keys()]) if (k.startsWith(`${name}:`)) built.delete(k);
  version++;
  return true;
}

function entry(name = currentName) {
  const lang = language();
  const id = `${name}:${lang}`;
  if (!built.has(id)) built.set(id, build(name, Date.now(), lang === "ko"));
  return built.get(id);
}

/** What a view seeds its own state with when the sample shows: expanded items (`tool:<id>`, `thought:<seq>`), the
 *  plan dock, an open menu (`picker`, `more: requestId`), a hovered list row, the composer's text and attachments. */
export const viewSeed = (name) => entry(name).view;

// ---------------------------------------------------------------------------------------------------------------------
// The service calls (K4), on the sample.

/** The whole state, as `snapshot()` gives it (K4 `AssistantState`), the list built from the sample's rows. */
export function snapshot(name) {
  const s = entry(name).state;
  if (!s.source) return { ...s, list: { groups: [], planned: [], pickable: [] } };
  const running = Object.values(s.sessions).filter((c) => isRunning(c)).map((c) => c.key);
  const list = buildList({ folder: s.folder, home: home(), profiles: s.source.profiles, local: s.source.local, running, bridges: s.bridges, ui: s.source.ui });
  return { ...s, list };
}

/** One session's ChatState, or null. */
export const session = (key, name) => entry(name).state.sessions[key] ?? null;

/** The folder's files for the @ menu, relative to the folder, images excluded. */
export const folderFiles = () => FOLDER_FILES;

const state = () => entry().state;
const apply = (key, ...events) => {
  const s = state();
  let c = s.sessions[key];
  if (!c) return null;
  const t = Date.now();
  for (const e of events) c = reduce(c, e, t);
  s.sessions[key] = c;
  return c;
};
let seq = 0;
const nextRequest = () => `sample:${++seq}`;
/** The sample's answer to a prompt sent to it: a preview reaches no agent, and a turn that ends without an answer
 *  reads as failed (K5 rule 11). */
const answer = () =>
  up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: language() === "ko" ? "미리보기라 Hermes에 보내지 않았습니다." : "This is a preview, so nothing went to Hermes." } });

/** The gates' Retry: the sample has a folder and Hermes, so it opens the new-chat sample. */
export function recheck(_cx) {
  if (state().gate === "relay") return fail("relay");
  use("new");
  return ok();
}

/** Showing the screen: the sample is open already. */
export const open = (_cx) => ok();

/** The list is the sample's own. */
export const refreshList = (_cx, _profile) => ok();

/** "Choose folder…": the sample picks its own folder; a running turn asks first (D22), as the service answers. */
export function pickFolder(cx) {
  const s = state();
  if (s.gate === "relay") return fail("relay");
  const path = s.folder ?? `${home()}/Projects/lazuli`;
  if (Object.values(s.sessions).some((c) => isRunning(c))) return Promise.resolve({ error: "busy", path });
  return setFolder(cx, path, { confirmed: false }).then((r) => (r.ok ? { ok: true, path } : r));
}

/** Sets the folder: busy while a turn runs unless `confirmed`; then the new-chat sample shows. */
export function setFolder(_cx, path, { confirmed = false } = {}) {
  const s = state();
  if (s.gate === "relay") return fail("relay");
  if (!confirmed && Object.values(s.sessions).some((c) => isRunning(c))) return fail("busy");
  use("new");
  return ok({ path });
}

export function select(_cx, key) {
  const s = state();
  const [profile, session] = String(key).split("/");
  if (!s.sessions[key]) return fail("not-found");
  s.source.ui = { ...s.source.ui, selected: { agent: "hermes", profile, session } };
  return ok();
}

export function toggleGroup(profile) {
  const ui = state().source?.ui;
  if (!ui) return;
  ui.collapsed = ui.collapsed.includes(profile) ? ui.collapsed.filter((p) => p !== profile) : [...ui.collapsed, profile];
}

/** Retry on a bridge error (group line, chat banner): the sample's bridge comes back at once. */
export function retryBridge(_cx, profile) {
  const s = state();
  s.bridges = { ...s.bridges, [profile]: { state: "ready" } };
  for (const [k, c] of Object.entries(s.sessions)) if (c.profile === profile && c.stale) s.sessions[k] = reduce(c, { type: "loaded" }, Date.now());
  return ok();
}

/** A new chat in `profile`: its unused empty one when there is one (K4), else a new local session. */
export function newSession(cx, profile = "default") {
  const s = state();
  if (!s.source) return fail("no-folder");
  s.source.ui.collapsed = s.source.ui.collapsed.filter((p) => p !== profile);
  const unused = s.source.local.find((l) => l.profile === profile && !s.sessions[`${profile}/${l.sessionId}`]?.items.length);
  if (unused) return select(cx, `${profile}/${unused.sessionId}`);
  const sessionId = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const key = `${profile}/${sessionId}`;
  const now = Date.now();
  s.sessions[key] = reduce(emptyChat(key, { profile, sessionId, agent: "hermes", loaded: true, updatedAt: now, models: MODELS(), modes: MODES() }), up({ sessionUpdate: "available_commands_update", availableCommands: COMMANDS }), now);
  s.source.local = [...s.source.local, { profile, sessionId, title: null, updatedAt: now, cwd: s.folder }];
  return select(cx, key);
}

export function fork(cx, key) {
  const s = state();
  const src = s.sessions[key];
  if (!src || !s.source) return fail("not-found");
  const sessionId = `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`;
  const next = `${src.profile}/${sessionId}`;
  const now = Date.now();
  s.sessions[next] = { ...src, key: next, sessionId, items: src.items.map((it) => ({ ...it, replayed: true })), inflight: {}, permissions: {}, queue: [], queuePaused: false, plan: null, updatedAt: now };
  s.source.local = [...s.source.local, { profile: src.profile, sessionId, title: src.title, updatedAt: now, cwd: s.folder }];
  return select(cx, next);
}

/** Idle: a prompt, which ends at once with no reply (no Hermes here). Running: a steer, which Hermes acknowledges
 *  as it does (S9). Either way the message stands in the transcript. */
export function send(_cx, key, { text, attachments = [] } = {}) {
  const c = session(key);
  if (!c) return fail("not-found");
  const id = nextRequest();
  const atts = attachments.map((path) => ({ path }));
  if (isRunning(c)) {
    const preview = text.length > 80 ? `${text.slice(0, 80)}...` : text;
    apply(key, { type: "prompt-sent", requestId: id, kind: "steer", text, attachments: atts }, up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\u23E9 Steer queued for the active turn: ${preview}` } }), { type: "prompt-done", requestId: id, stopReason: "end_turn" });
    return ok();
  }
  apply(key, { type: "queue-resumed" }, { type: "prompt-sent", requestId: id, kind: "prompt", text, attachments: atts }, answer(), { type: "prompt-done", requestId: id, stopReason: "end_turn" });
  const local = state().source?.local.find((l) => `${l.profile}/${l.sessionId}` === key);
  if (local && !local.title) {
    local.title = text.split("\n")[0].slice(0, 60);
    apply(key, up({ sessionUpdate: "session_info_update", title: local.title }));
  }
  flushQueue(key);
  return ok();
}

/** The queue head goes once nothing runs and the queue is not paused (K5 rule 6), as the service sends it. */
function flushQueue(key) {
  const c = session(key);
  const head = c ? queueHead(c) : null;
  if (!head) return;
  const id = nextRequest();
  apply(key, { type: "queue-flush", requestId: id, chipId: head.id }, answer(), { type: "prompt-done", requestId: id, stopReason: "end_turn" });
  flushQueue(key);
}

export function queue(_cx, key, text) {
  if (!apply(key, { type: "queued", text })) return fail("not-found");
  flushQueue(key);
  return ok();
}

export function unqueue(key, chipId) {
  apply(key, { type: "unqueued", chipId });
}

/** The paused chips go again: at once when no turn runs, else after it. */
export function resumeQueue(_cx, key) {
  if (!apply(key, { type: "queue-resumed" })) return fail("not-found");
  flushQueue(key);
  return ok();
}

/** Stop: the running requests end cancelled (Hermes answers `session/cancel` so), and the chips pause (K4). */
export function stopTurn(_cx, key) {
  const c = session(key);
  if (!c) return fail("not-found");
  const open = Object.keys(c.inflight);
  if (!open.length) return ok();
  apply(key, ...(c.queue.length ? [{ type: "queue-paused" }] : []), ...open.map((requestId) => ({ type: "prompt-done", requestId, stopReason: "cancelled" })));
  return ok();
}

export function answerPermission(_cx, key, requestId, optionId) {
  const c = session(key);
  if (!c) return fail("not-found");
  const now = Date.now();
  const can = canAnswer(reduce(c, { type: "tick" }, now), requestId, now, optionId);
  if (can.error === "not-found") return fail("not-found");
  apply(key, { type: "tick" }, { type: "permission-answered", requestId, optionId });
  return can.error ? fail(can.error) : ok();
}

export function setModel(_cx, key, modelId) {
  const c = session(key);
  if (!c) return fail("not-found");
  if (isRunning(c)) {
    apply(key, { type: "notice", code: "busy" });
    return fail("busy");
  }
  apply(key, { type: "model-set", modelId });
  return ok();
}
