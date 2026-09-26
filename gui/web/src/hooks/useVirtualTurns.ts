/**
 * Virtualize transcript turns once a transcript is large; a thin wrapper over
 * the shared {@link useVirtualRows} with turn keys and a turn height estimate.
 */

import { type RefObject, useCallback } from "react";
import { type TranscriptTurn, turnKey } from "../utils/transcript";
import { useVirtualRows, type VirtualRows } from "./useVirtualRows";

/** Initial per-turn height estimate before measurement. */
export const TURN_ESTIMATE_REM = 6;

export function useVirtualTurns(
  listRef: RefObject<HTMLElement | null>,
  turns: TranscriptTurn[],
  pinned: readonly number[],
): VirtualRows {
  const getItemKey = useCallback(
    (index: number) => {
      const turn = turns[index];
      return turn ? turnKey(turn) : index;
    },
    [turns],
  );
  return useVirtualRows(listRef, {
    count: turns.length,
    getItemKey,
    estimateRem: TURN_ESTIMATE_REM,
    pinned,
  });
}
