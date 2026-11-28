#!/usr/bin/env python3
"""Build the Assistant screen prototype (plan lazuli-assistant, node P1).

1. Writes tokens.css from the shipped theme files and the kit's scales, under the names `tokens()` uses
   (mods/lazuli/ui/tokens.js): `--bg-card` is `k.bg.card`, `--state-blocked` is `k.state.blocked`, and so on.
   Sources: themes/lazuli-{light,dark}.json (colors) and mods/lazuli/ui/tokens.js (sizes, fonts).
2. Writes icons.js, an SVG sprite of mods/lazuli/ui/icons/*.svg (the kit's Lucide set), icons-new/*.svg (the
   Lucide icons this screen adds; U2 copies them into mods/lazuli/ui/icons/) and the agent marks of
   ../shared/icons.js.
3. Checks the catalogs: catalog.ko.js and catalog.en.js have the same keys, and every key the screens use exists.
4. Serves the repository root on 127.0.0.1 and screenshots every screen in both languages and both themes with
   headless Google Chrome at 1440x900, device scale 1: shots/<screen>-<lang>-<theme>.png.

Usage: python3 docs/mockups/assistant/build.py [--css-only] [--serve] [screen ...]
  --css-only  steps 1-3 only        --serve  steps 1-3, then serve and print the index URL until Ctrl-C
Standard library only. Chrome: /Applications/Google Chrome.app (override with CHROME=/path/to/binary).
"""
import functools
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]  # the repository
THEMES = ROOT / "themes"
TOKENS_JS = ROOT / "mods/lazuli/ui/tokens.js"
KIT_ICONS = ROOT / "mods/lazuli/ui/icons"
NEW_ICONS = HERE / "icons-new"
SHARED_SPRITE = HERE.parent / "shared/icons.js"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

SCREENS = ["chat", "tools", "approval", "stopped", "new", "error",
           "gate-folder", "gate-missing", "gate-hermes", "gate-check", "gate-relay"]
LANGS = ["ko", "en"]
MODES = ["dark", "light"]


# ---------- 1. tokens.css ----------

def frozen(name):
    """`export const NAME = Object.freeze({ a: 1, b: 2 });` in tokens.js as a dict."""
    m = re.search(r"export const %s = Object\.freeze\(\{([^}]*)\}\);" % name, TOKENS_JS.read_text())
    if not m:
        sys.exit(f"tokens.js: {name} not found")
    return {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+)", m.group(1))}


def chain(name):
    """`export const NAME = Object.freeze(["A", "B"]);` in tokens.js as a list."""
    m = re.search(r"export const %s = Object\.freeze\(\[([^\]]*)\]\);" % name, TOKENS_JS.read_text())
    if not m:
        sys.exit(f"tokens.js: {name} not found")
    return re.findall(r'"([^"]+)"', m.group(1))


def alpha(hex6, a):
    """tokens.js withAlpha(): #rrggbb plus a two-digit alpha."""
    return f"{hex6}{round(a * 255):02x}"


