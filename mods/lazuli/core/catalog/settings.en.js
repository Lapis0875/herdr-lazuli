// UI text for the settings view, English. Keys start with "settings.". Owned by U2.

export default {
  "settings.title": "Settings",
  "settings.preview": "Preview: changes are not saved",
  "settings.saved": "Saved",
  "settings.saveFailed": "The settings could not be saved",
  "settings.file": "Kept in {path}",

  "settings.language.section": "Language",
  "settings.language.title": "Display language",
  "settings.language.hint": "Applies at once, AI-written text included.",
  "settings.language.system": "System",
  "settings.language.systemIs": "System ({lang})",
  "settings.language.name.ko": "한국어",
  "settings.language.name.en": "English",

  "settings.agent.section": "Headless agent",
  "settings.agent.command": "Command",
  "settings.agent.commandHint": "Runs recaps, review walkthroughs, start plans and agent routines. {prompt} marks where the prompt goes; without it, omp, claude and codex get their own flags.",
  "settings.agent.model": "Model",
  "settings.agent.modelHint": "Optional. Only tools that take a model get it.",
  "settings.agent.modelPlaceholder": "the tool's default",
  "settings.agent.parallel": "Routines at once",
  "settings.agent.parallelInvalid": "A whole number from 1 to {max}",

  "settings.gh.section": "GitHub",
  "settings.gh.org": "Organizations",
  "settings.gh.orgHint": "Only PRs in these organizations; empty means all.",
  "settings.gh.orgPlaceholder": "acme, my-org",
  "settings.gh.orgInvalid": "Use letters, digits, “.”, “_” and “-”, separated by commas",
  "settings.gh.poll": "Refresh every (s)",
  "settings.gh.pollHint": "While the window is active",
  "settings.gh.pollInvalid": "From {min} to {max} seconds",

  "settings.pins.section": "Pinned apps",
  "settings.pins.up": "Move up",
  "settings.pins.down": "Move down",

  "settings.notify.section": "Notifications",
  "settings.notify.system": "System notifications while Herdr is in the background",
  "settings.notify.ask": "Allow notifications",
  "settings.notify.recheck": "Check again",

  "settings.files.section": "Files",
  "settings.pdf.zoom": "PDF zoom",
  "settings.pdf.zoomHint": "The zoom a PDF opens at",
  "settings.pdf.fit": "Fit width",
  "settings.editor.command": "External editor",
  "settings.editor.hint": "The command that opens files and folders (code, cursor, zed…). Empty means VS Code.",

  "settings.herdr.section": "Herdr",
  "settings.herdr.open": "Herdr settings",
  "settings.herdr.keys": "Keyboard shortcuts",
  "settings.herdr.update": "Restart into Herdr {version}",
};
