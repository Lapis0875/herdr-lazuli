// Small helpers the side panels share: whether a layout block is on screen, an agent's display name, and the
// mouse-down stopper that keeps a press inside a control (and out of a window's drag).

import { layout, agents } from "herdr";

/** Whether the layout block `id` is drawn as far as the layout says: nothing hidden on the way down, and every
 *  stack on the way showing the child that leads to it. Seeing it also needs the window in front. */
export function blockShown(id, node = layout()) {
  if (!node || typeof node !== "object" || node.hidden) return false;
  if (node.id === id) return true;
  const kids = node.children ?? [];
  if (node.active) {
    const shown = kids.find((c) => c.id === node.active);
    return Boolean(shown) && blockShown(id, shown);
  }
  return kids.some((c) => blockShown(id, c)) || (node.floating ?? []).some((c) => blockShown(id, c));
}

/** The name an agent goes by: its tab's name, else its program's, else its address. */
export function agentLabel(address) {
  if (!address) return null;
  const a = (agents() ?? []).find((x) => x.address === address);
  return (a?.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : null) ?? a?.program?.name ?? address;
}

/** Keeps a press on this element from reaching the elements under it (or dragging a window). */
export const stopPress = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
