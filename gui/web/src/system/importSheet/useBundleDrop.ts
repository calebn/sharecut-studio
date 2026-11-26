import { type DragEvent, useCallback, useMemo, useState } from "react";
import { WAIT_TO_DROP } from "./importCopy";

type Options = {
  enabled: boolean;
  /** Which dropped files are the kind this list imports. */
  accepts: (file: File) => boolean;
  /** What to say when none of the dropped files is. */
  refusal: string;
  /** What to say when more than one of them is. */
  oneFileOnly: string;
  onFile: (file: File) => void;
  onRefuse: (message: string) => void;
};

export type BundleDrop = {
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
 * Drop handlers for a library list. Every file drag is claimed so the browser never opens
 * the file; one matching file is imported, anything else (or a drop while busy, or on the
 * preview sheet that portals out of the list) is refused or ignored.
 */
export function useBundleDrop({
  enabled,
  accepts,
  refusal,
  oneFileOnly,
  onFile,
  onRefuse,
}: Options): BundleDrop {
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
      const files = Array.from(event.dataTransfer.files).filter(accepts);
      if (files.length === 0) onRefuse(refusal);
      else if (files.length > 1) onRefuse(oneFileOnly);
      else onFile(files[0] as File);
    },
    [enabled, accepts, refusal, oneFileOnly, onFile, onRefuse],
  );
  const handlers = useMemo(
    () => ({ onDragOver, onDragLeave, onDrop }),
    [onDragOver, onDragLeave, onDrop],
  );
  return { over, handlers };
}
