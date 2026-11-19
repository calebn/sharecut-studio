import type { ProjectView, Selection } from "../types/project";

type TranscriptRange = Extract<
  NonNullable<Selection>,
  { kind: "transcriptRange" }
>;

/** What a project replacement means for a selected run of words. */
export type TranscriptSelectionJudgment =
  | { kind: "keep" }
  | { kind: "clear" }
  /** The words are not live yet: judge again at the next replacement. */
  | { kind: "wait" }
  | { kind: "move"; startWordIndex: number; endWordIndex: number };

export type TranscriptSelectionJudge = (
  from: ProjectView,
  selection: TranscriptRange,
  next: ProjectView,
) => TranscriptSelectionJudgment;

const KEEP: TranscriptSelectionJudge = () => ({ kind: "keep" });

let judge: TranscriptSelectionJudge = KEEP;

/** The Script model that names a run's words lives above `state`, so the store takes it by registration. */
export function registerTranscriptSelectionFollower(
  next: TranscriptSelectionJudge,
): void {
  judge = next;
}

export function judgeTranscriptSelection(
  from: ProjectView,
  selection: TranscriptRange,
  next: ProjectView,
): TranscriptSelectionJudgment {
  return judge(from, selection, next);
}
