import type { ReactElement } from "react";
import type { ScriptSelection } from "../../../system/scriptPieces";
import { CommandButton } from "../../../ui/CommandButton";

// Focus moves to the head word before the command clears, so a keyboard user stays where they were reading.
export function clearSelectionAction(
  selection: ScriptSelection | null | undefined,
  refocus: (head: number) => void,
): ReactElement | undefined {
  if (selection?.kind !== "words") return undefined;
  return (
    <CommandButton
      commandId="edit.clearSelection"
      args={{ from: "script" }}
      variant="link"
      className="sys-script-tool"
      onClick={() => refocus(selection.head)}
    />
  );
}
