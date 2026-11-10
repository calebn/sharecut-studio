import type { ToastAction } from "../state/types";
import type {
  ExactRangeTarget,
  ProjectView,
  Selection,
} from "../types/project";

export type CutToast = {
  message: string;
  action?: ToastAction;
  follow?: { words: string; cutKeys: readonly string[] };
};

type TranscriptRange = Extract<Selection, { kind: "transcriptRange" }>;

type CutToastBuilder = (
  project: ProjectView,
  selection: TranscriptRange,
  target: ExactRangeTarget,
  epoch: number,
) => CutToast | null;

let builder: CutToastBuilder | null = null;

export function registerCutToastBuilder(next: CutToastBuilder): void {
  builder = next;
}

export function cutToastOf(
  project: ProjectView,
  selection: TranscriptRange,
  target: ExactRangeTarget,
  epoch: number,
): CutToast | null {
  try {
    return builder?.(project, selection, target, epoch) ?? null;
  } catch {
    return null;
  }
}
