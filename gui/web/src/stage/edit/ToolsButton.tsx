import { useShallow } from "zustand/react/shallow";
import { useDawStore } from "../../state/dawStore";
import { Button, Icon } from "../../ui";
import type { IconName } from "../../ui/Icon";

/** The header's Tools button: it opens the Tools sheet and shows the tool in use. */
export function ToolsButton() {
  const { toolMode, commentMode, rangeArmed, setOpenSheet } = useDawStore(
    useShallow((s) => ({
      toolMode: s.toolMode,
      commentMode: s.commentMode,
      rangeArmed: s.rangeArmed,
      setOpenSheet: s.setOpenSheet,
    })),
  );
  const active: IconName = commentMode
    ? "comment"
    : rangeArmed
      ? "range"
      : toolMode === "blade"
        ? "blade"
        : "select";
  return (
    <Button
      className="header-tools-button"
      title="Tools"
      aria-label="Tools"
      aria-haspopup="dialog"
      data-tool={active}
      onClick={() => setOpenSheet("tools")}
    >
      <Icon name={active} />
    </Button>
  );
}
