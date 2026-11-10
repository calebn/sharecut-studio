import {
  type AfterCutPick,
  registerAfterCutNavigator,
} from "../../../commands/afterCutHost";
import type { AfterCut, AfterCutDirection } from "../../../state/afterCutSlice";
import type { ProjectView } from "../../../types/project";
import { cuttableHits, shortWords } from "./cutToast";
import { scriptModelFor } from "./scriptHostModel";
import { wordKey } from "./scriptModel";

type Stop = Pick<AfterCutPick, "selection" | "at"> & { first: number };

function stopsOf(project: ProjectView, afterCut: AfterCut) {
  const host = scriptModelFor(project);
  const { refs } = host.model;
  const stops: Stop[] = [];
  for (const hit of cuttableHits(
    host,
    afterCut.words,
    new Set(afterCut.cutKeys),
  )) {
    const first = refs[hit.indices[0]];
    const last = refs[hit.indices[hit.indices.length - 1]];
    const whole = hit.indices.every((index) => {
      const ref = refs[index];
      return (
        ref.wordIndex != null &&
        ref.trackId === first.trackId &&
        ref.sourceId === first.sourceId
      );
    });
    if (!whole) continue;
    stops.push({
      first: hit.indices[0],
      at: {
        trackId: first.trackId,
        sourceId: first.sourceId ?? null,
        wordIndex: first.wordIndex!,
      },
      selection: {
        kind: "transcriptRange",
        trackId: first.trackId,
        sourceId: first.sourceId ?? null,
        startWordIndex: first.wordIndex!,
        endWordIndex: last.wordIndex!,
      },
    });
  }
  return { stops: stops.sort((a, b) => a.first - b.first), host };
}

function pickAfterCut(
  project: ProjectView,
  afterCut: AfterCut,
  direction: AfterCutDirection,
): AfterCutPick | null {
  const { stops, host } = stopsOf(project, afterCut);
  if (stops.length === 0) return null;
  const from = host.model.indexOf(afterCut.at ?? afterCut.from);
  const found =
    direction === "next"
      ? stops.find((stop) => from === undefined || stop.first > from)
      : stops.findLast((stop) => from === undefined || stop.first < from);
  const target =
    found ?? (direction === "next" ? stops[0] : stops[stops.length - 1]);
  const reversed =
    afterCut.direction !== null && afterCut.direction !== direction;
  const startedAt = reversed ? afterCut.at : afterCut.startedAt;
  if (startedAt && wordKey(startedAt) === wordKey(target.at)) return null;
  return {
    selection: target.selection,
    at: target.at,
    startedAt: startedAt ?? target.at,
    words: shortWords(afterCut.words),
    ordinal: stops.indexOf(target) + 1,
    total: stops.length,
  };
}

export function registerAfterCutNav(): void {
  registerAfterCutNavigator(pickAfterCut);
}
