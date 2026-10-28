import { Inspector } from "../../inspector/Inspector";
import { useDawStore } from "../../state/dawStore";
import { CloseButton } from "../../ui/CloseButton";

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
