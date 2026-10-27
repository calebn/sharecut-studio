import { useEffect, useRef, useState } from "react";
import type { SaveIndicatorProps } from "../../system/SaveIndicator";
import type { SaveState } from "./saveState";
import { type SaveAttention, useSaveState } from "./useSaveState";

/** How long the check stays after a save finishes. */
const JUST_SAVED_MS = 2000;

/** The header's Save indicator for a save state; Retry goes to the Needs attention banner. */
export function saveIndicatorOf(
  state: SaveState,
  attention: SaveAttention,
  justSaved = false,
): SaveIndicatorProps {
  switch (state.kind) {
    case "saving":
      return { state: "saving" };
    case "saved":
      return { state: "saved", justSaved };
    case "waiting":
      return { state: "offline", waiting: state.count };
    case "failed":
    case "unknown":
      return {
        state: "failed",
        onRetry: attention.kind === "button" ? attention.activate : undefined,
      };
  }
}

/** Null when there is nothing to say: a guest, or a queue not read yet. */
export function useSaveIndicator(): SaveIndicatorProps | null {
  const { state, attention } = useSaveState();
  const [justSaved, setJustSaved] = useState(false);
  const previous = useRef<SaveState["kind"] | null>(null);
  const kind = state?.kind ?? null;
  useEffect(() => {
    const before = previous.current;
    previous.current = kind;
    if (kind !== "saved") {
      setJustSaved(false);
      return;
    }
    if (before !== "saving") return;
    setJustSaved(true);
    const timer = window.setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [kind]);
  return state ? saveIndicatorOf(state, attention, justSaved) : null;
}
