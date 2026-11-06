import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadPipelineConfig, startPipelineRun } from "../../api";
import { useModelResume } from "../../models";
import { useDawStore } from "../../state/dawStore";
import {
  errorMessage,
  isModelNeeded,
  type ModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import {
  currentTightenIntensity,
  tightenProposeRunOptions,
} from "../../utils/tightenIntensity";
import {
  type FindMoreFlow,
  type FindMoreRun,
  Flow,
  NO_TIER,
} from "./findMoreFlowContext";

const modelKey = (model: Pick<ModelNeeded, "id" | "variant">) =>
  `${model.id}:${model.variant ?? ""}`;

export function FindMoreFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const [run, setRun] = useState<FindMoreRun | null>(null);
  const stoppedAt = useRef<string | null>(null);
  const retried = useRef<string | null>(null);

  const resume = useCallback(async (path: string) => {
    const store = useDawStore.getState();
    setRun({ path, jobId: null, error: null });
    try {
      const fresh = await loadPipelineConfig(path);
      const tier = currentTightenIntensity(fresh);
      if (!tier) throw new Error(NO_TIER);
      const started = await startPipelineRun(
        path,
        tightenProposeRunOptions(fresh, tier),
      );
      store.setPipelineJob(started);
      setRun({ path, jobId: started.id, error: null });
      if (useDawStore.getState().projectPath === path) {
        store.announceStatus("Finding more suggestions…");
      }
    } catch (error) {
      const refused = isModelNeeded(error)
        ? notDownloadedLine(error.model)
        : errorMessage(error);
      setRun({ path, jobId: null, error: refused });
      store.announceStatus("Could not find more suggestions.", {
        tone: "error",
      });
    }
  }, []);

  const {
    stop: needs,
    stopFor: wait,
    clear,
  } = useModelResume((model) => {
    const path = stoppedAt.current;
    stoppedAt.current = null;
    retried.current = modelKey(model);
    if (path && useDawStore.getState().projectPath === path) void resume(path);
  });

  useEffect(() => {
    stoppedAt.current = null;
    clear();
  }, [projectPath, clear]);

  const stopFor = useCallback(
    (need: ModelNeeded) => {
      if (retried.current === modelKey(need)) return false;
      stoppedAt.current = useDawStore.getState().projectPath;
      wait(need);
      return true;
    },
    [wait],
  );
  const fresh = useCallback(() => {
    retried.current = null;
  }, []);

  const flow = useMemo<FindMoreFlow>(
    () => ({ run, setRun, needs, stopFor, fresh }),
    [run, needs, stopFor, fresh],
  );
  return <Flow.Provider value={flow}>{children}</Flow.Provider>;
}
