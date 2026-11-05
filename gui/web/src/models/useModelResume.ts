import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelNeeded } from "../utils/apiError";
import { type NeedTarget, rowInstalled } from "./capability";
import { useModels } from "./useModels";

type Stop<N> = { need: N; seenMissing: boolean; checked: boolean };

/**
 * A step that stopped for a missing model waits here. `stopFor` records the model; the Model need
 * row shows Get, and `resume` runs once, by itself, when that model lands. The status is read fresh
 * first, so a stale "installed" row never replays the step and a model that is in already does.
 */
export function useModelResume<N extends NeedTarget = ModelNeeded>(
  resume: (need: N) => void,
) {
  const { models, refresh } = useModels();
  const [stop, setStop] = useState<Stop<N> | null>(null);
  const resumeRef = useRef(resume);
  useEffect(() => {
    resumeRef.current = resume;
  }, [resume]);

  const stopFor = useCallback(
    (need: N) => {
      setStop({ need, seenMissing: false, checked: false });
      void refresh().then(() =>
        setStop((s) => (s && s.need === need ? { ...s, checked: true } : s)),
      );
    },
    [refresh],
  );
  const clear = useCallback(() => setStop(null), []);

  const need = stop?.need ?? null;
  const row = need ? (models?.find((m) => m.id === need.id) ?? null) : null;
  const here = need !== null && rowInstalled(row, need);
  const ready = stop !== null && here && (stop.seenMissing || stop.checked);
  const missing = stop !== null && !here && !stop.seenMissing;
  useEffect(() => {
    if (missing) {
      setStop((s) => (s ? { ...s, seenMissing: true } : s));
    } else if (ready && stop) {
      setStop(null);
      resumeRef.current(stop.need);
    }
  }, [missing, ready, stop]);

  return { stop: need, stopFor, clear };
}
