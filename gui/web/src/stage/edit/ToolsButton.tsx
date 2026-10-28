import { useDawStore } from "../../state/dawStore";
import { Button, Icon } from "../../ui";

/** The header's Tools button: it opens the Tools sheet (the Edit controls a short frame folds away). */
export function ToolsButton() {
  const setOpenSheet = useDawStore((s) => s.setOpenSheet);
  return (
    <Button
      className="header-tools-button"
      title="Tools"
      aria-label="Tools"
      aria-haspopup="dialog"
      onClick={() => setOpenSheet("tools")}
    >
      <Icon name="timeline" />
    </Button>
  );
}
