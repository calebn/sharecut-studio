import { useEffect, useMemo, useRef } from "react";
import { Cover } from "../../system/Cover";
import {
  type ScriptGuest,
  ScriptPane,
  type ScriptPaneHandle,
} from "../../system/ScriptPane";
import type {
  ScriptSelection,
  ScriptTurn,
  WordsSelection,
} from "../../system/scriptPieces";
import { GUEST_EMPTY_COPY, type GuestEmpty } from "./guestLogic";
import { rebaseReading } from "./rebaseReading";
import { type GuestReading, useGuestReading } from "./useGuestReading";

export type GuestScriptProps = {
  guest?: ScriptGuest;
  layout: "desktop" | "phone";
  turns: readonly ScriptTurn[];
  /** Where a tap on each word seeks; null for a word whose time is not known yet. */
  wordStarts: readonly (number | null)[];
  playing: number | readonly number[] | undefined;
  playheadWord?: number;
  empty?: GuestEmpty;
  /** Some lines are still being refreshed: the pane says so and follow mode holds still. */
  refreshing?: boolean;
  onSeek: (seconds: number) => void;
  onUserScroll?: () => void;
  /** Given with `onSelect` to a guest who may suggest edits; left out, the pane only reads. */
  selection?: ScriptSelection | null;
  onSelect?: (selection: WordsSelection) => void;
  onClearSelection?: () => void;
  reading?: GuestReading;
};

export function GuestScript({
  guest,
  layout,
  turns,
  wordStarts,
  playing,
  playheadWord,
  empty = "none",
  refreshing = false,
  onSeek,
  onUserScroll,
  selection,
  onSelect,
  onClearSelection,
  reading: providedReading,
}: GuestScriptProps) {
  const reading = useGuestReading(providedReading);
  const pane = useRef<ScriptPaneHandle>(null);
  const readingPosition = useMemo(
    () => ({
      getPosition: () => {
        const position = reading.getPosition();
        return position?.kind === "word"
          ? rebaseReading(position, turns)
          : position;
      },
      capture: reading.capture,
      // A follower is restored from where it was looking while lines refresh.
      restore: !reading.following || refreshing,
    }),
    [reading, turns, refreshing],
  );
  const first =
    (typeof playing === "number" ? playing : playing?.[0]) ?? playheadWord;
  // A follower has no bookmark outside a hold: the next one starts afresh.
  useEffect(() => {
    if (!refreshing && reading.following) reading.setFollowing(true);
  }, [refreshing, reading]);
  useEffect(() => {
    if (reading.following && !refreshing && first !== undefined)
      pane.current?.scrollToWord(first, "nearest");
  }, [reading.following, refreshing, first]);
  if (turns.length === 0) {
    return (
      <Cover size="region" glyph="inbox" title="Nothing to read yet">
        {GUEST_EMPTY_COPY[empty]}
      </Cover>
    );
  }
  return (
    <ScriptPane
      ref={pane}
      turns={turns}
      layout={layout}
      guest={guest}
      playing={playing}
      playheadWord={playheadWord}
      following={reading.following}
      busy={refreshing}
      selection={selection}
      onSelect={onSelect}
      onPrimary={
        onSelect && selection?.kind === "words"
          ? () => {
              const start =
                wordStarts[Math.min(selection.anchor, selection.head)];
              if (start != null) onSeek(start);
            }
          : undefined
      }
      onClearSelection={onClearSelection}
      onSeek={(index) => {
        const start = wordStarts[index];
        if (start != null) onSeek(start);
      }}
      onUserScroll={() => {
        reading.setFollowing(false);
        onUserScroll?.();
      }}
      onBackToPlayhead={() => {
        reading.setFollowing(true);
        if (first !== undefined) pane.current?.scrollToWord(first, "center");
      }}
      onFollowChange={reading.setFollowing}
      readingPosition={readingPosition}
    />
  );
}
