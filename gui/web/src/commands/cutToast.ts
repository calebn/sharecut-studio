import { cutHits } from "../stage/edit/script/cutHits";
import { scriptModelFor } from "../stage/edit/script/scriptHostModel";
import { wordKey } from "../stage/edit/script/scriptModel";
import { findMatches } from "../stages/edit/findMatches";
import { useDawStore } from "../state/dawStore";
import type { ToastAction } from "../state/types";
import { formatSeconds } from "../system/seconds";
import type {
  ExactRangeTarget,
  ProjectView,
  Selection,
} from "../types/project";
import { errorMessage } from "../utils/apiError";

export const CUT_ALL_MAX_HITS = 64;
const WORDS_MAX = 24;

type TranscriptRange = Extract<Selection, { kind: "transcriptRange" }>;

export type CutToast = { message: string; action?: ToastAction };

function shortWords(words: string): string {
  return words.length <= WORDS_MAX
    ? words
    : `${words.slice(0, WORDS_MAX - 1)}…`;
}

function cutAllAction(words: string, epoch: number): ToastAction {
  let running = false;
  return {
    label: "Cut all",
    run: async () => {
      if (running) return;
      running = true;
      try {
        const live = useDawStore.getState();
        if (!live.project || live.projectEpoch !== epoch)
          throw new Error("Open the project again to cut these.");
        const { model } = scriptModelFor(live.project);
        const hits = findMatches(model.turns, words, false);
        if (hits.length === 0) throw new Error("No more matches to cut.");
        await cutHits(model, hits);
      } catch (error) {
        useDawStore
          .getState()
          .announceStatus(errorMessage(error), { tone: "error" });
      } finally {
        running = false;
      }
    },
  };
}

/**
 * The toast for a words cut, worked out from the project as it was before the
 * cut: the other occurrences of the same words, minus the words just cut.
 * Cut all re-reads the live project when it is pressed.
 */
export function cutToastOf(
  project: ProjectView,
  selection: TranscriptRange,
  target: ExactRangeTarget,
  epoch: number,
  mayCut: boolean,
): CutToast | null {
  const { model, texts } = scriptModelFor(project);
  const cutKeys = new Set<string>();
  const cutTexts: string[] = [];
  for (let at = selection.startWordIndex; at <= selection.endWordIndex; at++) {
    const ref = {
      trackId: selection.trackId,
      sourceId: selection.sourceId ?? null,
      wordIndex: at,
    };
    const index = model.indexOf(ref);
    if (index === undefined) continue;
    cutKeys.add(wordKey(ref));
    cutTexts.push(texts[index]);
  }
  const words = cutTexts.join(" ");
  if (words === "") return null;
  const seconds = target.intervals.reduce(
    (sum, span) => sum + span.end - span.start,
    0,
  );
  const more = findMatches(model.turns, words, false).filter(
    (hit) =>
      !hit.indices.some((index) => cutKeys.has(wordKey(model.refs[index]))),
  ).length;
  const head = `Cut "${shortWords(words)}" · ${formatSeconds(seconds)}`;
  if (more === 0) return { message: head };
  return {
    message: `${head} · ${more} more`,
    action:
      mayCut && more <= CUT_ALL_MAX_HITS
        ? cutAllAction(words, epoch)
        : undefined,
  };
}
