import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cancelPipelineRun,
  JobCancelledError,
  startBounceJob,
} from "../../api";
import { useModelResume } from "../../models";
import {
  BOUNCE_DEFAULTS,
  type BounceChoices,
  bounceBlocker,
  bounceBody,
  bounceResultCopy,
} from "../../stages/deliver/bounceLogic";
import { useDawStore } from "../../state/dawStore";
import { projectScopedSignal } from "../../state/projectScopedSignal";
import { runAnnouncedJob } from "../../state/runAnnouncedJob";
import { selectedTrackIdsOf } from "../../state/selection";
import type { ExactRangeTarget } from "../../types/project";
import {
  errorMessage,
  isAbortError,
  isModelNeeded,
  type ModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import { jobResultPaths } from "../../utils/pipeline";
import { type BounceFlow, type BounceRun, Flow } from "./bounceFlowContext";

type BounceRequest = {
  projectPath: string;
  projectEpoch: number;
  range: ExactRangeTarget | null;
  body: ReturnType<typeof bounceBody>;
};

type BounceModelNeed = ModelNeeded & BounceRequest;

/**
 * The host bounce, outside any stage so it outlives them: the same
 * `BounceService` job as MCP `bounce_audio_tool` and CLI `podcast pipeline bounce`.
 * Switching stage leaves the bounce running on the Activity chip, and Deliver
 * shows its progress or outcome again. A project switch stops following the
 * job and returns to idle.
 */
export function BounceFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const activityJob = useDawStore((s) => s.activityJob);
  const [run, setRun] = useState<BounceRun>({ kind: "idle" });
  const [choices, setChoices] = useState<BounceChoices>(BOUNCE_DEFAULTS);
  const restart = useRef<(need: BounceModelNeed) => void>(() => undefined);
  const retried = useRef<string | null>(null);
  const {
    stop: needs,
    stopFor,
    clear,
  } = useModelResume<BounceModelNeed>((need) => restart.current(need));
  const runRef = useRef(run);
  runRef.current = run;
  const choicesRef = useRef(choices);
  choicesRef.current = choices;

  // A new project starts over, and its running bounce is no longer followed.
  useEffect(() => {
    setRun({ kind: "idle" });
    setChoices(BOUNCE_DEFAULTS);
    clear();
  }, [projectPath, clear]);

  // Leaving Deliver ends this visit: a range fixed from Edit, the bounce
  // choices and a failed or cancelled outcome (its retry would bounce the whole
  // mix once the range is gone) do not carry to the next visit.
  const stage = useDawStore((s) => s.stage);
  const wasDeliver = useRef(stage === "deliver");
  useEffect(() => {
    const was = wasDeliver.current;
    wasDeliver.current = stage === "deliver";
    if (!was || stage === "deliver") return;
    clear();
    useDawStore.getState().setBounceRangeTarget(null);
    setChoices(BOUNCE_DEFAULTS);
    setRun((r) =>
      r.kind === "failed" || r.kind === "cancelled" ? { kind: "idle" } : r,
    );
  }, [stage, clear]);

  const start = useCallback(
    async (request?: BounceRequest) => {
      const s = useDawStore.getState();
      const path = request?.projectPath ?? s.projectPath;
      if (!path || runRef.current.kind === "running") return;
      const range = request ? request.range : s.bounceRangeTarget;
      const picked = choicesRef.current;
      const selectedTrackIds = selectedTrackIdsOf(s.selection);
      const soloTracks = s.soloTracks;
      const soloed = Object.values(soloTracks).filter(Boolean).length;
      if (
        !request &&
        bounceBlocker(
          picked,
          { selected: selectedTrackIds.length, soloed },
          range !== null,
        )
      ) {
        return;
      }
      const body =
        request?.body ??
        bounceBody({
          choices: picked,
          selectedTrackIds,
          soloTracks,
          region: s.sessionRegion,
          range,
        });
      const scope = projectScopedSignal(path);
      setRun({
        kind: "running",
        jobId: null,
        cancelling: false,
        cancelError: null,
        range,
      });
      try {
        const done = await runAnnouncedJob(() => startBounceJob(path, body), {
          failLabel: "Bounce failed",
          resultCopy: bounceResultCopy,
          signal: scope.signal,
          onStart: (job) =>
            setRun((r) => (r.kind === "running" ? { ...r, jobId: job.id } : r)),
        });
        if (scope.signal.aborted) return;
        if (useDawStore.getState().bounceRangeTarget === range) {
          useDawStore.getState().setBounceRangeTarget(null);
        }
        setRun({ kind: "done", paths: jobResultPaths(done) });
      } catch (err) {
        if (scope.signal.aborted) return;
        if (isAbortError(err)) {
          setRun({ kind: "idle" });
        } else if (
          isModelNeeded(err) &&
          useDawStore.getState().stage === "deliver" &&
          retried.current !== err.model.id
        ) {
          runRef.current = { kind: "idle" };
          setRun({ kind: "idle" });
          stopFor({
            ...err.model,
            projectPath: path,
            projectEpoch: request?.projectEpoch ?? s.projectEpoch,
            range,
            body,
          });
        } else if (isModelNeeded(err)) {
          setRun({ kind: "failed", reason: notDownloadedLine(err.model) });
        } else if (err instanceof JobCancelledError) {
          setRun({ kind: "cancelled", paths: jobResultPaths(err.job) });
        } else {
          setRun({ kind: "failed", reason: errorMessage(err) });
        }
      } finally {
        scope.dispose();
      }
    },
    [stopFor],
  );

  restart.current = (need) => {
    const current = useDawStore.getState();
    if (
      current.stage !== "deliver" ||
      current.projectPath !== need.projectPath ||
      current.projectEpoch !== need.projectEpoch
    ) {
      return;
    }
    retried.current = need.id;
    void start(need);
  };

  const cancel = useCallback(async () => {
    const r = runRef.current;
    if (r.kind !== "running" || r.jobId == null) return;
    setRun({ ...r, cancelling: true, cancelError: null });
    try {
      await cancelPipelineRun(r.jobId);
    } catch (err) {
      setRun((now) =>
        now.kind === "running" && now.jobId === r.jobId
          ? { ...now, cancelling: false, cancelError: errorMessage(err) }
          : now,
      );
    }
  }, []);

  const again = useCallback(() => setRun({ kind: "idle" }), []);

  const job =
    run.kind === "running" &&
    activityJob != null &&
    activityJob.id === run.jobId
      ? activityJob
      : null;
  const value = useMemo<BounceFlow>(
    () => ({
      run,
      job,
      choices,
      setChoices,
      needs,
      start: () => {
        retried.current = null;
        clear();
        void start();
      },
      cancel: () => void cancel(),
      again,
    }),
    [run, job, choices, needs, start, cancel, again, clear],
  );
  return <Flow.Provider value={value}>{children}</Flow.Provider>;
}
