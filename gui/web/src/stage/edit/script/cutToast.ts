import {
  type CutToast,
  registerCutToastBuilder,
} from "../../../commands/cutToastHost";
import { findMatches } from "../../../stages/edit/findMatches";
import { useDawStore } from "../../../state/dawStore";
import type { ToastAction } from "../../../state/types";
import { formatSeconds } from "../../../system/seconds";
import type {
  ExactRangeTarget,
  ProjectView,
  Selection,
} from "../../../types/project";
import { errorMessage } from "../../../utils/apiError";
import { cutHits } from "./cutHits";
import { type ScriptHostModel, scriptModelFor } from "./scriptHostModel";
import { wordKey } from "./scriptModel";

const CUT_ALL_MAX_HITS = 64;
const WORDS_MAX = 24;

type TranscriptRange = Extract<Selection, { kind: "transcriptRange" }>;

export function shortWords(words: string): string {
  return words.length <= WORDS_MAX
    ? words
    : `${words.slice(0, WORDS_MAX - 1)}…`;
}

function cuttableHits(
  { model, cutAway }: ScriptHostModel,
  words: string,
  cutKeys: ReadonlySet<string>,
) {
  return findMatches(model.turns, words, false).filter(
    (hit) =>
      !hit.indices.some((index) => {
        const key = wordKey(model.refs[index]);
        return cutKeys.has(key) || cutAway.has(key);
      }),
  );
}

export function navigableHits(
  host: ScriptHostModel,
  words: string,
  cutKeys: ReadonlySet<string>,
) {
  const { refs } = host.model;
  return cuttableHits(host, words, cutKeys).filter((hit) => {
    const first = refs[hit.indices[0]];
    return hit.indices.every((index) => {
      const ref = refs[index];
      return (
        ref.wordIndex != null &&
        ref.trackId === first.trackId &&
        ref.sourceId === first.sourceId
      );
    });
  });
}

function cutAllAction(
  words: string,
  epoch: number,
  cutKeys: ReadonlySet<string>,
): ToastAction {
  let running = false;
  const action: ToastAction = {
    label: "Cut all",
    run: async () => {
      if (running) return;
      running = true;
      const shown = useDawStore.getState().feedbackToast;
      const undo = shown?.action === action ? shown.undo : null;
      try {
        const live = useDawStore.getState();
        if (!live.project || live.projectEpoch !== epoch)
          throw new Error("Open the project again to cut these.");
        const hostModel = scriptModelFor(live.project);
        const hits = cuttableHits(hostModel, words, cutKeys);
        if (hits.length === 0) throw new Error("No more matches to cut.");
        await cutHits(hostModel.model, hits);
      } catch (error) {
        useDawStore
          .getState()
          .announceStatus(errorMessage(error), { tone: "error", undo });
      } finally {
        running = false;
      }
    },
  };
  return action;
}

function buildCutToast(
  project: ProjectView,
  selection: TranscriptRange,
  target: ExactRangeTarget,
  epoch: number,
): CutToast | null {
  const hostModel = scriptModelFor(project);
  const { model, texts } = hostModel;
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
  const previous = useDawStore.getState().afterCut;
  const base = project.history?.head_id ?? null;
  if (
    previous &&
    previous.epoch === epoch &&
    (base === previous.head || base === previous.baseHead)
  )
    for (const key of previous.cutKeys) cutKeys.add(key);
  const seconds = target.intervals.reduce(
    (sum, span) => sum + span.end - span.start,
    0,
  );
  const more = navigableHits(hostModel, words, cutKeys).length;
  const head = `Cut "${shortWords(words)}" · ${formatSeconds(seconds)}`;
  if (more === 0) return { message: head };
  return {
    message: `${head} · ${more} more`,
    follow: { words, cutKeys: [...cutKeys] },
    action:
      more <= CUT_ALL_MAX_HITS
        ? cutAllAction(words, epoch, cutKeys)
        : undefined,
  };
}

export function registerCutToast(): void {
  registerCutToastBuilder(buildCutToast);
}
