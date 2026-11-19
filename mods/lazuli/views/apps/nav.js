// Going from one app to another on a row: the selected row of the Inbox, To-do and Routines lives in a shared key
// (every copy redraws when it changes), so Home and Recap can open an app on the row a click named.

import { shared, setShared } from "herdr";
import { showCenter } from "../../sys/bus.js";

/** Shared keys of the apps' selected rows: an Inbox item's URL, a to-do's store `key` (its text when no other to-do
 *  has it), a routine's slug. */
export const SEL = Object.freeze({ inbox: "lazuli.apps.inbox", todo: "lazuli.apps.todo", routines: "lazuli.apps.routines" });

/** The selected row of an app, or null. */
export function selectedIn(app) {
  const v = shared(SEL[app]);
  return typeof v === "string" && v ? v : null;
}

/** Selects a row of an app (null: none). */
export function selectIn(app, key) {
  if ((shared(SEL[app]) ?? null) !== (key ?? null)) setShared(SEL[app], key ?? null);
}

/** Shared keys of the apps' reveal requests: `{key, n}`, `n` counting the links followed, so a link to the row
 *  already selected still shows it (the app clears what hides it: a filter, a folded group). */
const REVEAL = Object.freeze({ inbox: "lazuli.apps.inbox.reveal", todo: "lazuli.apps.todo.reveal", routines: "lazuli.apps.routines.reveal" });

/** The latest reveal request of an app, or null. */
export function revealIn(app) {
  const v = shared(REVEAL[app]);
  return v && typeof v === "object" && typeof v.key === "string" && typeof v.n === "number" ? v : null;
}

/** Shows an app in the center, on a row when `key` is given: that row is selected and revealed (an explicit link). */
export function openApp(app, key) {
  if (key !== undefined) {
    selectIn(app, key);
    if (key !== null) setShared(REVEAL[app], { key, n: (revealIn(app)?.n ?? 0) + 1 });
  }
  showCenter(app);
}
