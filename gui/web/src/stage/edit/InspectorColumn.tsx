import { Inspector } from "../../inspector/Inspector";
import { useDawStore } from "../../state/dawStore";
import { CloseButton } from "../../ui/CloseButton";

/**
 * The desktop Inspector column. It is open because Inspect asked for it, so it
 * carries its own Close (Esc and a new selection shut it too).
 */
export function InspectorColumn() {
  const setInspectorOpen = useDawStore((s) => s.setInspectorOpen);
  return (
    <>
      <CloseButton
        className="edit-inspector-close"
        onClick={() => setInspectorOpen(false)}
      />
      <Inspector />
    </>
  );
}
