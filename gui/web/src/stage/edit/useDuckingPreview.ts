import { useEffect, useState } from "react";
import { type DuckingPlan, previewDucking } from "../../api";
import {
  type DuckingKind,
  type DuckingRefusal,
  duckingKind,
  duckingRefusal,
} from "../../commands/duckingCopy";
import { useDaw } from "../../state/useDaw";

/** What the dry run says about the music tracks right now. */
export type DuckingPreview =
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: DuckingRefusal }
  | { kind: DuckingKind; plan: DuckingPlan };

/** Long enough that a burst of edits plans once, short enough to feel live. */
export const DUCKING_PREVIEW_DEBOUNCE_MS = 500;

/**
 * Dry-runs ducking while `enabled`, again whenever the episode's history moves
 * (a cut or move leaves old dips behind, so the plan then differs). Nothing is
 * stored: the dry run is the stale signal.
 */
export function useDuckingPreview(enabled: boolean): DuckingPreview {
  const projectPath = useDaw((s) => s.projectPath);
  const headId = useDaw((s) => s.project?.history.head_id ?? null);
  const [preview, setPreview] = useState<DuckingPreview>({ kind: "checking" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: headId only signals that the episode moved on
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setPreview({ kind: "checking" });
    const timer = setTimeout(() => {
      previewDucking(projectPath).then(
        (plan) => {
          if (live) setPreview({ kind: duckingKind(plan), plan });
        },
        (error: unknown) => {
          if (!live) return;
          const refusal = duckingRefusal(error);
          setPreview(refusal ? { kind: refusal } : { kind: "unreachable" });
        },
      );
    }, DUCKING_PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled, projectPath, headId]);

  return preview;
}
