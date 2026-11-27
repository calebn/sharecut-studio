import { useEffect, useState, useSyncExternalStore } from "react";
import { type DuckingPlan, previewDucking } from "../../api";
import {
  type DuckingKind,
  type DuckingRefusal,
  duckingKind,
  duckingRefusal,
  duckingRefusedMessage,
} from "../../commands/duckingCopy";
import {
  duckingReplanCount,
  subscribeDuckingReplan,
} from "../../commands/duckingReplan";
import { useDaw } from "../../state/useDaw";

/** What the dry run says about the music tracks right now. */
export type DuckingPreview =
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: "refused"; message: string }
  | { kind: DuckingRefusal }
  | { kind: DuckingKind; plan: DuckingPlan };

/** Long enough that a burst of edits plans once, short enough to feel live. */
export const DUCKING_PREVIEW_DEBOUNCE_MS = 500;

/**
 * Dry-runs ducking while `enabled`, again whenever the episode's history moves
 * (a cut or move leaves old dips behind, so the plan then differs), whenever an
 * apply was refused (the plan can move without the head, for example when the
 * pipeline settings change), and on every open. Nothing is stored: the dry run
 * is the stale signal. A superseded dry run is aborted.
 */
export function useDuckingPreview(enabled: boolean): DuckingPreview {
  const projectPath = useDaw((s) => s.projectPath);
  const headId = useDaw((s) => s.project?.history.head_id ?? null);
  const replan = useSyncExternalStore(
    subscribeDuckingReplan,
    duckingReplanCount,
  );
  const [preview, setPreview] = useState<DuckingPreview>({ kind: "checking" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: headId only signals that the episode moved on
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const controller = new AbortController();
    setPreview({ kind: "checking" });
    const timer = setTimeout(() => {
      previewDucking(projectPath, controller.signal).then(
        (plan) => {
          if (live) setPreview({ kind: duckingKind(plan), plan });
        },
        (error: unknown) => {
          if (!live) return;
          const refusal = duckingRefusal(error);
          const message = duckingRefusedMessage(error);
          if (refusal) setPreview({ kind: refusal });
          else if (message !== null) setPreview({ kind: "refused", message });
          else setPreview({ kind: "unreachable" });
        },
      );
    }, DUCKING_PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, projectPath, headId, replan]);

  return preview;
}
