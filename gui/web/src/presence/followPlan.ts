import {
  STAGE_FOR_TAB,
  type StageTarget,
  stagesForRole,
} from "../state/stageRoutes";
import type { AuditionMode, PresenceUi } from "../types/session";
import type { EditSurface, StageRole } from "../types/stage";
import {
  type FollowDegraded,
  type FollowUiCaps,
  KNOWN_TABS,
  tabAvailable,
} from "./followSync";

export type FollowApply = {
  stage?: StageTarget;
  editSurface?: EditSurface;
  audition?: AuditionMode;
  viewerMute?: Record<string, boolean>;
  soloTracks?: Record<string, boolean>;
};

export function planFollowUi(
  leader: PresenceUi,
  caps: FollowUiCaps,
): { apply: FollowApply; degraded: FollowDegraded } {
  const apply: FollowApply = {};
  const degraded: FollowDegraded = {};
  const role: StageRole = caps.role ?? (caps.guestShare ? "editor" : "host");
  if (leader.tab && KNOWN_TABS.has(leader.tab)) {
    const target = STAGE_FOR_TAB[leader.tab];
    if (
      !tabAvailable(leader.tab, caps) ||
      !stagesForRole(role).includes(target.stage)
    ) {
      degraded.tab = leader.tab;
    } else {
      apply.stage = target;
    }
  }
  if (
    caps.breakpoint === "phone" &&
    (leader.mobile_mode === "text" || leader.mobile_mode === "timeline") &&
    (apply.stage?.stage === "edit" ||
      (!leader.tab && stagesForRole(role).includes("edit")))
  ) {
    apply.editSurface = leader.mobile_mode === "text" ? "text" : "lanes";
    apply.stage ??= { stage: "edit" };
  }
  if (caps.guestShare) {
    apply.audition = "mix";
    if (leader.audition && leader.audition !== "mix") {
      degraded.audition = leader.audition;
    }
  } else if (leader.audition) {
    apply.audition = leader.audition;
  }
  if (!caps.guestShare) {
    if (leader.viewer_mute) {
      apply.viewerMute = Object.fromEntries(
        leader.viewer_mute.map((id) => [id, true]),
      );
    }
    if (leader.solo) {
      apply.soloTracks = Object.fromEntries(
        leader.solo.map((id) => [id, true]),
      );
    }
  }
  return { apply, degraded };
}
