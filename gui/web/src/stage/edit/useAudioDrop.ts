import { type DragEvent, useCallback, useMemo, useState } from "react";
import {
  audioFilesFromDrop,
  fileCountFromDataTransfer,
} from "../../ingest/dropLabels";
import { ingestFiles } from "../../ingest/ingestFiles";

export interface AudioDropHandlers {
  onDragOver: (e: DragEvent<HTMLButtonElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLButtonElement>) => void;
}

export interface AudioDrop {
  /** Audio is held over a drop target. */
  over: boolean;
  /** How many files are held over it (at least 1). */
  fileCount: number;
  handlers: AudioDropHandlers;
}

/** Drop state and handlers for a target that turns dropped audio into new tracks. */
export function useAudioDrop(): AudioDrop {
  const [over, setOver] = useState(false);
  const [fileCount, setFileCount] = useState(1);
  const onDragOver = useCallback((e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setOver(true);
    setFileCount(Math.max(1, fileCountFromDataTransfer(e.dataTransfer)));
  }, []);
  const onDragLeave = useCallback(() => setOver(false), []);
  const onDrop = useCallback((e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setOver(false);
    const files = audioFilesFromDrop(e.dataTransfer.files);
    if (files.length) void ingestFiles(files, { kind: "new" });
  }, []);
  const handlers = useMemo(
    () => ({ onDragOver, onDragLeave, onDrop }),
    [onDragOver, onDragLeave, onDrop],
  );
  return { over, fileCount, handlers };
}
