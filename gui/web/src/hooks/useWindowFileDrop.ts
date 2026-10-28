import { useEffect, useRef, useState } from "react";
import {
  audioFilesFromDrop,
  fileCountFromDataTransfer,
} from "../ingest/dropLabels";

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Audio dragged over the window: `active` is true while files are over it, and a
 * drop hands the audio files to `onFiles`. Counted enter and leave events, so
 * crossing child elements does not flicker it off.
 */
export function useWindowFileDrop(
  enabled: boolean,
  onFiles: (files: File[]) => void,
): { active: boolean; count?: number } {
  const [state, setState] = useState<{ active: boolean; count?: number }>({
    active: false,
  });
  const latest = useRef(onFiles);
  useEffect(() => {
    latest.current = onFiles;
  });
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const end = () => {
      depth = 0;
      setState({ active: false });
    };
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      const count = fileCountFromDataTransfer(event.dataTransfer);
      setState({ active: true, count: count > 0 ? count : undefined });
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) end();
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      end();
      const files = audioFilesFromDrop(event.dataTransfer?.files ?? []);
      if (files.length > 0) latest.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
      end();
    };
  }, [enabled]);
  return state;
}
