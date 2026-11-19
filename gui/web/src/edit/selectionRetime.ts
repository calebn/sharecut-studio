import {
  endWaits,
  type SelectionEnd,
  type SelectionModel,
  selectionEndOf,
} from "./selectionFollow";

const SAME = 1e-6;

function sameRef(before: SelectionModel, after: SelectionModel, at: number) {
  const was = before.refs[at];
  const now = after.refs[at];
  return (
    !!was &&
    !!now &&
    was.trackId === now.trackId &&
    was.sourceId === now.sourceId &&
    was.wordIndex === now.wordIndex &&
    before.words[at]?.text === after.words[at]?.text &&
    (before.cut?.[at] ?? false) === (after.cut?.[at] ?? false)
  );
}

const startOf = (model: SelectionModel, at: number) =>
  model.words[at]?.start ?? Number.NaN;

/**
 * Whether the words `from..to` were retimed in place: the Script holds the
 * same words under the same numbers, recording and text, and only the source
 * start of words inside the run differs. Only each word's track, recording,
 * number and text, its cut state, and its start are compared; an end or a
 * timeline place is not. A retimed word must not now sit at or nearer to its
 * old start than an equal-text word of the same recording does, on either
 * side, so no neighbour can be taken for it. False when nothing in the run was
 * retimed.
 */
export function retimedInPlace(
  before: SelectionModel,
  after: SelectionModel,
  from: number,
  to: number,
): boolean {
  const count = before.words.length;
  if (after.words.length !== count || after.refs.length !== before.refs.length)
    return false;
  if (from < 0 || to < from || to >= count) return false;
  let retimed = false;
  for (let at = 0; at < count; at++) {
    if (!sameRef(before, after, at)) return false;
    const was = startOf(before, at);
    const now = startOf(after, at);
    if (!Number.isFinite(was) || !Number.isFinite(now)) return false;
    const moved = Math.abs(was - now) > SAME;
    if (moved && (at < from || at > to)) return false;
    if (!moved) continue;
    retimed = true;
    if (nearerRival(after, at, was, Math.abs(now - was))) return false;
  }
  return retimed;
}

function nearerRival(
  model: SelectionModel,
  at: number,
  oldStart: number,
  distance: number,
): boolean {
  const ref = model.refs[at];
  const text = model.words[at]?.text;
  for (let other = 0; other < model.words.length; other++) {
    if (other === at || model.cut?.[other]) continue;
    const rival = model.refs[other];
    if (
      rival?.trackId !== ref?.trackId ||
      rival?.sourceId !== ref?.sourceId ||
      model.words[other]?.text !== text
    )
      continue;
    if (Math.abs(startOf(model, other) - oldStart) <= distance) return true;
  }
  return false;
}

const liveAt = (model: SelectionModel, at: number) =>
  !model.cut?.[at] && model.wordStarts[at] != null;

/**
 * A retime keeps the run only while both ends are live words before and after
 * and neither sits in a line drawn as bars or has a held copy: otherwise the
 * follow decides, and it waits or clears.
 */
export function retimeKeeps(
  before: SelectionModel,
  after: SelectionModel,
  anchor: SelectionEnd,
  head: SelectionEnd,
): boolean {
  for (const end of [anchor, head]) {
    if (!liveAt(before, end.index)) return false;
    if (endWaits(after, end)) return false;
    const now = selectionEndOf(after, end.index);
    if (!now || endWaits(after, now)) return false;
  }
  return retimedInPlace(before, after, anchor.index, head.index);
}
