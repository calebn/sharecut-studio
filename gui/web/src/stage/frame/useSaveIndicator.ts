import { useEffect, useState } from "react";
import type { SaveIndicatorProps } from "../../system/SaveIndicator";
import type { SaveState } from "./saveState";
import { type SaveAttention, useSaveState } from "./useSaveState";

const JUST_SAVED_MS = 2000;

/** The header's Save indicator for a save state; Retry goes to the Needs attention group. */
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
    case "unreachable":
      return { state: "unreachable", waiting: state.count };
    case "failed":
    case "unknown":
      return {
        state: "failed",
        onRetry: attention.kind === "button" ? attention.activate : undefined,
      };
  }
}

/** Null when there is nothing to say: a queue not read yet. */
export function useSaveIndicator(): SaveIndicatorProps | null {
  const { state, attention } = useSaveState();
  const kind = state?.kind ?? null;
  const [pulse, setPulse] = useState<{
    kind: SaveState["kind"] | null;
    justSaved: boolean;
  }>(() => ({ kind, justSaved: false }));
  if (pulse.kind !== kind) {
    setPulse({ kind, justSaved: kind === "saved" && pulse.kind === "saving" });
  }
  useEffect(() => {
    if (!pulse.justSaved) return;
    const timer = window.setTimeout(
      () =>
        setPulse((current) =>
          current === pulse ? { ...current, justSaved: false } : current,
        ),
      JUST_SAVED_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pulse]);
  return state ? saveIndicatorOf(state, attention, pulse.justSaved) : null;
}