def theme_vars(path):
    """The colors of one theme file under the kit's names (tokens.js buildTokens)."""
    doc = json.loads(path.read_text())
    c = dict(doc.get("colors", {}))
    c["background"], c["foreground"], c["selection"] = doc["background"], doc["foreground"], doc["selection"]
    for i, v in enumerate(doc["ansi"]):
        c[f"ansi{i}"] = v
    out = [
        ("bg-app", c["canvas"], "k.bg.app = canvas"),
        ("bg-chrome", c["chrome"], "k.bg.chrome"),
        ("bg-card", c["background"], "k.bg.card = background"),
        ("bg-surface", c["surface"], "k.bg.surface"),
        ("bg-raised", c["raised"], "k.bg.raised"),
        ("bg-popover", c["popover"], "k.bg.popover"),
        ("bg-hover", c["hover"], "k.bg.hover"),
        ("bg-selected", c["selected"], "k.bg.selected"),
        ("line-soft", c["border"], "k.line.soft = border"),
        ("line-strong", c["input"], "k.line.strong = input"),
        ("text-primary", c["foreground"], "k.text.primary = foreground"),
        ("text-secondary", c["muted"], "k.text.secondary = muted"),
        ("text-tertiary", c["dim"], "k.text.tertiary = dim"),
        ("text-on-accent", c["accent_foreground"], "k.text.onAccent"),
        ("selection", c["selection"], "k.selection"),
        ("accent", c["accent"], "k.accent"),
        ("accent2", c["ansi3"], "k.accent2 = ansi3"),
        ("button-bg", c["solid"], "k.button.bg = solid"),
        ("button-text", c["solid_foreground"], "k.button.text"),
        ("state-working", c["working"], "k.state.working"),
        ("state-blocked", c["blocked"], "k.state.blocked"),
        ("state-done", c["done"], "k.state.done"),
        ("state-idle", c["idle"], "k.state.idle"),
        ("state-unknown", c["unknown"], "k.state.unknown"),
        ("state-success", c["done"], "k.state.success = done"),
        ("state-warning", c["blocked"], "k.state.warning = blocked"),
        ("state-error", c["ansi1"], "k.state.error = ansi1"),
        ("state-info", c["accent"], "k.state.info = accent"),
        ("diff-add", c["ansi2"], "k.diff.add = ansi2"),
        ("diff-remove", c["ansi1"], "k.diff.remove = ansi1"),
        ("diff-add-bg", alpha(c["ansi2"], 0.12), "k.diff.addBg"),
        ("diff-remove-bg", alpha(c["ansi1"], 0.12), "k.diff.removeBg"),
        ("syntax-keyword", c["ansi5"], "k.syntax.keyword"),
        ("syntax-string", c["ansi2"], "k.syntax.string"),
        ("syntax-function", c["ansi4"], "k.syntax.function"),
        ("syntax-type", c["ansi3"], "k.syntax.type"),
        ("syntax-number", c["ansi1"], "k.syntax.number"),
    ]
    return out


def write_css():
    ui, mono = chain("UI_FONT_FALLBACK"), chain("MONO_FONT_FALLBACK")
    quote = lambda fs: ", ".join(f'"{f}"' for f in fs)
    lines = ["/* Generated by build.py from themes/lazuli-{light,dark}.json and mods/lazuli/ui/tokens.js. Do not edit.",
             "   Every name is the kit's: --bg-card is tokens().bg.card, --font-size-md is tokens().fontSize.md. */", ":root {"]
    lines.append(f"  --font-ui: {quote(ui)}, sans-serif;")
    lines.append(f"  --font-mono: {quote(mono)}, monospace;")
    for const, prefix in [("SPACE", "space"), ("RADIUS", "radius"), ("FONT_SIZE", "font-size"), ("LINE_HEIGHT", "line-height"),
                          ("WEIGHT", "weight"), ("ROW", "row"), ("ICON", "icon"), ("CONTROL", "control")]:
        for k, v in frozen(const).items():
            unit = "" if const == "WEIGHT" else "px"
            lines.append(f"  --{prefix}-{k}: {v}{unit};")
    lines.append("}")
    for mode in MODES:
        lines.append(f':root[data-theme="{mode}"] {{')
        lines.append(f"  color-scheme: {mode};")
        for name, value, note in theme_vars(THEMES / f"lazuli-{mode}.json"):
            lines.append(f"  --{name}: {value}; /* {note} */")
        lines.append("}")
    (HERE / "tokens.css").write_text("\n".join(lines) + "\n")


# ---------- 2. icons.js ----------

SVG_BODY = re.compile(r"<svg[^>]*>(.*)</svg>", re.S)


