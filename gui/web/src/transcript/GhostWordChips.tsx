import type { GhostWord } from "../edit/ghostPreview";

type Props = {
  words: readonly GhostWord[];
  /** Accessible label for the ghost region. */
  label?: string;
};

/**
 * Faded cutaway words shown while expanding a clip edge / rolling a join —
 * transcript counterpart to timeline ``.clip-trim-ghost``.
 */
export function GhostWordChips({ words, label }: Props) {
  if (words.length === 0) {
    return null;
  }
  return (
    <span
      role="group"
      className="edit-ghost-words daw-ghost-preview"
      aria-label={label ?? "Preview restored words"}
    >
      {words.map((w) => (
        <span
          key={`${w.track_id}-${w.word_index}-${w.start}`}
          className="edit-ghost-word"
        >
          {w.text}
        </span>
      ))}
    </span>
  );
}
