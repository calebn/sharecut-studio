import type { PlayerChapter } from "./Player";

/** The chapter list: one row per chapter, the current one marked. Shared by the expanded Player and the Chapters sheet. */
export function PlayerChapters({
  chapters,
  current,
  onChapter,
}: {
  chapters: readonly PlayerChapter[];
  current?: number;
  onChapter?: (index: number) => void;
}) {
  if (chapters.length === 0) return null;
  return (
    <ol className="sys-player-chapters" aria-label="Chapters">
      {chapters.map((entry, index) => (
        <li key={entry.title}>
          <button
            type="button"
            className="sys-row-btn"
            aria-current={index === current ? "true" : undefined}
            onClick={() => onChapter?.(index)}
          >
            <span className="sys-row-title">{entry.title}</span>
            <span className="sys-mono">{entry.time}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
