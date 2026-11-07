import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { startPipelineRun } from "../../api";
import { useModelResume } from "../../models";
import { useDawStore } from "../../state/dawStore";
import {
  errorMessage,
  isModelNeeded,
  type ModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import {
  type FindMoreFlow,
  type FindMoreRequest,
  type FindMoreRun,
  Flow,
} from "./findMoreFlowContext";

const modelKey = (model: Pick<ModelNeeded, "id" | "variant">) =>
  `${model.id}:${model.variant ?? ""}`;

function ownsRequest(request: FindMoreRequest) {
  const store = useDawStore.getState();
  return (
    store.projectPath === request.path && store.projectEpoch === request.epoch
  );
}

export function FindMoreFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const [run, setRun] = useState<FindMoreRun | null>(null);
  const retried = useRef<string | null>(null);

  const resume = useCallback(async (request: FindMoreRequest) => {
    if (!ownsRequest(request)) return;
    const { path, options } = request;
    const store = useDawStore.getState();
    setRun({ path, jobId: null, error: null });
    try {
      const started = await startPipelineRun(path, options);
      store.setPipelineJob(started);
      if (!ownsRequest(request)) return;
      setRun({ path, jobId: started.id, error: null });
      if (useDawStore.getState().projectPath === path) {
        store.announceStatus("Finding more suggestions…");
      }
    } catch (error) {
      if (!ownsRequest(request)) return;
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
  } = useModelResume<ModelNeeded & { request: FindMoreRequest }>((model) => {
    retried.current = modelKey(model);
    if (ownsRequest(model.request)) void resume(model.request);
  });

  useEffect(() => {
    retried.current = null;
    setRun(null);
    clear();
  }, [projectPath, projectEpoch, clear]);

  const stopFor = useCallback(
    (need: ModelNeeded, request: FindMoreRequest) => {
      if (!ownsRequest(request) || retried.current === modelKey(need))
        return false;
      wait({ ...need, request });
      return true;
    },
    [wait],
  );
  const fresh = useCallback(() => {
    retried.current = null;
    clear();
  }, [clear]);

  const flow = useMemo<FindMoreFlow>(
    () => ({ run, setRun, needs, stopFor, fresh }),
    [run, needs, stopFor, fresh],
  );
  return <Flow.Provider value={flow}>{children}</Flow.Provider>;
}
