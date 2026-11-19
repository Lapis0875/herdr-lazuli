// The editor grammar for a file name and the syntax colors an EditorState gets (B3, B6). Herdr's
// editor finds a grammar by extension, else by name; one it lacks falls back to plain text, so close
// relatives stand in for the ones it does not carry. Colors come from tokens().editorSyntax.

import { tokens } from "../../ui/tokens.js";

// Extensions read through a relative grammar; every other extension goes to the editor as it is.
const RELATIVE = {
  mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js", dart: "js",
  jsonc: "json", json5: "json",
  toml: "properties", ini: "properties", cfg: "properties", env: "properties",
  markdown: "md", mdx: "md",
  htm: "html", svelte: "html", vue: "html", svg: "html", xml: "html",
  kt: "scala", kts: "scala",
  swift: "go",
  zig: "rs",
  ex: "rb", exs: "rb",
  scss: "css", less: "css",
  dockerfile: "sh", zsh: "sh", bash: "sh",
};

// Fenced code block names that are not extensions.
const FENCE = {
  javascript: "js", typescript: "js", node: "js", shell: "sh", console: "sh", shellscript: "sh",
  python: "py", ruby: "rb", rust: "rs", golang: "go", yml: "yaml", text: "txt", plaintext: "txt",
};

// Markup, where the punctuation (#, **, `, -) is the syntax, so it is what gets the accent.
const MARKUP = new Set(["md", "diff", "patch"]);
// Prose wraps; code scrolls sideways.
const PROSE = new Set(["md", "txt"]);

/** The grammar a file reads through. A name without an extension goes as it is: Makefile, .zshrc. */
export function languageOf(name) {
  const base = String(name ?? "");
  if (/^(Dockerfile|Containerfile)(\.|$)/.test(base)) return "sh";
  if (/^\.env(\.|$)/.test(base) || base === ".editorconfig") return "properties";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base || "txt";
  const ext = base.slice(dot + 1).toLowerCase();
  return RELATIVE[ext] ?? ext;
}

/** The grammar of a fenced code block's info word ("js", "TypeScript", "sh"), or "txt". */
export function fenceLanguage(lang) {
  const word = String(lang ?? "").trim().toLowerCase();
  if (!word) return "txt";
  return FENCE[word] ?? RELATIVE[word] ?? word;
}

/** Whether a grammar is prose: soft-wrapped in the editor. */
export const isProse = (lang) => PROSE.has(lang);

/** The EditorState `syntax` colors for a grammar. */
export function syntaxFor(lang, k = tokens()) {
  return MARKUP.has(lang) ? { ...k.editorSyntax, punctuation: k.accent } : { ...k.editorSyntax };
}
