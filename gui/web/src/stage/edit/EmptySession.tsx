import { runPointerCommand } from "../../commands/pointer";
import { EmptySessionView } from "./EmptySessionView";
import type { AudioDrop } from "./useAudioDrop";

export type EmptySessionProps = {
  drop: AudioDrop;
};

export function EmptySession({
  drop: { over, fileCount, handlers },
}: EmptySessionProps) {
  return (
    <EmptySessionView
      over={over}
      fileCount={fileCount}
      {...handlers}
      onImport={() => runPointerCommand("media.import", {})}
      onRecord={() => runPointerCommand("stage.record")}
    />
  );
}
