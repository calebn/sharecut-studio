import { submitDocumentCommand } from "../api";
import { useDawStore } from "../state/dawStore";
import { DocumentCommand } from "../types/documentCommands.generated";
import type { ExactRangeTarget } from "../types/project";

export function submitRangeEdit(
  action: "cut" | "mute",
  targets: readonly ExactRangeTarget[],
) {
  return submitDocumentCommand(
    useDawStore.getState().projectPath,
    DocumentCommand.EditSelectedRange,
    { action, targets },
  );
}
