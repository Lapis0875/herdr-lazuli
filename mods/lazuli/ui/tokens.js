// lazuli's design tokens (ARCHITECTURE §11). The only module that reads `theme()` and `settings()`:
// views and ui/kit.js take every color, font and size from `tokens()`.
//
// Colors come from the shown theme (themes/lazuli-{light,dark}.json, or whatever theme the person picked),
// so the same names work in both appearances. The scales are fixed for every direction; direction A ·
// Lapis is calm and dense: 13 px base text, 28 px rows, 26 px controls. The UI font is Pretendard, which
// the layout root names (`"ui_font": "Pretendard"`) and mods/lazuli/fonts/ brings with real Medium,
// SemiBold and Bold faces but no italic, so emphasis is weight or color, never `italic()`.

import { theme, settings, fonts } from "herdr";

/** Spacing steps in px. */
export const SPACE = Object.freeze({ xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24 });

/** Corner radii in px. `full` makes pills and dots. */
export const RADIUS = Object.freeze({ sm: 4, md: 6, lg: 10, full: 999 });

/** Text sizes in px; `md` (13) is the base. */
export const FONT_SIZE = Object.freeze({ xs: 11, sm: 12, md: 13, lg: 15, xl: 18, xxl: 22 });

/** Line height in px for each text size. */
export const LINE_HEIGHT = Object.freeze({ xs: 16, sm: 18, md: 20, lg: 22, xl: 26, xxl: 28 });

/** Font weights. */
export const WEIGHT = Object.freeze({ regular: 400, medium: 500, semibold: 600, bold: 700 });

/** List row heights in px; `md` (28) is the default row. */
export const ROW = Object.freeze({ sm: 24, md: 28, lg: 32 });

/** Icon sizes in px. */
export const ICON = Object.freeze({ sm: 14, md: 16 });

/** Heights in px: `chip` (non-interactive tags and badges), then controls: `sm` small buttons, `md` buttons,
 *  inputs and segmented controls, `lg` the panel rail's buttons. */
export const CONTROL = Object.freeze({ chip: 20, sm: 24, md: 26, lg: 32 });

/** UI font when neither the layout nor settings.json names one: the first installed of these. */
export const UI_FONT_FALLBACK = Object.freeze(["Pretendard", "Apple SD Gothic Neo"]);

/** lazuli's code font (DESIGN C2: D2Coding), the first installed of these; JetBrains Mono ships with Herdr
 *  (H/AGENTS.md:352). Never the terminal font: terminals keep the person's settings.json `font`. */
export const MONO_FONT_FALLBACK = Object.freeze(["D2Coding ligature", "D2Coding", "JetBrains Mono"]);

/** `#rrggbb` with an alpha from 0 to 1 appended: `#rrggbbaa` (gpui-kit `Color`). Other inputs come back as given. */
export function withAlpha(color, alpha) {
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${color}${a.toString(16).padStart(2, "0")}`;
}

/** The token set for a theme's colors (`theme()`), a settings object (`settings()`) and a predicate telling
 *  whether a font family is installed. Pure: tokens() feeds it the live values. */
export function buildTokens(c, s, installed) {
  const ansi = Array.from({ length: 16 }, (_, i) => c[`ansi${i}`]);
  const firstInstalled = (chain) => chain.slice(0, -1).find((f) => installed(f)) || chain[chain.length - 1];
  const text = {
    primary: c.foreground,
    secondary: c.muted,
    tertiary: c.dim,
    onAccent: c.accent_foreground,
  };
  const syntax = {
    keyword: c.ansi5,
    string: c.ansi2,
    function: c.ansi4,
    type: c.ansi3,
    number: c.ansi1,
    comment: c.dim,
  };
  return Object.freeze({
    dark: Boolean(s.dark),
    bg: Object.freeze({
      app: c.canvas,
      chrome: c.chrome,
      card: c.background,
      surface: c.surface,
      raised: c.raised,
      popover: c.popover,
      hover: c.hover,
      selected: c.selected,
    }),
    line: Object.freeze({ soft: c.border, strong: c.input }),
    text: Object.freeze(text),
    selection: c.selection,
    accent: c.accent,
    accent2: c.ansi3,
    button: Object.freeze({ bg: c.solid, text: c.solid_foreground }),
    state: Object.freeze({
      working: c.working,
      blocked: c.blocked,
      done: c.done,
      idle: c.idle,
      unknown: c.unknown,
      // Message tones, from the colors above: success = done, warning = blocked, error = diff.remove.
      success: c.done,
      warning: c.blocked,
      error: c.ansi1,
      info: c.accent,
    }),
    diff: Object.freeze({
      add: c.ansi2,
      remove: c.ansi1,
      addBg: withAlpha(c.ansi2, 0.12),
      removeBg: withAlpha(c.ansi1, 0.12),
    }),
    syntax: Object.freeze(syntax),
    // EditorState's `syntax` option (H/gpui-kit.d.ts:21519-21522), filled from the same six colors.
    editorSyntax: Object.freeze({
      ...syntax,
      constant: syntax.number,
      boolean: syntax.number,
      variable: text.primary,
      operator: text.secondary,
      punctuation: text.tertiary,
      "string.escape": syntax.type,
    }),
    ansi: Object.freeze(ansi),
    fonts: Object.freeze({
      ui: (typeof s.ui_font_family === "string" && s.ui_font_family) || firstInstalled(UI_FONT_FALLBACK),
      mono: firstInstalled(MONO_FONT_FALLBACK),
    }),
    space: SPACE,
    radius: RADIUS,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    weight: WEIGHT,
    row: ROW,
    icon: ICON,
    control: CONTROL,
  });
}

let families = null;
function installed(family) {
  if (!families) {
    try {
      families = new Set(fonts());
    } catch {
      families = new Set();
    }
  }
  return families.has(family);
}

let memo = null;
let memoKey = "";

/** The tokens for the shown theme and fonts. Cheap to call in every render: it rebuilds only after the
 *  theme's colors, the UI font or the appearance change. `settings().ui_font_family` is the name the settings
 *  frame reads (H/frame/settings/main.js:355,563). */
export function tokens() {
  const c = theme() ?? {};
  const s = settings() ?? {};
  const key = `${Object.values(c).join(",")}|${s.ui_font_family ?? ""}|${s.dark ? 1 : 0}`;
  if (memo && key === memoKey) return memo;
  memo = buildTokens(c, s, installed);
  memoKey = key;
  return memo;
}
