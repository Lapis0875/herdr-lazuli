// A Markdown file as a full HTML page for the HTML viewer's "View in Chrome" (DESIGN B6, B8):
// parsed by the vendored marked (GFM), with mermaid diagrams and KaTeX math loaded from pinned CDN
// URLs (subresource integrity, sha384) only when the page has them. Served by static-server.mjs at
// /__lazuli/md/<rel>: a small script sets <base> to the file's own folder so relative links and
// images resolve as they do on disk, and links to other Markdown files open rendered.
// The page shares the repository's origin, so nothing in the Markdown runs: marked's output goes
// through an allowlist sanitizer (html-sanitize.mjs), and a CSP lets only this page's two inline
// scripts (by hash) and the two pinned loaders run, with no fetch, frames, objects or forms.

import { createHash } from "node:crypto";
import { Marked } from "../../vendor/marked.esm.js";
import { sanitizeHtml } from "./html-sanitize.mjs";

/** Pinned CDN assets: mermaid 12.3.0 (MIT), KaTeX 0.19.1 (MIT). */
export const MERMAID_JS = Object.freeze({
  url: "https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js",
  integrity: "sha384-HHW54r639fK42Ip0coGF3mz8oSiGn0eEoWNTLs75X7H63pLSDBa0Tqs0RwGmLlXE",
});
export const KATEX_JS = Object.freeze({
  url: "https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.js",
  integrity: "sha384-a1WQdjRj162i159OYq041X6I4K8NenkrI09LlPmiHg0YOb7CR+wJOraXwK9abpnE",
});
export const KATEX_CSS = Object.freeze({
  url: "https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css",
  integrity: "sha384-WwGtaC6ywCHxA5cstpj/3+xIZvTez8dq2IcBQaXRkenHZ7FVVq1ZROtURwfbtTlG",
});

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const UNESCAPES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

// What one render found: heading ids taken, and whether math or mermaid needs its script.
let found = { slugs: new Map(), math: false, mermaid: false };

// A GitHub-style heading id from rendered inline HTML; repeats get "-1", "-2", ….
function slugFor(html) {
  const plain = html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => UNESCAPES[e]);
  const base = plain.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-") || "section";
  const n = found.slugs.get(base) ?? 0;
  found.slugs.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

const mathBlock = {
  name: "mathBlock",
  level: "block",
  tokenizer(src) {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
    if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer(token) {
    found.math = true;
    return `<div class="lz-math" data-display="1">${esc(token.text)}</div>\n`;
  },
};

// `$$…$$` inline is display math; `$…$` needs no space inside its edges and no digit right after
// the closing `$`, so prices like "$5 and $10" stay text.
const mathInline = {
  name: "mathInline",
  level: "inline",
  start(src) {
    const i = src.indexOf("$");
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    let m = /^\$\$([^$]+?)\$\$/.exec(src);
    if (m) return { type: "mathInline", raw: m[0], text: m[1].trim(), display: true };
    m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?![0-9])/.exec(src);
    if (m) return { type: "mathInline", raw: m[0], text: m[1], display: false };
    return undefined;
  },
  renderer(token) {
    found.math = true;
    return `<span class="lz-math" data-display="${token.display ? 1 : 0}">${esc(token.text)}</span>`;
  },
};

const marked = new Marked({
  gfm: true,
  async: false,
  extensions: [mathBlock, mathInline],
  renderer: {
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${esc(slugFor(inner))}">${inner}</h${depth}>\n`;
    },
    code({ text, lang }) {
      if (!/^mermaid(?:\s|$)/i.test((lang ?? "").trim())) return false;
      found.mermaid = true;
      return `<pre class="mermaid">${esc(text)}</pre>\n`;
    },
  },
});

