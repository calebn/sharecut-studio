import type { DragEventHandler } from "react";
import { StartTile } from "../../system/StartTile";

export interface EmptySessionViewProps {
  over: boolean;
  fileCount: number;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
  onImport: () => void;
  onRecord: () => void;
}

/** An episode with no tracks: the two Start tiles, which also take dropped audio. */
export function EmptySessionView({
  over,
  fileCount,
  onDragOver,
  onDragLeave,
  onDrop,
  onImport,
  onRecord,
}: EmptySessionViewProps) {
  return (
    <div
      role="presentation"
      className="empty-session-wrap"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <section className="empty-session-tiles" aria-label="Start">
        <StartTile
          kind="import"
          size="160x96"
          state={over ? "drag-hover" : "rest"}
          dragCount={fileCount}
          onActivate={onImport}
        />
        <StartTile kind="record" size="160x96" onActivate={onRecord} />
      </section>
    </div>
  );
}
