import { useCallback, useMemo } from "react";
import { seekTransport } from "../../../commands/seek";
import { useDawStore } from "../../../state/dawStore";
import { useStableCallback } from "../../../utils/useStableCallback";
import type { ScriptModel } from "./scriptModel";

type Timed = { index: number; start: number; end: number };

/** The words the playhead can sit in, by start; `reach[i]` is the latest end among entries 0..i. */
export type PlayIndex = { entries: Timed[]; reach: number[] };

/** Audible, timed words only: a cut, muted or bleed-row word never takes the highlight. */
export function playIndexOf(
  model: ScriptModel,
  silent: ReadonlySet<number>,
): PlayIndex {
  const entries: Timed[] = [];
  for (const turn of model.turns) {
    for (const word of turn.words) {
      if (silent.has(word.index) || word.mark?.kind === "muted") continue;
      const time = model.timeOf(word.index);
      if (time) entries.push({ index: word.index, ...time });
    }
  }
  entries.sort((a, b) => a.start - b.start || a.index - b.index);
  const reach: number[] = [];
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    latest = Math.max(latest, entry.end);
    reach.push(latest);
  }
  return { entries, reach };
}

/** The playing words and the last started word at `sec`, as one string: equal strings mean an equal highlight. */
export function playKeyAt(index: PlayIndex, sec: number): string {
  const { entries, reach } = index;
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].start <= sec) lo = mid + 1;
    else hi = mid;
  }
  const last = lo - 1;
  const playing: number[] = [];
  for (let at = last; at >= 0 && reach[at] > sec; at--) {
    if (entries[at].end > sec) playing.push(entries[at].index);
  }
  playing.sort((a, b) => a - b);
  return `${playing.join(",")}|${last >= 0 ? entries[last].index : ""}`;
}

export type ScriptPlaybackProps = {
  playing: readonly number[];
  playheadWord: number | undefined;
  /** Changes only when the highlight does. */
  playKey: string;
  following: boolean;
  onFollowChange: (follow: boolean) => void;
  onUserScroll: () => void;
  onSeek: (index: number) => void;
  onSeekTurn: (turnId: string) => void;
};

/**
 * Where the playhead is in the Script, and the clicks that move it. The
 * playhead is read through a selector that returns a string key, so a tick
 * re-renders the host only when a word starts or stops playing.
 */
export function useScriptPlayback(
  model: ScriptModel,
  silent: ReadonlySet<number>,
): ScriptPlaybackProps {
  const index = useMemo(() => playIndexOf(model, silent), [model, silent]);
  const playKey = useDawStore(
    useCallback(
      (s: { playheadSec: number }) => playKeyAt(index, s.playheadSec),
      [index],
    ),
  );
  const following = useDawStore((s) => s.transcriptFollowPlayhead);
  const { playing, playheadWord } = useMemo(() => {
    const [now = "", last = ""] = playKey.split("|");
    return {
      playing: now === "" ? [] : now.split(",").map(Number),
      playheadWord: last === "" ? undefined : Number(last),
    };
  }, [playKey]);

  const onFollowChange = useStableCallback((follow: boolean) =>
    useDawStore.getState().setTranscriptFollowPlayhead(follow),
  );
  const onUserScroll = useStableCallback(() => {
    if (useDawStore.getState().transcriptFollowPlayhead) onFollowChange(false);
  });
  const onSeek = useStableCallback((at: number) => {
    const sec = model.seekSecOf(at);
    if (sec !== null) void seekTransport(sec);
  });
  const onSeekTurn = useStableCallback((turnId: string) => {
    const turn = model.turns.find((candidate) => candidate.id === turnId);
    for (const word of turn?.words ?? []) {
      const sec = model.seekSecOf(word.index);
      if (sec !== null) {
        void seekTransport(sec);
        return;
      }
    }
  });

  return {
    playing,
    playheadWord,
    playKey,
    following,
    onFollowChange,
    onUserScroll,
    onSeek,
    onSeekTurn,
  };
}
