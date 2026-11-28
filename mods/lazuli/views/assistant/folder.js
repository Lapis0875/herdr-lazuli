// Choosing the Assistant's folder (D3, D22, A2), shared by the settings row and the folder gates: the service opens
// the folder picker and switches at once when no turn runs (`pickFolder` → `{ok, path}`); with a turn running it
// answers `{error: "busy", path}` and the owner asks before `setFolder(cx, path, {confirmed: true})` cancels the
// turn and restarts the bridges there. `owner.folderAsk` holds the open question, `owner.folderError` the last error.

import { home } from "herdr";
import { t } from "../../core/i18n.js";
import { Text } from "../../ui/kit.js";
import { Dialog } from "../apps/ui.js";
import { tilde } from "../apps/fmt.js";
import { errorText } from "./common.js";

/** Opens the picker through `svc`; a busy answer opens the confirmation. `after(cx, result)` runs once it settles. */
export function chooseFolder(owner, svc, cx, after) {
  owner.folderError = null;
  cx.spawn(async (cx) => {
    const r = await svc.pickFolder(cx);
    if (r?.error === "busy" && r.path) owner.folderAsk = { path: r.path };
    else if (r?.error && r.error !== "cancelled") owner.folderError = errorText(r.error);
    after?.(cx, r);
    cx.notify();
  });
}

/** The D22 question over the owner's view while `owner.folderAsk` is set: keep the turn, or stop it and switch. */
export function FolderConfirm(owner, svc, current, after) {
  const ask = owner.folderAsk;
  if (!ask) return null;
  const cancel = (_e, cx) => {
    owner.folderAsk = null;
    cx.notify();
  };
  return Dialog({
    id: "lz-folder-ask",
    title: t("settings.assistant.confirmTitle"),
    body: Text(t("settings.assistant.confirmBody", { folder: current ? tilde(current, home()) : t("settings.assistant.unset"), next: tilde(ask.path, home()) }), { tone: "secondary" }),
    onDismiss: cancel,
    dismissLabel: t("common.close"),
    actions: [
      { id: "lz-folder-ask-cancel", label: t("common.cancel"), onClick: cancel },
      {
        id: "lz-folder-ask-ok",
        label: t("settings.assistant.confirm"),
        variant: "primary",
        onClick: (_e, cx) => {
          owner.folderAsk = null;
          cx.spawn(async (cx) => {
            const r = await svc.setFolder(cx, ask.path, { confirmed: true });
            owner.folderError = r?.error ? errorText(r.error) : null;
            after?.(cx, r);
            cx.notify();
          });
          cx.notify();
        },
      },
    ],
  });
}
