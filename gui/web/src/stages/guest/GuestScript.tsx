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
import { type GuestReading, useGuestReading } from "./useGuestReading";

export type GuestScriptProps = {
  guest?: ScriptGuest;
  layout: "desktop" | "phone";
  turns: readonly ScriptTurn[];
  wordStarts: readonly number[];
  playing: number | readonly number[] | undefined;
  playheadWord?: number;
  empty?: GuestEmpty;
  onSeek: (seconds: number) => void;
  onUserScroll?: () => void;
  /** Given with `onSelect` to a guest who may suggest edits; left out, the pane only reads. */
  selection?: ScriptSelection | null;
  onSelect?: (selection: WordsSelection) => void;
  onClearSelection?: () => void;
  reading?: GuestReading;
};

function wordKeyAt(turns: readonly ScriptTurn[], index: number) {
  for (const turn of turns) {
    const word = turn.words.find((word) => word.index === index);
    if (word) return word.key;
  }
  return undefined;
}

export function GuestScript({
  guest,
  layout,
  turns,
  wordStarts,
  playing,
  playheadWord,
  empty = "none",
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
        if (
          position?.kind !== "word" ||
          !position.turns ||
          position.turns === turns
        )
          return position;
        const key = wordKeyAt(position.turns, position.index);
        return key !== undefined && key === wordKeyAt(turns, position.index)
          ? { ...position, turns }
          : position;
      },
      capture: reading.capture,
      restore: !reading.following,
    }),
    [reading, turns],
  );
  const first =
    (typeof playing === "number" ? playing : playing?.[0]) ?? playheadWord;
  useEffect(() => {
    if (reading.following && first !== undefined)
      pane.current?.scrollToWord(first, "nearest");
  }, [reading.following, first]);
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
      selection={selection}
      onSelect={onSelect}
      onPrimary={
        onSelect && selection?.kind === "words"
          ? () => {
              const start =
                wordStarts[Math.min(selection.anchor, selection.head)];
              if (start !== undefined) onSeek(start);
            }
          : undefined
      }
      onClearSelection={onClearSelection}
      onSeek={(index) => {
        const start = wordStarts[index];
        if (start !== undefined) onSeek(start);
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
