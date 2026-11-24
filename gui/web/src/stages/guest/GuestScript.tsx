import { useEffect, useMemo, useRef } from "react";
import { clearSelectionAction } from "../../stage/hosts/clearSelectionAction";
import type { GuestScriptModel } from "../../stage/hosts/guestScript";
import { Cover } from "../../system/Cover";
import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";
import {
  type ScriptGuest,
  ScriptPane,
  type ScriptPaneHandle,
} from "../../system/ScriptPane";
import type {
  ScriptSelection,
  WordsSelection,
} from "../../system/scriptPieces";
import { GUEST_EMPTY_COPY } from "./guestLogic";
import { type GuestReading, useGuestReading } from "./useGuestReading";

export type GuestScriptProps = {
  guest?: ScriptGuest;
  layout: "desktop" | "phone";
  script: GuestScriptModel;
  playing: number | readonly number[] | undefined;
  playheadWord?: number;
  /** Some lines are still being refreshed: the pane says so and follow mode holds still. */
  refreshing?: boolean;
  selectionRefreshing?: boolean;
  onSeek: (seconds: number) => void;
  /** A tap or Enter landed on a word whose time is not known yet. */
  onHeldWord?: () => void;
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
  script,
  playing,
  playheadWord,
  refreshing = false,
  selectionRefreshing = false,
  onSeek,
  onHeldWord,
  onUserScroll,
  selection,
  onSelect,
  onClearSelection,
  reading: providedReading,
}: GuestScriptProps) {
  const { turns, wordStarts, empty } = script;
  const reading = useGuestReading(providedReading);
  const pane = useRef<ScriptPaneHandle>(null);
  const readingPosition = useMemo(
    () => ({
      getPosition: () => reading.getPosition(script),
      capture: (position: ScriptPaneReadingPosition) =>
        reading.capture(position, script),
      // A follower is restored from where it was looking while lines refresh.
      restore: !reading.following || refreshing,
    }),
    [reading, script, refreshing],
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
      selectionRefreshing={selectionRefreshing}
      selection={selection}
      onSelect={onSelect}
      onPrimary={
        onSelect && selection?.kind === "words"
          ? () => {
              const start =
                wordStarts[Math.min(selection.anchor, selection.head)];
              if (start != null) onSeek(start);
              else onHeldWord?.();
            }
          : undefined
      }
      headerAction={
        onClearSelection ? clearSelectionAction(selection, pane) : undefined
      }
      onClearSelection={onClearSelection}
      onSeek={(index) => {
        const start = wordStarts[index];
        if (start != null) onSeek(start);
        else onHeldWord?.();
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
