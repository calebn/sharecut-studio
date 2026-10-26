import { useEffect, useRef } from "react";
import { planFollowUi } from "../presence/followPlan";
import {
  resolveFollowTarget,
  serverNowMs,
  withProgrammaticUi,
} from "../presence/followSync";
import { sessionClientList } from "../presence/roster";
import { wireSelectionPatch } from "../session/wire";
import { guestHearsMixOnly } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { stageRoleOf } from "../state/stageRoutes";

export function useFollowUi(): void {
  const followingClientId = useDawStore((s) => s.followingClientId);
  const sessionClients = useDawStore((s) =>
    sessionClientList(s.sessionClients),
  );
  const shellBreakpoint = useDawStore((s) => s.shellBreakpoint);
  const guestMode = useDawStore((s) => s.guestMode);
  const lastFollowId = useRef<string | null>(null);
  const lastUiSig = useRef("");
  const lastHearSig = useRef("");
  const lastSelSig = useRef("");
  const seenSelection = useRef(false);
  const lastLeaderTab = useRef<string | null>(null);

  useEffect(() => {
    if (!followingClientId) {
      lastFollowId.current = null;
      lastUiSig.current = "";
      lastHearSig.current = "";
      lastSelSig.current = "";
      seenSelection.current = false;
      lastLeaderTab.current = null;
      useDawStore.getState().setFollowDegraded({});
      return;
    }
    if (lastFollowId.current !== followingClientId) {
      lastFollowId.current = followingClientId;
      lastUiSig.current = "";
      lastHearSig.current = "";
      lastSelSig.current = "";
      seenSelection.current = false;
      lastLeaderTab.current = null;
      useDawStore.getState().setFollowDegraded({});
    }
    const target = resolveFollowTarget(
      sessionClients,
      followingClientId,
      serverNowMs(),
    );
    if (!target) {
      useDawStore.getState().stopFollow("left");
      return;
    }
    const ui = target.meta?.ui;
    const hasSel = Boolean(target.meta && "selection" in target.meta);
    const missingSel = seenSelection.current && !hasSel;
    if (!ui && !hasSel && !missingSel) {
      return;
    }
    const caps = {
      guestShare: guestHearsMixOnly(guestMode),
      breakpoint: shellBreakpoint,
      role: stageRoleOf(guestMode),
    };
    const uiSig = ui
      ? JSON.stringify({
          tab: ui.tab,
          mobile_mode: ui.mobile_mode,
          transcript_anchor: ui.transcript_anchor,
          audition: ui.audition,
          ...caps,
        })
      : lastUiSig.current;
    const hearSig = ui
      ? JSON.stringify({
          mute: ui.viewer_mute ?? null,
          solo: ui.solo ?? null,
        })
      : lastHearSig.current;
    const selSig = hasSel
      ? JSON.stringify(target.meta?.selection ?? null)
      : missingSel
        ? "__cleared__"
        : lastSelSig.current;
    const uiChanged = Boolean(ui) && uiSig !== lastUiSig.current;
    const hearChanged = Boolean(ui) && hearSig !== lastHearSig.current;
    const selChanged = (hasSel || missingSel) && selSig !== lastSelSig.current;
    if (!uiChanged && !hearChanged && !selChanged) {
      return;
    }
    if (ui) {
      lastUiSig.current = uiSig;
      lastHearSig.current = hearSig;
    }
    if (hasSel) {
      seenSelection.current = true;
      lastSelSig.current = selSig;
    } else if (missingSel) {
      lastSelSig.current = selSig;
    }
    const plan = ui ? planFollowUi(ui, caps) : null;
    const s = useDawStore.getState();
    withProgrammaticUi(() => {
      if (ui && uiChanged && plan) {
        // Apply the leader's stage on the first tick after (re)following,
        // then only when the leader's stage or section changes, so audition
        // and anchor ticks never undo the follower's own sheet or surface.
        if (plan.apply.stage) {
          const { stage, section, sheet } = plan.apply.stage;
          const key = `${stage}/${section ?? ""}/${sheet ?? ""}`;
          const leaderMoved = key !== lastLeaderTab.current;
          lastLeaderTab.current = key;
          if (leaderMoved) {
            s.openStage(stage, { section, sheet });
          }
        }
        if (plan.apply.editSurface) {
          s.setEditSurface(plan.apply.editSurface);
        }
        if (plan.apply.audition) {
          s.setAuditionMode(plan.apply.audition);
        }
        const stageNow =
          plan.apply.stage?.stage ?? useDawStore.getState().stage;
        if (ui.transcript_anchor && stageNow === "edit") {
          useDawStore
            .getState()
            .setTranscriptScrollRequest(ui.transcript_anchor);
        }
      }
      if (ui && hearChanged && plan) {
        if (plan.apply.viewerMute) {
          s.setViewerMuteMap(plan.apply.viewerMute);
        }
        if (plan.apply.soloTracks) {
          s.setSoloMap(plan.apply.soloTracks);
        }
      }
      if (selChanged) {
        const wire = wireSelectionPatch(target.meta?.selection, s.project);
        const next = wire.selection;
        s.adoptRemoteSelection(next, wire.pendingWireSelection);
        if (next?.kind === "envelopePoint") {
          s.setLayerVisible("showLevels", true);
        }
      }
    });
    if (uiChanged && plan) {
      s.setFollowDegraded(plan.degraded);
    }
  }, [followingClientId, sessionClients, shellBreakpoint, guestMode]);
}
