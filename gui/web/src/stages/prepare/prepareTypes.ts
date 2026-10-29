import type { PrepareTarget } from "../../system/SessionTargetChip";
import type { SourceCardProps } from "../../system/SourceCard";

/** One file in a session, as data. The card's callbacks come from `SourceActions`. */
export type PrepareSource = Pick<
  SourceCardProps,
  | "state"
  | "name"
  | "fileName"
  | "audioTime"
  | "progress"
  | "peaks"
  | "playing"
  | "voices"
  | "canSplit"
  | "splitDetail"
  | "cause"
  | "sameNameAs"
> & { id: string };

export type PrepareSession = {
  id: string;
  /** "Session 1 · 25 Oct". */
  title: string;
  people: number;
  takes: number;
  /** "14:20". */
  duration: string;
  target: PrepareTarget;
  /** The first take has landed, so the place is set. */
  targetLocked?: boolean;
  status: "idle" | "running" | "done" | "failed";
  progress?: number;
  sources: readonly PrepareSource[];
};

/** What a Source card asks for, by the id of its source. */
export type SourceActions = {
  onName: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onHear: (id: string) => void;
  onVoices: (id: string, voices: number) => void;
  onSplit: (id: string) => void;
  onCancelSplit: (id: string) => void;
  onRetry: (id: string) => void;
  onDetails: (id: string) => void;
  onReplace: (id: string) => void;
  /** Left out where merging two voices is not offered. */
  onMerge?: (id: string) => void;
  onMove: (id: string, direction: "up" | "down") => void;
};
