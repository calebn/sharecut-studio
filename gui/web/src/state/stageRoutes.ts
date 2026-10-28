import type { PresenceMobileMode, PresenceTab } from "../types/session";
import {
  type EditSurface,
  type ReviewSection,
  STAGE_IDS,
  type StageId,
  type StageRole,
  type StageSheet,
} from "../types/stage";

/** Stages a person may open: the host all five, a guest only what their link allows. */
export function stagesForRole(role: StageRole): readonly StageId[] {
  switch (role) {
    case "host":
      return STAGE_IDS;
    case "editor":
      return ["edit", "review"];
    case "commenter":
    case "viewer":
      return ["review"];
  }
}

/** The role a share link's mode gives; no mode is the host. */
export function stageRoleOf(guestMode: string | null): StageRole {
  switch (guestMode) {
    case null:
      return "host";
    case "edit":
      return "editor";
    case "comment":
      return "commenter";
    default:
      return "viewer";
  }
}

export type LandingInput = {
  role: StageRole;
  trackCount: number;
  /** A pipeline or agent job is running. */
  jobBusy: boolean;
  pendingReviewCount: number;
  lastStage: StageId | null;
};

/**
 * The stage a project opens on (open-questions Q2): a guest by role, then the
 * stage the host needs next (Prepare while there is nothing to edit or a job
 * runs, Review while anything is undecided), then the stage last used, then Edit.
 */
export function landingStage(input: LandingInput): StageId {
  const allowed = stagesForRole(input.role);
  if (input.role === "editor") return "edit";
  if (allowed.length === 1) return allowed[0];
  if (input.trackCount === 0 || input.jobBusy) return "prepare";
  if (input.pendingReviewCount > 0) return "review";
  if (input.lastStage && allowed.includes(input.lastStage)) {
    return input.lastStage;
  }
  return "edit";
}

export type StageTarget = {
  stage: StageId;
  section?: ReviewSection;
  sheet?: StageSheet;
};

/** Wire `tab` values and where they land in the stage shell. */
export const STAGE_FOR_TAB: Record<PresenceTab, StageTarget> = {
  transcript: { stage: "edit" },
  history: { stage: "edit", sheet: "history" },
  impact: { stage: "review", section: "queue" },
  tighten: { stage: "review", section: "tighten" },
  comments: { stage: "review", section: "comments" },
  pipeline: { stage: "prepare" },
};

/** The server validates the wire tab (`commands.py:150`), so the Queue section keeps the name `impact` on it. */
export function wireTabOf(section: ReviewSection): PresenceTab {
  return section === "queue" ? "impact" : section;
}

/** The wire `tab` for a stage; Record and Deliver have none. */
export function tabForStage(
  stage: StageId,
  reviewSection: ReviewSection,
): PresenceTab | null {
  switch (stage) {
    case "edit":
      return "transcript";
    case "prepare":
      return "pipeline";
    case "review":
      return wireTabOf(reviewSection);
    default:
      return null;
  }
}

/** The wire `mobile_mode`, kept so older clients still follow. */
export function mobileModeForStage(
  stage: StageId,
  editSurface: EditSurface,
): PresenceMobileMode {
  switch (stage) {
    case "edit":
      return editSurface === "text" ? "text" : "timeline";
    case "review":
      return "listen";
    default:
      return "more";
  }
}
