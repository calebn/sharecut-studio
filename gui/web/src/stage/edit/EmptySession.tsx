import { useState } from "react";
import { runPointerCommand } from "../../commands/pointer";
import {
  audioFilesFromDrop,
  dismissIngestCoach,
  fileCountFromDataTransfer,
  isIngestCoachDismissed,
  newTracksDropLabel,
} from "../../ingest/dropLabels";
import { ingestFiles } from "../../ingest/ingestFiles";
import { displayShortcutFor } from "../../keymap/registry";
import { EmptySessionView } from "./EmptySessionView";

export type EmptySessionProps = {
  over: boolean;
  fileCount: number;
  onOverChange: (over: boolean, fileCount?: number) => void;
};

export function EmptySession({
  over,
  fileCount,
  onOverChange,
}: EmptySessionProps) {
  const importShortcut = displayShortcutFor("media.import") ?? null;
  const [coachOpen, setCoachOpen] = useState(() => !isIngestCoachDismissed());
  return (
    <EmptySessionView
      over={over}
      dropLabel={
        over
          ? newTracksDropLabel(fileCount)
          : `Drop audio files here, or import audio${importShortcut ? ` (${importShortcut})` : ""}`
      }
      importShortcut={importShortcut}
      coachOpen={coachOpen}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        onOverChange(
          true,
          Math.max(1, fileCountFromDataTransfer(e.dataTransfer)),
        );
      }}
      onDragLeave={() => onOverChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onOverChange(false);
        const files = audioFilesFromDrop(e.dataTransfer.files);
        if (files.length) void ingestFiles(files, { kind: "new" });
      }}
      onImport={() => runPointerCommand("media.import", {})}
      onDismissCoach={() => {
        dismissIngestCoach();
        setCoachOpen(false);
      }}
    />
  );
}