def write_icons():
    icons = {}
    for folder in (KIT_ICONS, NEW_ICONS):
        for f in sorted(folder.glob("*.svg")):
            m = SVG_BODY.search(f.read_text())
            if m:
                icons[f.stem] = re.sub(r"\s+", " ", m.group(1)).strip()
    agents = {}
    text = SHARED_SPRITE.read_text()
    block = text[text.index("const agents = {"):]
    for line in block.splitlines()[1:]:
        if line.strip().startswith("};"):
            break
        agents.update(json.loads("{" + line.strip().rstrip(",") + "}"))
    new = sorted(f.stem for f in NEW_ICONS.glob("*.svg"))
    out = ["// Generated by build.py. Do not edit. Lucide icons (ISC): mods/lazuli/ui/icons/ and icons-new/ (new for this screen:",
           f"// {', '.join(new)}); agent marks from ../shared/icons.js.",
           f"export const ICONS = {json.dumps(icons, ensure_ascii=False, indent=0)};",
           f"export const AGENTS = {json.dumps(agents, ensure_ascii=False, indent=0)};",
           f"export const NEW_ICONS = {json.dumps(new)};",
           "export function injectSprite() {",
           "  // Not display:none: Chrome drops gradient paint servers (the Codex mark) inside a display:none svg.",
           "  let s = '<svg xmlns=\"http://www.w3.org/2000/svg\" aria-hidden=\"true\" style=\"position:absolute;width:0;height:0;overflow:hidden\">';",
           "  for (const [n, b] of Object.entries(ICONS)) s += `<symbol id=\"i-${n}\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\">${b}</symbol>`;",
           "  for (const [n, [vb, b]] of Object.entries(AGENTS)) s += `<symbol id=\"${n}\" viewBox=\"${vb}\">${b}</symbol>`;",
           "  document.body.insertAdjacentHTML(\"afterbegin\", s + \"</svg>\");",
           "}"]
    (HERE / "icons.js").write_text("\n".join(out) + "\n")
    return set(icons)


# ---------- 3. catalog check ----------

def catalog_keys(path):
    """Keys of `export default {…}` and `export const other = {…}` in a catalog file."""
    return set(re.findall(r'^\s*"([A-Za-z0-9_.]+)":', path.read_text(), re.M))


def check(icon_names):
    ko, en = catalog_keys(HERE / "catalog.ko.js"), catalog_keys(HERE / "catalog.en.js")
    problems = [f"only in ko: {k}" for k in sorted(ko - en)] + [f"only in en: {k}" for k in sorted(en - ko)]
    used, icons_used = set(), set()
    for f in ("render.js", "screens.js", "main.js"):
        src = (HERE / f).read_text()
        used |= set(re.findall(r'\bt\("([A-Za-z0-9_.]+)"', src))
        used |= set(re.findall(r'"(assistant\.[A-Za-z0-9_.]+)"', src))
        icons_used |= set(re.findall(r'\b(?:icon|ib)\("([a-z0-9-]+)"', src))
        icons_used |= set(re.findall(r'\b(?:icon|ico|trail): "([a-z0-9-]+)"', src))
    problems += [f"missing key: {k}" for k in sorted(used - ko)]
    problems += [f"missing icon: {n}" for n in sorted(icons_used - icon_names)]
    if problems:
        sys.exit("catalog check failed:\n  " + "\n  ".join(problems))
    print(f"catalog: {len(ko)} keys in both languages; {len(used)} used by the screens; {len(icons_used)} icons, all present")


# ---------- 4. screenshots ----------

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(Quiet, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def shoot(screens):
    server = serve()
    port = server.server_address[1]
    base = f"http://127.0.0.1:{port}/{HERE.relative_to(ROOT).as_posix()}"
    (HERE / "shots").mkdir(exist_ok=True)
    profile = HERE / ".chrome-profile"  # removed again below; keeps every write inside this folder
    try:
        for s in screens:
            for lang in LANGS:
                for mode in MODES:
                    out = HERE / "shots" / f"{s}-{lang}-{mode}.png"
                    url = f"{base}/screen.html?s={s}&lang={lang}&theme={mode}"
                    subprocess.run(
                        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                         "--force-device-scale-factor=1", "--window-size=1440,900", "--virtual-time-budget=5000",
                         "--force-prefers-reduced-motion",  # still frames: no half-faded pulse or caret
                         f"--user-data-dir={profile}", f"--screenshot={out}", url],
                        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
                    print(out.relative_to(HERE))
    finally:
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    unknown = [a for a in args if a not in SCREENS]
    if unknown:
        sys.exit(f"unknown screen: {', '.join(unknown)} (screens: {', '.join(SCREENS)})")
    write_css()
    check(write_icons())
    if "--serve" in sys.argv:
        server = serve()
        print(f"http://127.0.0.1:{server.server_address[1]}/{HERE.relative_to(ROOT).as_posix()}/index.html  (Ctrl-C stops)")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            server.shutdown()
        return
    if "--css-only" not in sys.argv:
        shoot(args or SCREENS)


if __name__ == "__main__":
    main()
