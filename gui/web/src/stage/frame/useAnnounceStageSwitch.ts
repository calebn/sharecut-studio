import { useEffect, useRef } from "react";
import { takeUserStageSwitch } from "../../commands/userStageSwitch";
import { useDawStore } from "../../state/dawStore";
import { stageLabel } from "../../system/verbs";
import type { StageId } from "../../types/stage";
import { STAGE_BODY_ID } from "./StageFrameView";

const TAB_CLICK_MS = 600;
let tabPressedAt = Number.NEGATIVE_INFINITY;

/** A mouse click on a Stage tab does not focus it in Safari or Firefox on macOS, so the press itself is noted. */
function noteTabPress(event: PointerEvent): void {
  if (event.target instanceof Element && event.target.closest('[role="tab"]'))
    tabPressedAt = performance.now();
}

function typingTarget(active: Element | null): boolean {
  return (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active.closest('[role="dialog"], [role="menu"]') != null ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
  );
}

/**
 * After a stage switch a person made by running a stage command (a key such as
 * Mod+1..5, the palette, the phone's Stage menu, or a button that opens
 * another stage such as a banner's Review link), say which stage opened and
 * put focus on its body, so focus is not left on a control that is gone. The
 * landing on open, a leader's Follow and a screen's own openStage are left
 * alone. A Stage tab announces itself and keeps focus for
 * the arrow keys. Focus never leaves a field, menu or dialog.
 */
export function useAnnounceStageSwitch(stage: StageId): void {
  const shown = useRef(stage);
  useEffect(() => {
    document.addEventListener("pointerdown", noteTabPress, true);
    return () =>
      document.removeEventListener("pointerdown", noteTabPress, true);
  }, []);
  useEffect(() => {
    if (shown.current === stage) return;
    shown.current = stage;
    if (!takeUserStageSwitch()) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.getAttribute("role") === "tab")
      return;
    const tabPress = performance.now() - tabPressedAt < TAB_CLICK_MS;
    tabPressedAt = Number.NEGATIVE_INFINITY;
    if (tabPress) return;
    useDawStore
      .getState()
      .announceStatus(`${stageLabel(stage)} stage`, { toast: false });
    if (typingTarget(active)) return;
    const body = document.getElementById(STAGE_BODY_ID);
    if (body && !body.contains(active)) body.focus({ preventScroll: true });
  }, [stage]);
}
