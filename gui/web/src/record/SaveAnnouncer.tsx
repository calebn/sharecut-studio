import { useEffect, useRef, useState } from "react";
import { type SaveLine, type SaveState, saveAnnouncement } from "./saveStatus";

/**
 * The one polite, screen-reader-only live region. It stays mounted so a later
 * change is announced. Visible save text never sits inside a live region, so a
 * chunk count that moves is read by sight and never spoken.
 */
export function PoliteAnnouncer({ message }: { message: string }) {
  return (
    <div aria-live="polite" className="sr-only">
      {message}
    </div>
  );
}

/** Speaks a save-list segment starting or finishing, never each chunk. */
export function SaveAnnouncer({ lines }: { lines: readonly SaveLine[] }) {
  const seen = useRef<ReadonlyMap<string, SaveState>>(new Map());
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const text = saveAnnouncement(seen.current, lines);
    seen.current = new Map(lines.map((line) => [line.key, line.state]));
    if (text) setAnnouncement(text);
  }, [lines]);
  return <PoliteAnnouncer message={announcement} />;
}
