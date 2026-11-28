// The UI text catalogs: one fragment per area and language (`<area>.en.js`, `<area>.ko.js`), merged
// into one flat table per language. Rules for a fragment: `export default { "<area>.<name>": "text" }`;
// every key starts with its area; text is never empty; placeholders are `{name}` and the same in both
// languages. Product terms stay English in both (PR, CI, Diff).

import commonEn from "./common.en.js";
import commonKo from "./common.ko.js";
import shellEn from "./shell.en.js";
import shellKo from "./shell.ko.js";
import homeEn from "./home.en.js";
import homeKo from "./home.ko.js";
import inboxEn from "./inbox.en.js";
import inboxKo from "./inbox.ko.js";
import todoEn from "./todo.en.js";
import todoKo from "./todo.ko.js";
import routinesEn from "./routines.en.js";
import routinesKo from "./routines.ko.js";
import reviewEn from "./review.en.js";
import reviewKo from "./review.ko.js";
import filesEn from "./files.en.js";
import filesKo from "./files.ko.js";
import treeEn from "./tree.en.js";
import treeKo from "./tree.ko.js";
import filetabEn from "./filetab.en.js";
import filetabKo from "./filetab.ko.js";
import paletteEn from "./palette.en.js";
import paletteKo from "./palette.ko.js";
import settingsEn from "./settings.en.js";
import settingsKo from "./settings.ko.js";
import galleryEn from "./gallery.en.js";
import galleryKo from "./gallery.ko.js";
import viewerEn from "./viewer.en.js";
import viewerKo from "./viewer.ko.js";
import assistantEn from "./assistant.en.js";
import assistantKo from "./assistant.ko.js";

/** The catalog languages. */
export const LANGUAGES = Object.freeze(["en", "ko"]);

/** The areas, one fragment pair each (ARCHITECTURE §1). */
export const AREAS = Object.freeze(["common", "shell", "home", "inbox", "todo", "routines", "review", "files", "tree", "filetab", "palette", "settings", "gallery", "viewer", "assistant"]);

/** Every fragment by area, then language. */
export const fragments = Object.freeze({
  common: { en: commonEn, ko: commonKo },
  shell: { en: shellEn, ko: shellKo },
  home: { en: homeEn, ko: homeKo },
  inbox: { en: inboxEn, ko: inboxKo },
  todo: { en: todoEn, ko: todoKo },
  routines: { en: routinesEn, ko: routinesKo },
  review: { en: reviewEn, ko: reviewKo },
  files: { en: filesEn, ko: filesKo },
  tree: { en: treeEn, ko: treeKo },
  filetab: { en: filetabEn, ko: filetabKo },
  palette: { en: paletteEn, ko: paletteKo },
  settings: { en: settingsEn, ko: settingsKo },
  gallery: { en: galleryEn, ko: galleryKo },
  viewer: { en: viewerEn, ko: viewerKo },
  assistant: { en: assistantEn, ko: assistantKo },
});

function merge(lang) {
  const table = {};
  for (const area of AREAS) Object.assign(table, fragments[area][lang]);
  return Object.freeze(table);
}

/** One flat table per language: `catalogs.en["common.placeholder"]`. */
export const catalogs = Object.freeze({ en: merge("en"), ko: merge("ko") });
