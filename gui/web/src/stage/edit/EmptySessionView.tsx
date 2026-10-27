import type { DragEventHandler } from "react";

export interface EmptySessionViewProps {
  over: boolean;
  dropLabel: string;
  importShortcut: string | null;
  coachOpen: boolean;
  onDragOver: DragEventHandler<HTMLButtonElement>;
  onDragLeave: DragEventHandler<HTMLButtonElement>;
  onDrop: DragEventHandler<HTMLButtonElement>;
  onImport: () => void;
  onDismissCoach: () => void;
}

/** An episode with no tracks: the drop target and its one-time coach. */
export function EmptySessionView({
  over,
  dropLabel,
  importShortcut,
  coachOpen,
  onDragOver,
  onDragLeave,
  onDrop,
  onImport,
  onDismissCoach,
}: EmptySessionViewProps) {
  return (
    <div className="empty-session-wrap">
      <button
        type="button"
        className={`empty-session-drop${over ? " lane-drop-target" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onImport}
      >
        <span className="empty-session-ghost" aria-hidden="true" />
        <span className="empty-session-drop-label">{dropLabel}</span>
      </button>
      {coachOpen ? (
        <div className="box elevated empty-session-coach" role="status">
          <p>
            Drop stems here. Use one file per speaker. One recording of
            everyone? Import it, then choose Split speakers. Import is also in
            the + menu{importShortcut ? ` (${importShortcut})` : ""}.
          </p>
          <button
            type="button"
            className="empty-session-coach-dismiss"
            onClick={onDismissCoach}
          >
            Got it
          </button>
        </div>
      ) : null}
    </div>
  );
}
