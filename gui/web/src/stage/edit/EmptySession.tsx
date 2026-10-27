import { useState } from "react";
import { runPointerCommand } from "../../commands/pointer";
import {
  dismissIngestCoach,
  isIngestCoachDismissed,
  newTracksDropLabel,
} from "../../ingest/dropLabels";
import { displayShortcutFor } from "../../keymap/registry";
import { EmptySessionView } from "./EmptySessionView";
import type { AudioDrop } from "./useAudioDrop";

export type EmptySessionProps = {
  drop: AudioDrop;
};

export function EmptySession({
  drop: { over, fileCount, handlers },
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
      {...handlers}
      onImport={() => runPointerCommand("media.import", {})}
      onDismissCoach={() => {
        dismissIngestCoach();
        setCoachOpen(false);
      }}
    />
  );
}
