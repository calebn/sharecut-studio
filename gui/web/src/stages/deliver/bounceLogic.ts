import type { ModelGate } from "../../models";
import type { ExactRangeTarget } from "../../types/project";

export type BounceSource = "entire" | "selected" | "soloed";

/** What the person chose for the next bounce. */
export type BounceChoices = {
  source: BounceSource;
  includeMp3: boolean;
  limitToRegion: boolean;
};

export const BOUNCE_DEFAULTS: BounceChoices = {
  source: "entire",
  includeMp3: false,
  limitToRegion: false,
};

export type BounceState =
  | { phase: "idle" }
  | {
      phase: "running";
      /** 0 to 1; null when the job reports no total, so the bar is not drawn. */
      progress: number | null;
      detail: string;
      /** Why Cancel is unavailable right now. */
      cancelReason?: string;
      cancelError?: string;
    }
  | { phase: "done"; files: readonly string[]; summary: string }
  /** Cancelled; `files` are the ones written before the cancel reached the job. */
  | { phase: "cancelled"; files: readonly string[]; detail: string }
  | { phase: "failed"; cause: string };

/** What the Deliver host gives the Bounce section. */
export type BounceOptions = {
  state: BounceState;
  choices: BounceChoices;
  onChoices: (next: BounceChoices) => void;
  selectedCount: number;
  soloCount: number;
  /** A session region exists, so "Limit to session region" can be on. */
  hasRegion: boolean;
  /** A range chosen in Edit: this bounce is fixed to it. */
  fixedRange?: string;
  /** The fixed range is the one the running bounce captured, not a later request. */
  rangeIsRunning?: boolean;
  onClearRange?: () => void;
  /** A missing model: the gate's prompt and its download controls. */
  gate?: ModelGate;
  /** Why Bounce is unavailable for reasons outside the page, such as a link that cannot bounce. */
  blockedReason?: string;
  onBounce: () => void;
  onCancel: () => void;
  /** After a failed or cancelled bounce. */
  onAgain?: () => void;
  /** Move focus to the Bounce button once, then call `onFocused`. */
  focusRequested?: boolean;
  onFocused?: () => void;
};

export const BOUNCE_RUNNING_REASON = "Bouncing now.";

/** Why a bounce cannot start now; null when it can. A fixed range ignores the source. */
export function bounceBlocker(
  choices: Pick<BounceChoices, "source">,
  counts: { selected: number; soloed: number },
  fixedRange: boolean,
): string | null {
  if (fixedRange) return null;
  if (choices.source === "selected" && counts.selected === 0) {
    return "Select one or more tracks first.";
  }
  if (choices.source === "soloed" && counts.soloed === 0) {
    return "Solo one or more tracks first.";
  }
  return null;
}

/** The ranges and tracks of a fixed selection, as one line. */
export function bounceRangeSummary(
  target: Pick<ExactRangeTarget, "intervals" | "track_ids">,
): string {
  const spans = target.intervals
    .map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)} s`)
    .join(" · ");
  return `${spans} on ${target.track_ids.join(", ")}`;
}

export function bounceResultCopy(paths: readonly string[]): string {
  return `Bounced ${paths.length} file(s) to export/bounces/`;
}

/** `POST /api/export/bounce`, the same fields as MCP `bounce_audio_tool` and `podcast pipeline bounce`, plus `exact_range`. */
type BounceBody = {
  track_ids: string[] | null;
  start_s: number | null;
  end_s: number | null;
  formats: string[];
  exact_range?: ExactRangeTarget;
};

export function bounceBody(input: {
  choices: BounceChoices;
  selectedTrackIds: readonly string[];
  soloTracks: Readonly<Record<string, boolean>>;
  region: { start_sec: number; end_sec: number } | null;
  range: ExactRangeTarget | null;
}): BounceBody {
  const { choices, region, range } = input;
  const formats = choices.includeMp3 ? ["wav", "mp3"] : ["wav"];
  if (range) {
    return {
      track_ids: null,
      start_s: null,
      end_s: null,
      formats,
      exact_range: range,
    };
  }
  const limit = choices.limitToRegion ? region : null;
  return {
    track_ids:
      choices.source === "selected"
        ? [...input.selectedTrackIds]
        : choices.source === "soloed"
          ? Object.entries(input.soloTracks)
              .filter(([, on]) => on)
              .map(([id]) => id)
          : null,
    start_s: limit?.start_sec ?? null,
    end_s: limit?.end_sec ?? null,
    formats,
  };
}
