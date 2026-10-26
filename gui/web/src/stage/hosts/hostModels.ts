import type { RecordSnapshot } from "../../record";
import { stagesForRole } from "../../state/stageRoutes";
import type { ReviewSection, StageId, StageRole } from "../../types/stage";
import type { LoadFailure } from "../frame/LoadFailureBanner";

const HOST_SECTIONS: readonly ReviewSection[] = [
  "comments",
  "impact",
  "tighten",
];

/** True when the role's link may open the stage. */
export function stageAvailable(stage: StageId, role: StageRole): boolean {
  return stagesForRole(role).includes(stage);
}

/** Impact and Tighten act on the project; a guest reviews comments. */
export function reviewSectionsFor(role: StageRole): readonly ReviewSection[] {
  return role === "host" ? HOST_SECTIONS : ["comments"];
}

/** The stored section, or the first one the role has when it names one they cannot see. */
export function effectiveSection(
  section: ReviewSection,
  sections: readonly ReviewSection[],
): ReviewSection {
  return sections.includes(section) ? section : sections[0];
}

export type PrepareHandoff = {
  label: string;
  target: "review" | "edit";
  /** Processing is still going: the button is offered, not the next step. */
  primary: boolean;
};

/** Where Prepare sends the host next: decisions first, then the Edit. */
export function prepareHandoff(input: {
  busy: boolean;
  pendingReviewCount: number;
}): PrepareHandoff {
  const { busy, pendingReviewCount } = input;
  if (pendingReviewCount > 0) {
    return {
      label: `Review ${pendingReviewCount} ${pendingReviewCount === 1 ? "suggestion" : "suggestions"}`,
      target: "review",
      primary: !busy,
    };
  }
  return { label: "Edit", target: "edit", primary: !busy };
}

export type RecordStatusKind = "idle" | "live" | "paused" | "saving";

export type RecordStatus = {
  kind: RecordStatusKind;
  title: string;
  detail: string;
};

/** What the launcher says about the room. A lobby or no room is idle. */
export function recordStatusOf(snapshot: RecordSnapshot | null): RecordStatus {
  switch (snapshot?.state) {
    case "recording":
      return {
        kind: "live",
        title: "Recording",
        detail: "Take in progress. Switching stage does not stop it.",
      };
    case "paused":
      return {
        kind: "paused",
        title: "Paused",
        detail: "The take is paused. Open the room to resume or stop it.",
      };
    case "stopped":
      return {
        kind: "saving",
        title: "Saving the take",
        detail: "Uploads finish in the room. Open it to watch them land.",
      };
    default:
      return {
        kind: "idle",
        title: snapshot ? "Room is open" : "No take yet",
        detail: snapshot
          ? "Guests can join. Open the room to start."
          : "Open the room to invite guests or record this device.",
      };
  }
}

export type ReadinessFix =
  | { kind: "stage"; stage: StageId; section?: ReviewSection; label: string }
  | { kind: "refreshMix"; label: string };

export type ReadinessRow = {
  id: "suggestions" | "comments" | "mix";
  state: "done" | "needs-you";
  title: string;
  detail: string;
  fix?: ReadinessFix;
};

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Deliver's readiness list. Nothing here blocks Export. */
export function deliverReadiness(input: {
  pendingReviewCount: number;
  openCommentCount: number;
  mixStale: boolean;
  mixMissing: boolean;
  mayRefreshMix: boolean;
}): { rows: ReadinessRow[]; summary: string } {
  const rows: ReadinessRow[] = [
    input.pendingReviewCount > 0
      ? {
          id: "suggestions",
          state: "needs-you",
          title: "Suggestions to decide",
          detail: `${input.pendingReviewCount} waiting`,
          fix: {
            kind: "stage",
            stage: "review",
            section: "impact",
            label: "Decide",
          },
        }
      : {
          id: "suggestions",
          state: "done",
          title: "Suggestions decided",
          detail: "None waiting",
        },
    input.openCommentCount > 0
      ? {
          id: "comments",
          state: "needs-you",
          title: "Comments to resolve",
          detail: `${input.openCommentCount} open`,
          fix: {
            kind: "stage",
            stage: "review",
            section: "comments",
            label: "Resolve",
          },
        }
      : {
          id: "comments",
          state: "done",
          title: "Comments resolved",
          detail: "None open",
        },
    input.mixStale || input.mixMissing
      ? {
          id: "mix",
          state: "needs-you",
          title: input.mixMissing ? "No mix yet" : "Mix out of date",
          detail: "Export renders from the latest mix.",
          ...(input.mayRefreshMix
            ? { fix: { kind: "refreshMix", label: "Refresh mix" } as const }
            : {}),
        }
      : {
          id: "mix",
          state: "done",
          title: "Mix up to date",
          detail: "Ready to export",
        },
  ];
  const left = rows.filter((r) => r.state === "needs-you").length;
  return {
    rows,
    summary:
      left === 0
        ? "Ready to export"
        : `${count(left, "thing", "things")} left. You can still export.`,
  };
}

export type HostState = "loading" | "error" | "ready";

export type HostShell = "phone" | "tablet" | "desktop";

export function hostStateOf(
  project: unknown,
  loadFailure: LoadFailure | null | undefined,
): HostState {
  if (project != null) return "ready";
  return loadFailure ? "error" : "loading";
}
