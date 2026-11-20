import { useLongPress } from "../hooks/useLongPress";
import { type CoachHint, CoachTip } from "./CoachTip";
import { VerbButton } from "./VerbButton";

export type HistoryButtonsProps = {
  loading?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  undoReason?: string;
  redoReason?: string;
  undoHint?: CoachHint;
  onUndo?: () => void;
  onRedo?: () => void;
  onHistory?: () => void;
};

export function HistoryButtons({
  placement = "header",
  narrowRedo = false,
  loading = false,
  canUndo = true,
  canRedo = true,
  undoReason,
  redoReason,
  undoHint,
  onUndo,
  onRedo,
  onHistory,
}: HistoryButtonsProps & {
  placement?: "header" | "player";
  narrowRedo?: boolean;
}) {
  const historyPress = useLongPress(() => onHistory?.());
  return (
    <span
      className={
        placement === "player" ? "sys-player-history" : "sys-header-history"
      }
      onContextMenu={
        onHistory
          ? (event) => {
              event.preventDefault();
              onHistory();
            }
          : undefined
      }
      {...(onHistory ? historyPress : {})}
    >
      <CoachTip
        edge
        align="end"
        placement={placement === "player" ? "above" : "below"}
        text={undoHint?.text ?? ""}
        shown={undoHint?.shown ?? false}
        onDismiss={undoHint?.onDismiss}
      >
        <VerbButton
          verb="undo"
          disabled={loading || !canUndo}
          {...(loading || canUndo ? {} : { title: undoReason })}
          onClick={onUndo}
        />
      </CoachTip>
      <VerbButton
        verb="redo"
        className={narrowRedo ? "sys-header-redo" : undefined}
        disabled={loading || !canRedo}
        {...(loading || canRedo ? {} : { title: redoReason })}
        onClick={onRedo}
      />
    </span>
  );
}
