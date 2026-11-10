import {
  makeRangeTarget,
  resolveSelectionRange,
} from "../../../edit/rangeSelection";
import type { FindHit } from "../../../system/scriptPieces";
import type {
  ExactRangeTarget,
  ProjectView,
  TimelineSpan,
} from "../../../types/project";
import type { ScriptModel } from "./scriptModel";

const MAX_CUT_INTERVALS = 1000;
const MAX_CUT_TARGETS = 64;

export type MatchCut = {
  targets: ExactRangeTarget[];
  cut: number;
  skipped: number;
};

export function matchCutOf(
  project: ProjectView,
  model: ScriptModel,
  hits: readonly FindHit[],
): MatchCut {
  const groups = new Map<
    string,
    { trackIds: string[]; spans: TimelineSpan[]; hits: number }
  >();
  let skipped = 0;
  for (const hit of hits) {
    const refs = hit.indices.map((index) => model.refs[index]);
    const first = refs[0];
    const words = refs.flatMap((ref) =>
      ref?.wordIndex == null ? [] : [ref.wordIndex],
    );
    if (!first || words.length === 0) {
      skipped++;
      continue;
    }
    const { targets } = resolveSelectionRange(project, {
      kind: "transcriptRange",
      trackId: first.trackId,
      sourceId: first.sourceId,
      startWordIndex: Math.min(...words),
      endWordIndex: Math.max(...words),
    });
    const [target] = targets;
    if (targets.length !== 1 || !target) {
      skipped++;
      continue;
    }
    const trackIds = [...target.track_ids].sort();
    const key = trackIds.join("\0");
    const group = groups.get(key) ?? {
      trackIds,
      spans: [],
      hits: 0,
    };
    group.spans.push(...target.intervals);
    group.hits++;
    groups.set(key, group);
  }
  let cut = 0;
  const targets = [...groups.values()].flatMap(({ trackIds, spans, hits }) => {
    const target = makeRangeTarget(project, spans, trackIds);
    if (!target) {
      skipped += hits;
      return [];
    }
    cut += hits;
    return [target];
  });
  if (targets.length > MAX_CUT_TARGETS)
    throw new Error(
      "These matches are spread over too many tracks to cut at once. Narrow the search.",
    );
  if (targets.some((target) => target.intervals.length > MAX_CUT_INTERVALS))
    throw new Error("Too many matches to cut at once. Narrow the search.");
  return { targets, cut, skipped };
}

export function cutAllMessage(cut: number, skipped: number): string {
  const matches = (n: number) => `${n} ${n === 1 ? "match" : "matches"}`;
  if (skipped === 0) return `Cut ${matches(cut)}`;
  return `Cut ${cut} of ${matches(cut + skipped)}. ${skipped} could not be placed. Cut those in the timeline.`;
}

export function cutKey(targets: readonly ExactRangeTarget[]): string {
  return JSON.stringify(
    targets.map((target) => [target.track_ids, target.intervals]),
  );
}
