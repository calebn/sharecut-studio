import { type DragEvent, useCallback, useMemo, useState } from "react";
import {
  NOT_A_SEGMENT_FILE,
  ONE_FILE_ONLY,
  SEGMENT_EXTENSION,
  WAIT_TO_DROP,
  ZIP_TYPE,
} from "./importMessages";

type Options = {
  enabled: boolean;
  onFile: (file: File) => void;
  onRefuse: (message: string) => void;
};

export type SegmentDrop = {
  over: boolean;
  handlers: {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
};

function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * Drop handlers for the library list. Every file drag is claimed so the browser never opens
 * the file; one `.sharecutseg` or zip file is imported, anything else (or a drop while busy,
 * or on the preview sheet that portals out of the list) is refused or ignored.
 */
export function useSegmentDrop({
  enabled,
  onFile,
  onRefuse,
}: Options): SegmentDrop {
  const [over, setOver] = useState(false);
  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (!enabled) return;
      event.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    [enabled],
  );
  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOver(false);
    }
  }, []);
  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setOver(false);
      if (!event.currentTarget.contains(event.target as Node)) return;
      if (!enabled) {
        onRefuse(WAIT_TO_DROP);
        return;
      }
      const files = Array.from(event.dataTransfer.files).filter(
        (file) =>
          file.name.toLowerCase().endsWith(SEGMENT_EXTENSION) ||
          file.type === ZIP_TYPE,
      );
      if (files.length === 0) onRefuse(NOT_A_SEGMENT_FILE);
      else if (files.length > 1) onRefuse(ONE_FILE_ONLY);
      else onFile(files[0] as File);
    },
    [enabled, onFile, onRefuse],
  );
  const handlers = useMemo(
    () => ({ onDragOver, onDragLeave, onDrop }),
    [onDragOver, onDragLeave, onDrop],
  );
  return { over, handlers };
}
