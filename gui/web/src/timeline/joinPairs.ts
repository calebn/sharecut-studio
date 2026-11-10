import { clipRowDuringRoll, type RollPreview } from "../edit/clipEdgePreview";
import { isJoin } from "../edit/joinRender";
import { type ClipRow } from "../types/project";

interface JoinPair {
  id: string;
  left: ClipRow;
  right: ClipRow;
}

export function joinPairs(
  clips: readonly ClipRow[],
  roll: RollPreview | null,
  isMoving: (id: string) => boolean,
): readonly JoinPair[] {
  const pairs: JoinPair[] = [];
  for (let i = 1; i < clips.length; i += 1) {
    if (isMoving(clips[i - 1].id) || isMoving(clips[i].id)) {
      continue;
    }
    const left = clipRowDuringRoll(clips[i - 1], roll);
    const right = clipRowDuringRoll(clips[i], roll);
    if (isJoin(left, right)) {
      pairs.push({ id: `join-${right.id}`, left, right });
    }
  }
  return pairs;
}
