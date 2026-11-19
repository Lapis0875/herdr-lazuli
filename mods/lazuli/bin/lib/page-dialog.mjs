// The shown page's JavaScript dialogs in the HTML viewer. An alert is acknowledged at once and
// reported; confirm, prompt and beforeunload wait for the person: Enter answers OK (a prompt keeps
// its default text) and Escape Cancel, as do the top line's two buttons, which name those keys.
// y and n work too, also as the Korean input source types them (ㅛ, ㅜ), but only once committed:
// the input method holds a lone jamo back, and pressing Enter or Escape then sends the jamo first
// and the key right after, so that key is dropped for a moment after an answer instead of
// reaching the page. Nothing is accepted on the person's behalf.

import { latinKey } from "./kitty.mjs";

/** `fire(method, params)` sends a CDP call to the page; `changed()` redraws the top line;
 *  `notice(message)` reports an alert. */
export function createDialogs({ fire, changed, notice }) {
  let pending = null;
  let answeredAt = 0;

  function answer(accept) {
    if (!pending) return;
    const { promptText } = pending;
    pending = null;
    answeredAt = Date.now();
    fire("Page.handleJavaScriptDialog", accept ? { accept: true, promptText } : { accept: false });
    changed();
  }

  return {
    /** The dialog waiting for an answer, `{type, message}`, else null. */
    get pending() {
      return pending;
    },
    answer,
    /** Page.javascriptDialogOpening. */
    opened(p) {
      const message = String(p.message ?? "");
      if (p.type === "alert") {
        fire("Page.handleJavaScriptDialog", { accept: true });
        notice(message);
        return;
      }
      pending = { type: String(p.type ?? ""), message, promptText: String(p.defaultPrompt ?? "") };
      changed();
    },
    /** Page.javascriptDialogClosed, or the page gone: nothing waits any more. */
    closed() {
      if (!pending) return;
      pending = null;
      changed();
    },
    /** Terminal input while a dialog waits: answers it or is dropped (the page is blocked anyway).
     *  Returns whether the event was taken; mouse events are left to the top line's buttons. */
    input(ev) {
      if (ev.type === "mouse") return false;
      if (!pending) return ev.type === "key" && (ev.key === "Enter" || ev.key === "Escape") && Date.now() - answeredAt < 300;
      const k = latinKey(ev.type === "key" ? ev.key : ev.type === "text" ? ev.text : "");
      if (k === "y" || k === "Y" || k === "Enter") answer(true);
      else if (k === "n" || k === "N" || k === "Escape") answer(false);
      return ev.type === "key" || ev.type === "text" || ev.type === "paste";
    },
  };
}
