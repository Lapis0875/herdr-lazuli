// An allowlist HTML sanitizer for the Markdown page (md-page.mjs): marked passes raw HTML through
// and does not check link schemes, and the page is served from the repository's own origin. The
// input is scanned for tags and re-serialized, so the browser only ever parses this module's output:
// allowed elements with allowed attributes (double-quoted, escaped), and text whose every "<" is
// escaped. Everything else is left out: script, style, iframe and the other raw-text elements with
// their content; object, embed, form, meta, base, link, svg, math and any other element (their text
// stays); comments; event handlers and every attribute not listed; URLs other than http(s),
// relative, mailto (links) and data:image (images).

const ELEMENTS = new Set(
  ("a abbr b bdi blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure " +
    "h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p pre q rp rt ruby s samp small span strike strong sub " +
    "summary sup table tbody td tfoot th thead tr tt u ul var wbr").split(" "),
);
const VOID = new Set(["br", "col", "hr", "img", "input", "wbr"]);
// Raw-text and RCDATA elements (and template): left out together with everything up to their end tag.
const WITH_CONTENT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "template", "plaintext"]);
const GLOBAL_ATTRS = new Set(["id", "class", "title", "lang", "dir"]);
const ATTRS = {
  a: ["href", "name"],
  img: ["src", "alt", "width", "height", "align"],
  ol: ["start", "type", "reversed"],
  ul: ["type"],
  table: ["align", "width"],
  td: ["align", "valign", "colspan", "rowspan", "width"],
  th: ["align", "valign", "colspan", "rowspan", "width", "scope"],
  col: ["span", "align", "width"],
  colgroup: ["span"],
  details: ["open"],
  div: ["align", "data-display"],
  span: ["data-display"],
  p: ["align"],
  h1: ["align"], h2: ["align"], h3: ["align"], h4: ["align"], h5: ["align"], h6: ["align"],
};

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", nbsp: "\u00a0", sol: "/", num: "#", quest: "?", period: ".", lpar: "(", rpar: ")", equals: "=", percnt: "%" };

/** Character references in an attribute value decoded: numeric ones, and the named ones above. */
export function decodeEntities(v) {
  return String(v).replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,8})|([A-Za-z][A-Za-z0-9]{1,31}));?/g, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "\uFFFD";
  });
}

const escapeAttr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The decoded URL when its scheme is allowed for `attr` ("href" or "src"), else null. The check runs
 *  on the decoded value with every control and space removed, and the decoded value is what gets
 *  written (escaped), so the browser reads exactly the URL that was checked. */
export function safeUrl(raw, attr) {
  const url = decodeEntities(raw);
  const probe = url.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe)?.[1];
  if (!scheme || scheme === "http" || scheme === "https") return url;
  if (attr === "href" && scheme === "mailto") return url;
  if (attr === "src" && probe.startsWith("data:image/")) return url;
  return null;
}

const TAG = /<(\/?)([A-Za-z][^\s/>\0]*)/y;
const ATTR = /([^\s"'>/=][^\s"'>/=]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/y;

// The tag starting at `i`: {closing, name, attrs: [name, value|null][], end}, or null when `<` there
// starts no complete tag.
function readTag(s, i) {
  TAG.lastIndex = i;
  const m = TAG.exec(s);
  if (!m) return null;
  const attrs = [];
  let j = TAG.lastIndex;
  for (;;) {
    while (j < s.length && (s[j] === "/" || /\s/.test(s[j]))) j++;
    if (j >= s.length) return null;
    if (s[j] === ">") return { closing: m[1] === "/", name: m[2].toLowerCase(), attrs, end: j + 1 };
    ATTR.lastIndex = j;
    const a = ATTR.exec(s);
    if (!a) {
      j++;
      continue;
    }
    attrs.push([a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? null]);
    j = ATTR.lastIndex;
  }
}

function startTag(name, attrs) {
  if (name === "input") {
    // Only the task-list checkbox marked writes, never editable.
    const type = attrs.find(([k]) => k === "type")?.[1];
    if (String(type ?? "").toLowerCase() !== "checkbox") return "";
    return `<input type="checkbox" disabled=""${attrs.some(([k]) => k === "checked") ? ' checked=""' : ""}>`;
  }
  const own = ATTRS[name] ?? [];
  const seen = new Set();
  let out = `<${name}`;
  for (const [k, v] of attrs) {
    // The first of a repeated attribute counts, as in browsers.
    if (seen.has(k) || !(GLOBAL_ATTRS.has(k) || own.includes(k))) continue;
    seen.add(k);
    if (k === "href" || k === "src") {
      const url = safeUrl(v ?? "", k);
      if (url !== null) out += ` ${k}="${escapeAttr(url)}"`;
    } else if (k !== "data-display" || v === "0" || v === "1") {
      out += ` ${k}="${String(v ?? "").replace(/"/g, "&quot;")}"`;
    }
  }
  return out + ">";
}

/** `html` with everything outside the allowlist left out (see the top of this file). */
export function sanitizeHtml(html) {
  const s = String(html ?? "");
  const n = s.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    i = lt;
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 2);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (s[i + 1] === "!" || s[i + 1] === "?") {
      const end = s.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const tag = readTag(s, i);
    if (!tag) {
      out += "&lt;";
      i++;
      continue;
    }
    i = tag.end;
    if (tag.closing) {
      if (ELEMENTS.has(tag.name) && !VOID.has(tag.name)) out += `</${tag.name}>`;
    } else if (WITH_CONTENT.has(tag.name)) {
      const close = new RegExp(`</${tag.name}(?=[\\s/>])`, "gi");
      close.lastIndex = i;
      const m = tag.name === "plaintext" ? null : close.exec(s);
      const gt = m ? s.indexOf(">", m.index) : -1;
      i = gt < 0 ? n : gt + 1;
    } else if (ELEMENTS.has(tag.name)) {
      out += startTag(tag.name, tag.attrs);
    }
  }
  return out;
}
