import { PlayerChapters } from "../../system/PlayerChapters";
import { usePlayerChapters } from "./usePlayerChapters";

/** The project's chapters as a list; a row seeks, then tells the caller (the Chapters sheet closes on it). */
export function ChaptersList({ onPicked }: { onPicked?: () => void }) {
  const { chapters, current, seekTo } = usePlayerChapters();
  return (
    <PlayerChapters
      chapters={chapters}
      current={current}
      onChapter={(index) => {
        seekTo(index);
        onPicked?.();
      }}
    />
  );
}
