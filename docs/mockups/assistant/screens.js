// Sample states, one per screen. The shape follows the contracts so U1's sample.js can start from it:
// list groups (K6 ListModel), chat items (K5 Item kinds), plan (ChatState.plan), composer and info (K8).
// `{ko, en}` values are sample content in each language; Hermes's own words (command descriptions, approval
// details, mode names) stay English in both, as Hermes sends them.

const now = { ko: "방금", en: "now" };

const ROWS = {
  review: { title: { ko: "주간 회고 초안 정리", en: "Draft the weekly review" }, time: now },
  receipts: { title: { ko: "11월 영수증 분류", en: "Sort November receipts" }, time: { ko: "2시간", en: "2h" } },
  trip: { title: { ko: "여행 일정 비교표", en: "Compare trip itineraries" }, time: { ko: "어제", en: "yesterday" } },
  gifts: { title: { ko: "집들이 선물 목록", en: "Housewarming gift ideas" }, time: { ko: "3일", en: "3d" } },
  scratch: { title: { ko: "scratch 폴더 정리", en: "Clean up the scratch folder" }, time: now },
  thanks: { title: { ko: "올해 고마웠던 일 모으기", en: "Collect this year's thank-yous" }, time: { ko: "5분", en: "5m" } },
};
const row = (key, extra = {}) => ({ ...ROWS[key], ...extra });

const docWriter = (bridge = "off") => ({
  profile: "doc-writer",
  bridge,
  rows: [
    { title: { ko: "분기 보고서 개요", en: "Q4 report outline" }, time: { ko: "4일", en: "4d" } },
    { title: { ko: "디자인 리뷰 회의록 요약", en: "Design review notes summary" }, time: { ko: "11월 12일", en: "Nov 12" } },
  ],
});
const dataAnalyst = { profile: "data-analyst", bridge: "error", collapsed: true, rows: [], more: 3 };
const NOD = { planned: true, name: "Nod" };

const TREE = (hover) => [
  [0, "dir", "inbox"],
  [0, "dir", "journal", null, "open"],
  [1, "file", "2026-11-22.md"],
  [1, "file", "2026-11-23.md"],
  [0, "dir", "receipts"],
  [0, "dir", "scratch"],
  [0, "file", "notes.md"],
  [0, "file", "pic.png"],
  [0, "file", "todo.md", null, hover ? "hover" : ""],
];

const INFO = {
  model: "gpt-5.5",
  mode: "Default",
  context: { used: "42.1k", size: "272k", pct: 15 },
  last: { input: "3.2k", output: "410" },
  total: { tokens: "128.4k", calls: 12 },
  cost: "$0.42",
};

const FILES_AT = [["", "notes.md"], ["", "todo.md"], ["journal/", "2026-11-23.md"], ["journal/", "2026-11-22.md"], ["inbox/", "ideas.md"], ["receipts/2026-11/", "summary.md"]];
const COMMANDS = [
  ["help", "List available commands"],
  ["model", "Show current model and provider, or switch models"],
  ["tools", "List available tools with descriptions"],
  ["context", "Show conversation message counts by role"],
  ["reset", "Clear conversation history"],
  ["compact", "Compress conversation context"],
  ["steer", "Inject guidance into the currently running agent turn"],
  ["queue", "Queue a prompt to run after the current turn finishes"],
  ["version", "Show Hermes version"],
];

const gated = (kind, extra = {}) => ({
  badge: {},
  gated: kind === "relay" ? "relay" : "gate",
  gate: { kind, ...extra },
  groups: [],
  // The tree needs only the folder: it still shows while Hermes is missing or failing its check (K8).
  files: { "no-folder": "none", "folder-missing": "missing", relay: "relay" }[kind] ?? null,
  tree: TREE(false),
});

