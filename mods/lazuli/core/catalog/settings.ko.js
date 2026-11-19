// UI text for the settings view, Korean. Keys start with "settings.". Owned by U2.

export default {
  "settings.title": "설정",
  "settings.preview": "미리보기: 바꿔도 저장되지 않습니다",
  "settings.saved": "저장했습니다",
  "settings.saveFailed": "설정을 저장하지 못했습니다",
  "settings.file": "{path}에 저장됩니다",

  "settings.language.section": "언어",
  "settings.language.title": "표시 언어",
  "settings.language.hint": "바로 적용되며 AI가 쓰는 글도 이 언어를 따릅니다.",
  "settings.language.system": "시스템",
  "settings.language.systemIs": "시스템 ({lang})",
  "settings.language.name.ko": "한국어",
  "settings.language.name.en": "English",

  "settings.agent.section": "헤드리스 에이전트",
  "settings.agent.command": "명령",
  "settings.agent.commandHint": "요약, 리뷰 설명, 시작 계획, 에이전트 루틴을 이 명령으로 실행합니다. {prompt} 자리에 프롬프트가 들어가며, 없으면 omp, claude, codex에 맞는 옵션을 붙입니다.",
  "settings.agent.model": "모델",
  "settings.agent.modelHint": "선택 사항입니다. 모델을 받는 도구에만 전달합니다.",
  "settings.agent.modelPlaceholder": "도구 기본값",
  "settings.agent.parallel": "동시 실행 루틴",
  "settings.agent.parallelInvalid": "1부터 {max} 사이의 정수를 입력하세요",

  "settings.gh.section": "GitHub",
  "settings.gh.org": "조직 범위",
  "settings.gh.orgHint": "이 조직의 PR만 봅니다. 비우면 전체입니다.",
  "settings.gh.orgPlaceholder": "acme, my-org",
  "settings.gh.orgInvalid": "영문, 숫자, “.”, “_”, “-”만 쓰고 쉼표로 구분하세요",
  "settings.gh.poll": "새로 고침 간격(초)",
  "settings.gh.pollHint": "창이 활성일 때",
  "settings.gh.pollInvalid": "{min}초에서 {max}초 사이로 입력하세요",

  "settings.pins.section": "사이드바 고정 앱",
  "settings.pins.up": "위로",
  "settings.pins.down": "아래로",

  "settings.notify.section": "알림",
  "settings.notify.system": "Herdr가 뒤에 있을 때 시스템 알림 사용",
  "settings.notify.ask": "알림 허용",
  "settings.notify.recheck": "다시 확인",

  "settings.files.section": "파일",
  "settings.pdf.zoom": "PDF 배율",
  "settings.pdf.zoomHint": "PDF를 열 때의 배율",
  "settings.pdf.fit": "폭 맞춤",
  "settings.editor.command": "외부 편집기",
  "settings.editor.hint": "파일과 폴더를 여는 명령입니다(code, cursor, zed…). 비우면 VS Code를 씁니다.",

  "settings.herdr.section": "Herdr",
  "settings.herdr.open": "Herdr 설정",
  "settings.herdr.keys": "단축키",
  "settings.herdr.update": "재시작해서 Herdr {version} 적용",
};
