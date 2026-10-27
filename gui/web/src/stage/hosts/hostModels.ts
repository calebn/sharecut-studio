import type { RecordSnapshot } from "../../record";
import { stagesForRole } from "../../state/stageRoutes";
import {
  REVIEW_SECTIONS,
  type ReviewSection,
  type StageId,
  type StageRole,
} from "../../types/stage";
import type { LoadFailure } from "../frame/LoadFailureBanner";

/** True when the role's link may open the stage. */
export function stageAvailable(stage: StageId, role: StageRole): boolean {
  return stagesForRole(role).includes(stage);
}

/** Impact and Tighten act on the project; a guest reviews comments. */
export function reviewSectionsFor(role: StageRole): readonly ReviewSection[] {
  return role === "host" ? REVIEW_SECTIONS : ["comments"];
}

/** The stored section, or the first one the role has when it names one they cannot see. */
export function effectiveSection(
  section: ReviewSection,
  sections: readonly ReviewSection[],
): ReviewSection {
  return sections.includes(section) ? section : sections[0];
}

type RecordStatusKind = "idle" | "live" | "paused" | "saving";

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

export type HostState = "loading" | "error" | "ready";

export function hostStateOf(
  project: unknown,
  loadFailure: LoadFailure | null | undefined,
): HostState {
  if (project != null) return "ready";
  return loadFailure ? "error" : "loading";
}
