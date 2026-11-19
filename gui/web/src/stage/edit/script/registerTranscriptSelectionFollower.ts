import {
  followSelection,
  type SelectionEnd,
  type SelectionModel,
  selectionEndOf,
} from "../../../edit/selectionFollow";
import { retimeKeeps } from "../../../edit/selectionRetime";
import {
  registerTranscriptSelectionFollower,
  type TranscriptSelectionJudge,
} from "../../../state/transcriptSelectionJudge";
import { scriptModelFor } from "./scriptHostModel";
import { selectionModelOfProject } from "./scriptSelectionModel";

function liveWords(model: SelectionModel, from: number, to: number) {
  const words: string[] = [];
  for (let at = from; at <= to; at++) {
    const ref = model.refs[at];
    const word = model.words[at];
    if (!ref || !word || model.cut?.[at]) continue;
    words.push(`${ref.trackId}|${ref.sourceId}|${word.start}|${word.text}`);
  }
  return words;
}

/** On the ordinary path, a word cut or retimed inside the run makes it a different run. */
function sameWords(
  before: SelectionModel,
  from: number,
  to: number,
  after: SelectionModel,
  at: number,
  end: number,
) {
  const was = liveWords(before, from, to);
  const now = liveWords(after, at, end);
  return was.length === now.length && was.every((word, i) => word === now[i]);
}

export const judgeWithScriptModel: TranscriptSelectionJudge = (
  from,
  sel,
  next,
) => {
  const clear = { kind: "clear" } as const;
  const before = scriptModelFor(from).model;
  const sourceId = sel.sourceId ?? null;
  const startAt = before.indexOf({
    trackId: sel.trackId,
    sourceId,
    wordIndex: sel.startWordIndex,
  });
  const endAt = before.indexOf(
    { trackId: sel.trackId, sourceId, wordIndex: sel.endWordIndex },
    "last",
  );
  const prior = selectionModelOfProject(from);
  const anchor: SelectionEnd | null =
    startAt === undefined ? null : selectionEndOf(prior, startAt);
  const head: SelectionEnd | null =
    endAt === undefined ? null : selectionEndOf(prior, endAt);
  if (!anchor || !head) return clear;
  const after = selectionModelOfProject(next);
  if (retimeKeeps(prior, after, anchor, head)) return { kind: "keep" };
  const follow = followSelection({ stored: sel, anchor, head }, after);
  if (follow.kind === "clear") return clear;
  if (follow.kind === "wait") return follow;
  const kept = follow.kind === "keep";
  const index = scriptModelFor(next).model.indexOf;
  const at = kept
    ? index({ trackId: sel.trackId, sourceId, wordIndex: sel.startWordIndex })
    : follow.anchor;
  const to = kept
    ? index(
        { trackId: sel.trackId, sourceId, wordIndex: sel.endWordIndex },
        "last",
      )
    : follow.head;
  if (at === undefined || to === undefined) return clear;
  if (!sameWords(prior, anchor.index, head.index, after, at, to)) return clear;
  if (kept) return { kind: "keep" };
  const first = after.refs[at]?.wordIndex;
  const last = after.refs[to]?.wordIndex;
  if (first == null || last == null) return clear;
  return { kind: "move", startWordIndex: first, endWordIndex: last };
};

registerTranscriptSelectionFollower(judgeWithScriptModel);
