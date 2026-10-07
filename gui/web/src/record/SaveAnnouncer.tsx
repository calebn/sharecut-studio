import { useEffect, useRef, useState } from "react";
import { type SaveLine, type SaveState, saveAnnouncement } from "./saveStatus";

/**
 * A polite, screen-reader-only live region for the save lists. It stays
 * mounted so a later change is announced, and speaks a segment starting or
 * finishing, not each chunk.
 */
export function SaveAnnouncer({ lines }: { lines: readonly SaveLine[] }) {
  const seen = useRef<ReadonlyMap<string, SaveState>>(new Map());
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const text = saveAnnouncement(seen.current, lines);
    seen.current = new Map(lines.map((line) => [line.key, line.state]));
    if (text) setAnnouncement(text);
  }, [lines]);
  return (
    <div aria-live="polite" className="sr-only">
      {announcement}
    </div>
  );
}