const CSS = `:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--soft:#f6f8fa;--line:#d1d9e0;--link:#0969da;--code:#eff1f3}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--soft:#151b23;--line:#3d444d;--link:#4493f8;--code:#262c36}}
html{background:var(--bg)}
body{margin:0;color:var(--fg);background:var(--bg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Segoe UI",Helvetica,Arial,sans-serif;overflow-wrap:break-word}
main{max-width:880px;margin:0 auto;padding:32px 28px 64px}
main>:first-child{margin-top:0}
h1,h2,h3,h4,h5,h6{margin:1.5em 0 .6em;line-height:1.25;font-weight:600}
h1,h2{padding-bottom:.3em;border-bottom:1px solid var(--line)}
h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}h4{font-size:1em}h5{font-size:.875em}h6{font-size:.85em;color:var(--muted)}
p,ul,ol,dl,blockquote,pre,table{margin:0 0 1em}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code,pre,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.875em}
code{background:var(--code);padding:.2em .4em;border-radius:6px}
pre{background:var(--soft);padding:16px;border-radius:6px;overflow:auto;line-height:1.45}
pre code{background:none;padding:0;font-size:inherit}
blockquote{margin-left:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--line)}
table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}
th,td{border:1px solid var(--line);padding:6px 13px}th{font-weight:600;background:var(--soft)}
img{max-width:100%}
hr{border:0;height:.25em;background:var(--line);margin:24px 0}
li:has(>input[type=checkbox]){list-style:none}
li>input[type=checkbox]{margin:0 .4em 0 -1.4em}
pre.mermaid{background:none;text-align:center}
.lz-math[data-display="1"]{overflow-x:auto;margin:0 0 1em;text-align:center}`;

// First in <head>: the page sits at /__lazuli/md/<rel>; relative URLs resolve against <rel>'s folder.
const BASE_SCRIPT = `(()=>{const p=location.pathname.replace(/^\\/__lazuli\\/md(?=\\/)/,"");const b=document.createElement("base");b.href=p.replace(/[^/]*$/,"");document.head.append(b);})();`;

// In-page anchors stay in the page despite <base>; Markdown links open rendered; then math and diagrams.
const CLIENT_SCRIPT = `(()=>{
document.addEventListener("click",(e)=>{
  const a=e.target instanceof Element?e.target.closest("a[href]"):null;
  if(!a||e.defaultPrevented||e.button!==0)return;
  const raw=a.getAttribute("href")||"";
  if(raw.startsWith("#")){e.preventDefault();location.hash=raw;return;}
  const u=new URL(a.href,document.baseURI);
  if(u.origin===location.origin&&/\\.(md|markdown)$/i.test(u.pathname)&&!u.pathname.startsWith("/__lazuli/md/")){e.preventDefault();location.href="/__lazuli/md"+u.pathname+u.search+u.hash;}
});
addEventListener("DOMContentLoaded",()=>{
  const dark=matchMedia("(prefers-color-scheme: dark)").matches;
  if(window.katex)for(const el of document.querySelectorAll(".lz-math")){try{katex.render(el.textContent,el,{displayMode:el.dataset.display==="1",throwOnError:false});}catch{}}
  if(window.mermaid){mermaid.initialize({startOnLoad:false,theme:dark?"dark":"default",securityLevel:"strict"});mermaid.run({querySelector:"pre.mermaid"}).catch(()=>{});}
});
})();`;

const asset = (a, tag) =>
  tag === "css"
    ? `<link rel="stylesheet" href="${a.url}" integrity="${a.integrity}" crossorigin="anonymous">`
    : `<script defer src="${a.url}" integrity="${a.integrity}" crossorigin="anonymous"></script>`;

const hash = (script) => `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;

/** The page's Content-Security-Policy. Styles stay inline-capable for KaTeX and mermaid's SVG;
 *  images may come from the repository and the network (B8). */
export const CSP = [
  "default-src 'none'",
  `script-src ${hash(BASE_SCRIPT)} ${hash(CLIENT_SCRIPT)} ${MERMAID_JS.url} ${KATEX_JS.url}`,
  `style-src 'unsafe-inline' ${KATEX_CSS.url}`,
  `font-src ${KATEX_CSS.url.replace(/[^/]*$/, "fonts/")}`,
  "img-src 'self' https: http: data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join("; ");

/** The full HTML page for Markdown `text`. Front matter (`---` … `---` at the very start) is left out. */
export function renderPage(text, { title = "" } = {}) {
  const source = String(text ?? "").replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  found = { slugs: new Map(), math: false, mermaid: false };
  const body = sanitizeHtml(marked.parse(source));
  const { math, mermaid } = found;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<script>${BASE_SCRIPT}</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
${math ? asset(KATEX_CSS, "css") + "\n" : ""}<style>
${CSS}
</style>
</head>
<body>
<main>
${body}</main>
${math ? asset(KATEX_JS) + "\n" : ""}${mermaid ? asset(MERMAID_JS) + "\n" : ""}<script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}
