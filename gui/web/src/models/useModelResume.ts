import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelNeeded } from "../utils/apiError";
import { type NeedTarget, rowInstalled } from "./capability";
import { useModels } from "./useModels";

type Stop<N> = { need: N; afterGeneration: number };

/**
 * A step that stopped for a missing model waits here. `stopFor` records the model; the Model need
 * row shows Get, and `resume` runs once, by itself, when that model lands. The status is read fresh
 * first, so a stale "installed" row never replays the step and a model that is in already does.
 */
export function useModelResume<N extends NeedTarget = ModelNeeded>(
  resume: (need: N) => void,
) {
  const { lookup, observe } = useModels();
  const [stop, setStop] = useState<Stop<N> | null>(null);
  const pending = useRef<Stop<N> | null>(null);
  const resumeRef = useRef(resume);
  const lookupRef = useRef(lookup);
  useEffect(() => {
    resumeRef.current = resume;
  }, [resume]);
  useEffect(() => {
    lookupRef.current = lookup;
  }, [lookup]);

  const stopFor = useCallback(
    (need: N) => {
      const next = {
        need,
        afterGeneration: lookupRef.current(need).observation.generation,
      };
      pending.current = next;
      setStop(next);
      void observe(need);
    },
    [observe],
  );
  const clear = useCallback(() => {
    pending.current = null;
    setStop(null);
  }, []);

  const need = stop?.need ?? null;
  const target = need ? lookup(need) : null;
  const row = target?.row ?? null;
  const observation = target?.observation;
  const here = need !== null && rowInstalled(row, need);
  const ready =
    stop !== null &&
    observation?.kind === "current" &&
    observation.generation > stop.afterGeneration &&
    here;
  useEffect(() => {
    if (ready && stop && pending.current === stop) {
      pending.current = null;
      setStop(null);
      resumeRef.current(stop.need);
    }
  }, [ready, stop]);

  return { stop: need, stopFor, clear };
}
