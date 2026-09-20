import { useEffect, useRef } from "react";
import {
  planFollowUi,
  resolveFollowTarget,
  serverNowMs,
  withProgrammaticUi,
} from "../presence/followSync";
import { selectionFromWire } from "../session/wire";
import { guestHearsMixOnly } from "../shareMode";
import { useDawStore } from "../state/dawStore";

export function useFollowUi(): void {
  const followingClientId = useDawStore((s) => s.followingClientId);
  const sessionClients = useDawStore((s) => s.sessionClients);
  const serverClockOffsetMs = useDawStore((s) => s.serverClockOffsetMs);
  const shellBreakpoint = useDawStore((s) => s.shellBreakpoint);
  const guestMode = useDawStore((s) => s.guestMode);
  const lastFollowId = useRef<string | null>(null);
  const lastUiSig = useRef("");
  const lastHearSig = useRef("");
  const lastSelSig = useRef("");
  const seenSelection = useRef(false);

  useEffect(() => {
    if (!followingClientId) {
      lastFollowId.current = null;
      lastUiSig.current = "";
      lastHearSig.current = "";
      lastSelSig.current = "";
      seenSelection.current = false;
      useDawStore.getState().setFollowDegraded({});
      return;
    }
    if (lastFollowId.current !== followingClientId) {
      lastFollowId.current = followingClientId;
      lastUiSig.current = "";
      lastHearSig.current = "";
      lastSelSig.current = "";
      seenSelection.current = false;
      useDawStore.getState().setFollowDegraded({});
    }
    const target = resolveFollowTarget(
      sessionClients,
      followingClientId,
      serverNowMs(serverClockOffsetMs),
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
        if (plan.apply.tab) {
          s.setActiveTab(plan.apply.tab);
        }
        if (plan.apply.mobile) {
          if (plan.apply.mobile.moreDestination) {
            s.setMoreDestination(plan.apply.mobile.moreDestination);
          } else {
            s.setMobileMode(plan.apply.mobile.mobileMode);
          }
        }
        if (plan.apply.audition) {
          s.setAuditionMode(plan.apply.audition);
        }
        const tabNow = plan.apply.tab ?? useDawStore.getState().activeTab;
        if (ui.transcript_anchor && tabNow === "transcript") {
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
        const next = selectionFromWire(
          target.meta?.selection,
          s.project?.envelopes,
        );
        s.setSelection(next);
        if (next?.kind === "envelopePoint") {
          s.setLayerVisible("showLevels", true);
        }
      }
    });
    if (uiChanged && plan) {
      s.setFollowDegraded(plan.degraded);
    }
  }, [
    followingClientId,
    sessionClients,
    serverClockOffsetMs,
    shellBreakpoint,
    guestMode,
  ]);
}
