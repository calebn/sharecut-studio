import { stagesForRole } from "../../state/stageRoutes";
import {
  type ReviewSection,
  type StageId,
  type StageRole,
} from "../../types/stage";
import type { LoadFailure } from "../frame/LoadFailureBanner";

/** True when the role's link may open the stage. */
export function stageAvailable(stage: StageId, role: StageRole): boolean {
  return stagesForRole(role).includes(stage);
}

/** Comments are queue items for every role; a guest's queue is read-only. */
export function reviewSectionsFor(_role: StageRole): readonly ReviewSection[] {
  return ["queue"];
}

/** The stored section, or the first one the role has when it names one they cannot see. */
export function effectiveSection(
  section: ReviewSection,
  sections: readonly ReviewSection[],
): ReviewSection {
  return sections.includes(section) ? section : sections[0];
}

export type HostState = "loading" | "error" | "ready";

export function hostStateOf(
  project: unknown,
  loadFailure: LoadFailure | null | undefined,
): HostState {
  if (project != null) return "ready";
  return loadFailure ? "error" : "loading";
}
