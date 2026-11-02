import { useEffect, useRef } from "react";
import { useDawStore } from "../../state/dawStore";
import { stageLabel } from "../../system/verbs";
import type { StageId } from "../../types/stage";
import { STAGE_BODY_ID } from "./StageFrameView";

/**
 * After a stage switch the person did not make on a Stage tab, say which stage
 * opened and put focus on its body, so a key (Mod+1..5), the palette or the
 * phone's Stage menu does not leave focus on a control that is gone. A tab
 * announces itself and keeps focus for the arrow keys; a switch a leader drove
 * (Follow) is left alone, so it does not pull focus out of what is being typed.
 */
export function useAnnounceStageSwitch(stage: StageId): void {
  const shown = useRef(stage);
  useEffect(() => {
    if (shown.current === stage) return;
    shown.current = stage;
    // A person's own switch ends Follow first, so a switch while following is the leader's.
    if (useDawStore.getState().followingClientId != null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.getAttribute("role") === "tab")
      return;
    useDawStore.getState().announceStatus(`${stageLabel(stage)} stage`);
    const body = document.getElementById(STAGE_BODY_ID);
    if (body && !body.contains(active)) body.focus({ preventScroll: true });
  }, [stage]);
}
