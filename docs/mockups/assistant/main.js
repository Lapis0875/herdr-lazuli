// screen.html?s=<screen>&lang=ko|en&theme=dark|light draws one prototype screen.

import { setLang, L } from "./i18n.js";
import { injectSprite } from "./icons.js";
import { screen } from "./render.js";
import { SCREENS } from "./screens.js";

const q = new URLSearchParams(location.search);
setLang(q.get("lang"));
const id = q.get("s") in SCREENS ? q.get("s") : "chat";
const state = SCREENS[id];
document.title = `lazuli · Assistant · ${L(state.label)}`;
document.body.innerHTML = screen(state);
injectSprite();

// A transcript that fits starts at the top; one that overflows stays scrolled to its end (the newest item),
// as the view follows the stream. Measured after the fonts load.
document.fonts.ready.then(() => {
  for (const tx of document.querySelectorAll(".tx")) {
    tx.classList.add("top");
    if (tx.scrollHeight > tx.clientHeight + 1) tx.classList.remove("top");
    else tx.querySelector(".thumb")?.remove();
  }
});
