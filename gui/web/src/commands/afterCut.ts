import { useDawStore } from "../state/dawStore";
import { afterCutPick } from "./afterCutHost";
import { registerCommand } from "./execute";

export function registerAfterCutCommands(): void {
  registerCommand("edit.nextOccurrence", (args) => {
    const state = useDawStore.getState();
    const { afterCut, project } = state;
    const direction = args.shift === true ? "prev" : "next";
    const pick =
      afterCut && project ? afterCutPick(project, afterCut, direction) : null;
    if (!afterCut || !pick)
      return { status: "disabled", reason: "No other matches to jump to" };
    state.setSelection(pick.selection);
    const live = useDawStore.getState();
    live.setAfterCut({
      ...afterCut,
      selected:
        live.selection?.kind === "transcriptRange" ? live.selection : null,
      at: pick.at,
      startedAt: pick.startedAt,
      direction,
    });
    live.requestEditWordReveal({ ...pick.at, focus: true });
    live.announceStatus(`"${pick.words}", ${pick.ordinal} of ${pick.total}`, {
      toast: false,
    });
    return { status: "ok" };
  });
}