export const SCREENS = {
  /* A running turn: tools collapsed and one expanded with its diff, a docked plan, a steer and its notice,
     streaming text, two queued chips. */
  chat: {
    label: { ko: "진행 중인 응답", en: "Response in progress" },
    badge: { running: 1 },
    groups: [
      { profile: "default", bridge: "ready", running: 1, rows: [row("review", { state: "running", selected: true }), row("receipts"), row("trip"), row("gifts")] },
      docWriter("off"),
      dataAnalyst,
      NOD,
    ],
    title: ROWS.review.title,
    profile: "default",
    model: "gpt-5.5",
    running: "0:42",
    thumb: [6, 150],
    items: [
      { type: "user", text: { ko: "notes.md로 주간 회고 초안을 쓰고, 다음 주 할 일은 todo.md에 정리해 줘", en: "Draft a weekly review from notes.md and put next week's to-dos in todo.md" } },
      { type: "thought", text: { ko: "notes.md를 먼저 읽고 날짜별로 묶자. 할 일은 todo.md 맨 아래 목록에 넣으면 된다.", en: "Read notes.md first and group it by day. The to-dos go in the list at the end of todo.md." } },
      { type: "tool", kind: "read", status: "completed", secs: 0.2, title: { ko: "notes.md 읽기", en: "Read notes.md" } },
      {
        type: "tool", kind: "edit", status: "completed", secs: 1.1, open: true, title: { ko: "todo.md 수정", en: "Edit todo.md" },
        diff: {
          path: "todo.md", add: 2, remove: 1,
          lines: {
            ko: [["@", "@@ -4,2 +4,3 @@"], ["-", "- [ ] 영수증 스캔"], ["+", "- [ ] 11월 영수증 분류 (금요일까지)"], ["+", "- [ ] 분기 보고서 개요 공유"], [" ", "- [ ] 여행 숙소 예약"]],
            en: [["@", "@@ -4,2 +4,3 @@"], ["-", "- [ ] Scan receipts"], ["+", "- [ ] Sort November receipts (by Friday)"], ["+", "- [ ] Share the Q4 report outline"], [" ", "- [ ] Book trip lodging"]],
          },
        },
      },
      { type: "user", via: "steer", text: { ko: "회의 얘기는 두세 줄로 줄여 줘", en: "Keep the meetings to two or three lines" } },
      { type: "event", kind: "steerAck" },
      {
        type: "agent", streaming: true,
        html: {
          ko: "<h3>이번 주 회고 · 11월 17–23일</h3><p><strong>회의:</strong> 월요일 기획, 목요일 리뷰. 결정 사항은 todo.md로 옮겼습니다.</p><p><strong>아쉬운 일:</strong> 여행 숙소 예약을 또 미뤄",
          en: "<h3>Weekly review · Nov 17–23</h3><p><strong>Meetings:</strong> Monday planning, Thursday review. Decisions moved to todo.md.</p><p><strong>Slipped:</strong> trip lodging is still not",
        },
      },
    ],
    plan: {
      open: true,
      entries: [
        { status: "completed", text: { ko: "노트에서 이번 주 항목 모으기", en: "Collect this week's entries from the notes" } },
        { status: "completed", text: { ko: "todo.md에 다음 주 할 일 정리", en: "Put next week's to-dos in todo.md" } },
        { status: "in_progress", text: { ko: "회고 초안 쓰기", en: "Write the review draft" } },
      ],
    },
    composer: {
      running: true,
      focus: true,
      queue: [{ ko: "다음 주 일정도 캘린더 형식으로 정리해 줘", en: "Also lay out next week as a calendar" }, { ko: "영수증 합계도 내 줘", en: "Total the receipts too" }],
    },
    info: INFO,
    tree: TREE(false),
  },

  /* A finished turn: thought and tool expanded, the markdown answer, a typed reply with an attachment chip, the
     new-chat profile picker (Nod Planned) open over the list, and a hovered file row with Attach. */
  tools: {
    label: { ko: "끝난 응답 · 새 대화 프로필 선택", en: "Finished response · new-chat profile picker" },
    badge: { running: 1 },
    picker: { left: 8, top: 36 },
    groups: [
      { profile: "default", bridge: "ready", running: 1, rows: [row("review", { state: "running" }), row("receipts", { selected: true, time: now }), row("trip"), row("gifts")] },
      docWriter("off"),
      dataAnalyst,
      NOD,
    ],
    title: ROWS.receipts.title,
    profile: "default",
    model: "gpt-5.5",
    thumb: [6, 210],
    items: [
      { type: "user", text: { ko: "receipts 폴더에 있는 11월 영수증을 정리해 줘", en: "Sort out the November receipts in the receipts folder" } },
      { type: "thought", open: true, text: { ko: "receipts/2026-11의 파일 이름에 날짜와 가게 이름이 들어 있다. 목록부터 보자.\n\n분류는 식비, 교통, 도서면 충분해 보인다.", en: "The files in receipts/2026-11 carry the date and the shop in their names. List them first.\n\nFood, transport and books look like enough categories." } },
      {
        type: "tool", kind: "execute", status: "completed", secs: 1.5, open: true, mono: true, title: "ls -1 receipts/2026-11",
        input: "ls -1 receipts/2026-11",
        output: { ko: "2026-11-03_스타벅스.pdf\n2026-11-05_코레일.pdf\n2026-11-08_교보문고.pdf\n2026-11-12_김밥천국.pdf", en: "2026-11-03_starbucks.pdf\n2026-11-05_korail.pdf\n2026-11-08_kyobo-books.pdf\n2026-11-12_kimbap-cafe.pdf" },
        more: 3,
      },
      {
        type: "agent",
        html: {
          ko: "<p>11월 영수증 <strong>7건</strong>을 찾았습니다. 합계는 <strong>₩182,400</strong>입니다.</p><ul><li>식비 4건 · ₩96,000</li><li>교통 2건 · ₩41,400</li><li>도서 1건 · ₩45,000</li></ul><p>표로 만들어 <code>receipts/2026-11/summary.md</code>에 저장할까요?</p>",
          en: "<p>I found <strong>7 receipts</strong> for November, <strong>₩182,400</strong> in total.</p><ul><li>Food: 4 · ₩96,000</li><li>Transport: 2 · ₩41,400</li><li>Books: 1 · ₩45,000</li></ul><p>Shall I save a table to <code>receipts/2026-11/summary.md</code>?</p>",
        },
      },
    ],
    composer: { text: { ko: "좋아, 저장해 줘. 지난달 표와도 비교해 줘", en: "Yes, save it. Compare with last month's table too" }, attachments: ["receipts/2026-10/summary.md"] },
    info: { ...INFO, context: { used: "18.6k", size: "272k", pct: 7 }, last: { input: "2.4k", output: "312" }, total: { tokens: "61.0k", calls: 7 }, cost: "$0.18" },
    tree: TREE(true),
  },

  /* Approval: an expired edit approval and the late answer's notice, then a live approval with the countdown
     and the More menu open; the plan dock collapsed. */
  approval: {
    label: { ko: "허가 카드 · 더 보기 · 만료", en: "Approval card · More · expired" },
    badge: { running: 1, waiting: 1 },
    groups: [
      { profile: "default", bridge: "ready", running: 1, rows: [row("scratch", { state: "waiting", selected: true }), row("review"), row("receipts"), row("trip")] },
      docWriter("off"),
      dataAnalyst,
      NOD,
    ],
    title: ROWS.scratch.title,
    profile: "default",
    model: "gpt-5.5",
    running: "1:05",
    thumb: [6, 120],
    items: [
      { type: "user", text: { ko: "todo.md에 내일 할 일 세 개 추가해 줘", en: "Add three things for tomorrow to todo.md" } },
      { type: "approval", state: "expired", edit: true, options: ["allow_once", "deny"], diff: { path: "todo.md", add: 3, remove: 0, lines: [] } },
      { type: "event", kind: "tooLate" },
      { type: "agent", html: { ko: "<p>수정 허가를 받지 못해 todo.md는 그대로 두었습니다.</p>", en: "<p>The edit wasn't allowed, so todo.md is unchanged.</p>" } },
      { type: "user", text: { ko: "scratch 폴더는 지워도 돼. 비워 줘", en: "You can delete the scratch folder. Clear it out." } },
      { type: "tool", kind: "execute", status: "waiting", mono: true, title: "rm -r scratch" },
      {
        type: "approval", state: "pending", left: 47, menuOpen: true,
        options: ["allow_once", "allow_session", "allow_always", "deny", "deny_always"],
        command: "rm -r /Users/lapis0875/Assistant/scratch",
        why: "Dangerous command: recursive delete",
      },
    ],
    plan: {
      open: false,
      entries: [
        { status: "completed", text: { ko: "scratch 폴더 내용 확인", en: "Check what is in the scratch folder" } },
        { status: "in_progress", text: { ko: "scratch 폴더 지우기", en: "Delete the scratch folder" } },
      ],
    },
    composer: { running: true },
    info: { ...INFO, context: { used: "9.8k", size: "272k", pct: 4 }, last: { input: "1.1k", output: "96" }, total: { tokens: "14.2k", calls: 4 }, cost: "$0.05" },
    tree: TREE(false),
  },

  /* After Stop: the cancelled notice, a paused chip with Resume, the / menu, and a hovered row with Fork. */
  stopped: {
    label: { ko: "중지 · 일시정지된 대기열 · / 명령 메뉴", en: "Stopped · paused queue · / command menu" },
    badge: {},
    groups: [
      { profile: "default", bridge: "ready", rows: [row("thanks", { selected: true, time: now }), row("review", { time: { ko: "12분", en: "12m" }, hover: true }), row("receipts"), row("trip")] },
      docWriter("off"),
      dataAnalyst,
      NOD,
    ],
    title: ROWS.thanks.title,
    profile: "default",
    model: "gpt-5.5",
    items: [
      { type: "user", text: { ko: "journal 폴더에서 올해 고마웠던 일을 30개 뽑아 줘", en: "Pick 30 things I was grateful for this year from the journal folder" } },
      { type: "thought", text: { ko: "‘고마’, ‘감사’로 찾고 날짜가 붙은 항목만 고르자.", en: "Search for “grateful” and “thanks”, keep only dated entries." } },
      { type: "tool", kind: "search", status: "completed", secs: 0.6, title: { ko: "journal에서 ‘고마’ 검색 · 41건", en: "Search journal for “grateful” · 41 matches" } },
      {
        type: "agent",
        html: {
          ko: "<ol><li>1월 3일 · 이사를 도와준 민수</li><li>1월 18일 · 첫 하프 마라톤 완주</li><li>2월 2일 · 엄마가 보내 준 김치</li><li>2월 14일 · 팀이 마감을 하루 앞당겨 끝냄</li><li>3월 9일 · 도서관에서 찾은 절판된 책</li></ol>",
          en: "<ol><li>Jan 3 · Minsu helping with the move</li><li>Jan 18 · Finishing my first half marathon</li><li>Feb 2 · The kimchi Mom sent</li><li>Feb 14 · The team finishing a day early</li><li>Mar 9 · An out-of-print book at the library</li></ol>",
        },
      },
      { type: "event", kind: "cancelled" },
    ],
    composer: { focus: true, text: "/", queue: [{ ko: "결과는 날짜순으로 정리해 줘", en: "Sort the results by date" }], paused: true, menu: "commands", commands: COMMANDS },
    info: { ...INFO, context: { used: "31.7k", size: "272k", pct: 12 }, last: { input: "28.9k", output: "604" }, total: { tokens: "29.5k", calls: 3 }, cost: "unknown" },
    tree: TREE(false),
  },

  /* A new empty chat in default while doc-writer's bridge starts; the @ file menu open in the composer. */
  new: {
    label: { ko: "새 대화 · @ 파일 메뉴", en: "New chat · @ file menu" },
    badge: {},
    groups: [
      { profile: "default", bridge: "ready", rows: [{ untitled: true, selected: true, time: now }, row("thanks", { time: { ko: "40분", en: "40m" } }), row("review", { time: { ko: "1시간", en: "1h" } }), row("receipts")] },
      docWriter("starting"),
      dataAnalyst,
      NOD,
    ],
    untitled: true,
    title: { ko: "새 대화", en: "New chat" },
    profile: "default",
    model: "gpt-5.5",
    empty: true,
    composer: { focus: true, text: "@", menu: "mention", files: FILES_AT },
    info: { model: "gpt-5.5", mode: "Default" },
    tree: TREE(false),
  },

  /* Hermes exited: the banner with Retry, a stale transcript with a failed request, the composer offline and
     the default group's bridge in error. */
  error: {
    label: { ko: "Hermes 종료 · 실패한 요청", en: "Hermes quit · failed request" },
    badge: {},
    groups: [
      { profile: "default", bridge: "error", error: "assistant.bridge.exited", rows: [row("receipts", { selected: true }), row("review", { time: { ko: "12분", en: "12m" } }), row("trip")] },
      docWriter("off"),
      dataAnalyst,
      NOD,
    ],
    title: ROWS.receipts.title,
    profile: "default",
    model: "gpt-5.5",
    banner: { title: "assistant.banner.agentExit", body: "assistant.banner.agentExitBody", vars: { code: 1 } },
    stale: true,
    items: [
      { type: "user", text: { ko: "receipts 폴더에 있는 11월 영수증을 정리해 줘", en: "Sort out the November receipts in the receipts folder" } },
      { type: "agent", html: { ko: "<p>11월 영수증 <strong>7건</strong>을 찾았습니다. 합계는 <strong>₩182,400</strong>입니다.</p>", en: "<p>I found <strong>7 receipts</strong> for November, <strong>₩182,400</strong> in total.</p>" } },
      { type: "user", text: { ko: "지난달과 비교해서 표로 저장해 줘", en: "Compare with last month and save a table" } },
      { type: "event", kind: "failed", detail: "Internal error (-32603)" },
    ],
    composer: { offline: true },
    info: { ...INFO, context: { used: "18.6k", size: "272k", pct: 7 }, last: { input: "2.4k", output: "312" }, total: { tokens: "61.0k", calls: 7 }, cost: "$0.18" },
    tree: TREE(false),
  },

  "gate-folder": { label: { ko: "폴더 없음", en: "No folder" }, ...gated("no-folder") },
  "gate-missing": { label: { ko: "폴더를 찾을 수 없음", en: "Folder missing" }, ...gated("folder-missing", { path: "~/Assistant" }) },
  "gate-hermes": { label: { ko: "Hermes 없음", en: "Hermes missing" }, ...gated("hermes-missing") },
  "gate-check": {
    label: { ko: "ACP 확인 실패", en: "ACP check failed" },
    ...gated("check-failed", {
      output: "Traceback (most recent call last):\n  File \"…/acp_adapter/entry.py\", line 151, in _run_check\n    import acp  # noqa: F401\nModuleNotFoundError: No module named 'acp'",
    }),
  },
  "gate-relay": { label: { ko: "relay 기기 · Mac에서만", en: "Relay device · Mac only" }, ...gated("relay") },
};
