import type { Ref } from "react";
import { useViewportClass } from "../../hooks/useViewportClass";
import { useDawStore } from "../../state/dawStore";
import { Button, Icon } from "../../ui";

/** The header's Tools button: it opens the Tools sheet (the Edit controls a short frame folds away). */
export function ToolsButton({ ref }: { ref?: Ref<HTMLButtonElement> }) {
  const setOpenSheet = useDawStore((s) => s.setOpenSheet);
  const surface = useDawStore((s) => s.editSurface);
  // On a phone the sheet opens on the Timeline / Script switch: name the one in use.
  const name =
    useViewportClass() === "phone"
      ? `Tools, ${surface === "text" ? "Script" : "Timeline"}`
      : "Tools";
  return (
    <Button
      ref={ref}
      className="header-tools-button"
      title="Tools"
      aria-label={name}
      aria-haspopup="dialog"
      onClick={() => setOpenSheet("tools")}
    >
      <Icon name="timeline" />
    </Button>
  );
}
