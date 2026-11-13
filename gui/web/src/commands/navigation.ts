import { patchComment } from "../api";
import { seekLimitSec } from "../audio/proxyMath";
import { followCapsOf, planGoTo } from "../presence/goToPlan";
import { rosterEntry } from "../presence/roster";
import { canManageProjects, guestHearsMixOnly } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { transportAvailability } from "../state/transportAvailability";
import type { AuditionMode } from "../state/types";
import { errorMessage } from "../utils/apiError";
import { GUESTS_HEAR_FULL_MIX } from "../utils/auditionModes";
import { clampToSession } from "../utils/time";
import { registerCommand } from "./execute";
import { shuttleBack, shuttleForward } from "./shuttle";
import type { ExecuteResult } from "./types";
import { cancelUserStageSwitch, markUserStageSwitch } from "./userStageSwitch";

// Module scope: HomeScreen re-registers the commands on every mount, which
// replaces the handler; the hold-A restore must outlive that.
let heldFrom: AuditionMode | null = null;

export function registerNavigationCommands(): void {
  registerCommand("transport.togglePlay", () => {
    const s = useDawStore.getState();
    const reason = transportAvailability(s).togglePlay;
    if (reason !== undefined) {
      return { status: "disabled", reason };
    }
    s.togglePlaying();
    return { status: "ok" };
  });

  registerCommand("transport.stop", () => {
    const s = useDawStore.getState();
    const reason = transportAvailability(s).stop;
    if (reason !== undefined) {
      return { status: "disabled", reason };
    }
    s.stopPlayback();
    return { status: "ok" };
  });

  const shuttle = (step: () => void): ExecuteResult => {
    const s = useDawStore.getState();
    const reason = transportAvailability(s).togglePlay;
    if (reason !== undefined) {
      return { status: "disabled", reason };
    }
    s.stopFollow("local");
    step();
    return { status: "ok" };
  };
  registerCommand("transport.shuttleBack", () => shuttle(shuttleBack));
  registerCommand("transport.shuttleForward", () => shuttle(shuttleForward));

  registerCommand("transport.seek", (args) => {
    const sec = Number(args.sec);
    if (!Number.isFinite(sec)) {
      return { status: "disabled", reason: "sec must be a number" };
    }
    const s = useDawStore.getState();
    const duration = seekLimitSec(s.project);
    s.setPlayheadSec(clampToSession(sec, duration));
    s.setPlayUntilSec(null);
    return { status: "ok" };
  });

  const AUDITION = new Set(["mix", "fx", "raw"]);
  registerCommand("transport.audition", (args) => {
    const mode = args.mode;
    if (typeof mode !== "string" || !AUDITION.has(mode)) {
      return { status: "disabled", reason: "mode required" };
    }
    if (guestHearsMixOnly(useDawStore.getState().guestMode) && mode !== "mix") {
      return { status: "disabled", reason: GUESTS_HEAR_FULL_MIX };
    }
    useDawStore.getState().setAuditionMode(mode as AuditionMode);
    return { status: "ok" };
  });

  registerCommand("transport.hearOriginal", (args) => {
    const s = useDawStore.getState();
    if (args.on !== true) {
      if (heldFrom !== null && s.auditionMode === "raw") {
        s.setAuditionMode(heldFrom);
      }
      heldFrom = null;
      return { status: "ok" };
    }
    if (guestHearsMixOnly(s.guestMode)) return { status: "ok" };
    if (heldFrom === null && s.auditionMode !== "raw") {
      heldFrom = s.auditionMode;
      s.setAuditionMode("raw");
    }
    return { status: "ok" };
  });

  registerCommand("presence.follow", (args) => {
    const clientId = typeof args.clientId === "string" ? args.clientId : "";
    if (!clientId) {
      return { status: "disabled", reason: "clientId required" };
    }
    const s = useDawStore.getState();
    if (s.followingClientId === clientId) {
      s.stopFollow("local");
      return { status: "ok" };
    }
    s.startFollow(clientId);
    return { status: "ok" };
  });

  registerCommand("presence.goTo", (args) => {
    const clientId = typeof args.clientId === "string" ? args.clientId : "";
    if (!clientId) {
      return { status: "disabled", reason: "clientId required" };
    }
    const s = useDawStore.getState();
    const client = rosterEntry(s.sessionClients, clientId);
    if (!client) {
      return { status: "disabled", reason: "They are not here any more" };
    }
    const plan = planGoTo(
      client,
      followCapsOf(s.guestMode, s.shellBreakpoint),
      s.project?.timeline_duration_sec ?? Number.NaN,
      s.stage,
    );
    if (!plan) {
      return {
        status: "disabled",
        reason: "This link cannot open where they are",
      };
    }
    const { apply, sec } = plan;
    if (apply.stage) {
      const before = s.stage;
      markUserStageSwitch();
      s.openStage(apply.stage.stage, {
        section: apply.stage.section,
        sheet: apply.stage.sheet,
      });
      if (useDawStore.getState().stage === before) cancelUserStageSwitch();
    }
    if (apply.editSurface) {
      s.setEditSurface(apply.editSurface);
    }
    if (sec !== null) {
      s.setPlayheadSec(sec);
    }
    return { status: "ok" };
  });

  registerCommand("presence.unfollow", () => {
    useDawStore.getState().stopFollow("local");
    return { status: "ok" };
  });

  registerCommand("comment.resolve", async (args) => {
    const s = useDawStore.getState();
    if (
      !s.project ||
      s.guestMode != null ||
      !canManageProjects(s.projectPath)
    ) {
      return { status: "disabled", reason: "Comment resolve is host-only" };
    }
    const { commentId, resolved, by } = args;
    if (
      typeof commentId !== "string" ||
      !commentId ||
      typeof resolved !== "boolean" ||
      typeof by !== "string" ||
      !by.trim()
    ) {
      return {
        status: "disabled",
        reason: "Invalid comment resolve arguments",
      };
    }
    const comment = s.project.comments?.find((c) => c.id === commentId);
    if (!comment) {
      return { status: "disabled", reason: "Unknown comment" };
    }
    if (resolved && comment.resolved) {
      return { status: "disabled", reason: "Comment is already resolved" };
    }
    try {
      await patchComment(s.projectPath, commentId, { resolved, by });
      return { status: "ok" };
    } catch (e) {
      return { status: "disabled", reason: errorMessage(e) };
    }
  });

  registerCommand("navigation.nudgePlayheadBack", (args, ctx) => {
    const delta = args.shift ? 5 : 1;
    const s = useDawStore.getState();
    s.setPlayheadSec(Math.max(0, ctx.playheadSec - delta));
    return { status: "ok" };
  });

  registerCommand("navigation.nudgePlayheadForward", (args, ctx) => {
    const delta = args.shift ? 5 : 1;
    const s = useDawStore.getState();
    s.setPlayheadSec(
      Math.min(ctx.timelineDurationSec, ctx.playheadSec + delta),
    );
    return { status: "ok" };
  });

  registerCommand("navigation.goToStart", () => {
    const s = useDawStore.getState();
    s.setPlayheadSec(0);
    return { status: "ok" };
  });

  registerCommand("navigation.goToEnd", (_args, ctx) => {
    const end = Number.isFinite(ctx.timelineDurationSec)
      ? ctx.timelineDurationSec
      : 0;
    const s = useDawStore.getState();
    s.setPlayheadSec(Math.max(0, end));
    return { status: "ok" };
  });
}
