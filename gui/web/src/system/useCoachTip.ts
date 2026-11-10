import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDawStore } from "../state/dawStore";
import {
  COACH_TIPS,
  type CoachTipId,
  coachTipOwner,
  dismissCoachTip,
  releaseCoachTip,
  showCoachTip,
  subscribeCoachTip,
  undoTipMoment,
} from "../utils/coachTip";

const NOT_ACTING_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "Tab"]);

export type CoachTipControl = {
  text: string;
  shown: boolean;
  /** Raise the tip. Ignored off touch, once seen, or while another is up. */
  show: () => void;
  dismiss: () => void;
  /** Free the slot without marking the tip seen, for a tip whose target went away. */
  release: () => void;
};

/**
 * One coach tip. `shown` is true only for the instance that raised it. While
 * it is up, the next pointer press or key outside the bubble dismisses it.
 */
export function useCoachTip(id: CoachTipId): CoachTipControl {
  const [owner] = useState(() => Symbol(id));
  const shown = useSyncExternalStore(
    subscribeCoachTip,
    () => coachTipOwner() === owner,
    () => false,
  );
  const mounted = useRef(true);
  const show = useCallback(() => {
    if (!mounted.current) return;
    if (useDawStore.getState().pointerKind !== "coarse") return;
    showCoachTip(id, owner);
  }, [id, owner]);
  const dismiss = useCallback(() => dismissCoachTip(id), [id]);
  const release = useCallback(() => releaseCoachTip(owner), [owner]);

  useEffect(() => {
    if (!shown) return;
    // Capture: a listener added while the raising press is still dispatching
    // would otherwise catch that same press in the bubble phase.
    const onAction = (event: Event) => {
      if ((event.target as Element | null)?.closest?.(".sys-coach-tip")) return;
      if (event instanceof KeyboardEvent && NOT_ACTING_KEYS.has(event.key))
        return;
      dismissCoachTip(id);
    };
    window.addEventListener("pointerdown", onAction, { capture: true });
    window.addEventListener("keydown", onAction, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onAction, { capture: true });
      window.removeEventListener("keydown", onAction, { capture: true });
    };
  }, [shown, id]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseCoachTip(owner);
    };
  }, [owner]);

  return { text: COACH_TIPS[id], shown, show, dismiss, release };
}

/** The Undo tip: raised by the first undoable edit while `enabled`. */
export function useUndoCoachTip(enabled: boolean): CoachTipControl {
  const tip = useCoachTip("undo");
  const moment = useDawStore((s) => undoTipMoment(s.feedbackToast));
  const { show } = tip;
  useEffect(() => {
    if (enabled && moment !== null) show();
  }, [enabled, moment, show]);
  return tip;
}
