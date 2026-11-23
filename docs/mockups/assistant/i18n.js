// Language for the prototype: t() reads the new catalog (catalog.{ko,en}.js), ft() the frame's existing lazuli
// strings (copied from mods/lazuli/core/catalog/{shell,home,files}.*.js, not new), L() picks sample content.

import ko, { other as koOther } from "./catalog.ko.js";
import en, { other as enOther } from "./catalog.en.js";

const CATALOG = { ko: { ...ko, ...koOther }, en: { ...en, ...enOther } };

const FRAME = {
  ko: {
    "shell.app.home": "홈", "shell.app.work": "작업", "shell.app.inbox": "수신함", "shell.app.todo": "할 일", "shell.app.routines": "루틴",
    "shell.sidebar.search": "검색 또는 명령…", "shell.sidebar.spaces": "스페이스", "shell.sidebar.thisMac": "이 Mac",
    "shell.sidebar.needsYou": "응답 필요", "shell.brand.search": "검색 또는 명령", "shell.brand.fold": "사이드바 접기",
    "shell.footer.settings": "설정", "shell.footer.addMachine": "머신 추가", "shell.status.queued": "대기 프롬프트",
    "home.stage.needs": "나를 기다림", "home.stage.working": "작업 중", "home.stage.ready": "머지 준비", "home.stage.done": "완료",
    "shell.activity.label": "사이드 패널", "shell.activity.review": "리뷰", "shell.activity.files": "파일", "shell.activity.changes": "변경 사항",
    "shell.activity.tree": "에이전트 호출 트리", "shell.activity.plan": "계획",
    "files.title": "파일", "files.new": "이 폴더 맨 위에 새 파일", "files.mkdir": "이 폴더 맨 위에 새 폴더", "files.collapse": "모든 폴더 접기",
    "files.mark.M": "수정됨", "files.mark.U": "추적 안 됨",
  },
  en: {
    "shell.app.home": "Home", "shell.app.work": "Work", "shell.app.inbox": "Inbox", "shell.app.todo": "To-do", "shell.app.routines": "Routines",
    "shell.sidebar.search": "Search or command…", "shell.sidebar.spaces": "Spaces", "shell.sidebar.thisMac": "This Mac",
    "shell.sidebar.needsYou": "needs you", "shell.brand.search": "Search or run a command", "shell.brand.fold": "Fold the sidebar",
    "shell.footer.settings": "Settings", "shell.footer.addMachine": "Add machine", "shell.status.queued": "Queued prompts",
    "home.stage.needs": "Waiting on you", "home.stage.working": "Working", "home.stage.ready": "Ready to merge", "home.stage.done": "Done",
    "shell.activity.label": "Side panel", "shell.activity.review": "Review", "shell.activity.files": "Files", "shell.activity.changes": "Changes",
    "shell.activity.tree": "Agent call tree", "shell.activity.plan": "Plan",
    "files.title": "Files", "files.new": "New file at the top of this folder", "files.mkdir": "New folder at the top of this folder", "files.collapse": "Collapse all folders",
    "files.mark.M": "Modified", "files.mark.U": "Untracked",
  },
};

export let lang = "ko";

export function setLang(value) {
  lang = value === "en" ? "en" : "ko";
  document.documentElement.lang = lang;
}

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** A new catalog string. A missing key shows as ⟦key⟧ and is logged, as the i18n test would fail on it. */
export function t(key, vars = {}) {
  const s = CATALOG[lang][key];
  if (s === undefined) {
    console.error(`missing ${lang} key: ${key}`);
    return `⟦${key}⟧`;
  }
  return fill(s, vars);
}

/** An existing lazuli string the frame around the screen uses. */
export function ft(key, vars = {}) {
  return fill(FRAME[lang][key] ?? `⟦${key}⟧`, vars);
}

/** Sample content in the shown language: `{ko, en}` picks one, anything else comes back as is. */
export function L(v) {
  return v && typeof v === "object" && ("ko" in v || "en" in v) ? (v[lang] ?? v.ko) : v;
}
