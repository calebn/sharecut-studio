import { useDawStore } from "../state/dawStore";
import { afterCutPick } from "./afterCutHost";
import { transcriptLoading, untilCutSettled } from "./afterCutWindow";
import { afterCutHolds } from "./context";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

const NONE: ExecuteResult = {
  status: "disabled",
  reason: "No other matches to jump to",
};

function jump(shift: boolean): ExecuteResult {
  const state = useDawStore.getState();
  const { afterCut, project } = state;
  const direction = shift ? "prev" : "next";
  const pick =
    afterCut && project && afterCutHolds(state)
      ? afterCutPick(project, afterCut, direction)
      : null;
  if (!afterCut || !pick) return NONE;
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
}

export function registerAfterCutCommands(): void {
  registerCommand("edit.nextOccurrence", (args) => {
    const shift = args.shift === true;
    const state = useDawStore.getState();
    if (!state.rangeBusy && !transcriptLoading(state.project))
      return jump(shift);
    return untilCutSettled(state.projectEpoch).then((settled) =>
      settled ? jump(shift) : NONE,
    );
  });
}
