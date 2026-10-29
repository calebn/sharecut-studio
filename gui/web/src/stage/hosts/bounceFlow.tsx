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
import { useModelGate } from "../../models";
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
import {
  errorMessage,
  isAbortError,
  isModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import { jobResultPaths } from "../../utils/pipeline";
import { type BounceFlow, type BounceRun, Flow } from "./bounceFlowContext";

/**
 * The host bounce, outside any stage so it outlives them: the same
 * `BounceService` job as MCP `bounce_audio` and CLI `podcast pipeline bounce`.
 * Switching stage leaves the bounce running on the Activity chip, and Deliver
 * shows its progress or outcome again. A project switch stops following the
 * job and returns to idle.
 */
export function BounceFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const activityJob = useDawStore((s) => s.activityJob);
  const [run, setRun] = useState<BounceRun>({ kind: "idle" });
  const [choices, setChoices] = useState<BounceChoices>(BOUNCE_DEFAULTS);
  const gate = useModelGate();
  const resetGate = gate.reset;
  const runRef = useRef(run);
  runRef.current = run;
  const choicesRef = useRef(choices);
  choicesRef.current = choices;

  // A new project starts over, and its running bounce is no longer followed.
  useEffect(() => {
    setRun({ kind: "idle" });
    setChoices(BOUNCE_DEFAULTS);
    resetGate();
  }, [projectPath, resetGate]);

  // Leaving Deliver ends this visit, as closing the old dialog did: a range
  // fixed from Edit and the bounce choices do not carry to the next visit.
  const stage = useDawStore((s) => s.stage);
  const wasDeliver = useRef(stage === "deliver");
  useEffect(() => {
    const was = wasDeliver.current;
    wasDeliver.current = stage === "deliver";
    if (!was || stage === "deliver") return;
    useDawStore.getState().setBounceRangeTarget(null);
    setChoices(BOUNCE_DEFAULTS);
  }, [stage]);

  const start = useCallback(async () => {
    const s = useDawStore.getState();
    const path = s.projectPath;
    if (!path || runRef.current.kind === "running") return;
    const range = s.bounceRangeTarget;
    const picked = choicesRef.current;
    const selectedTrackIds = selectedTrackIdsOf(s.selection);
    const soloTracks = s.soloTracks;
    const soloed = Object.values(soloTracks).filter(Boolean).length;
    if (
      bounceBlocker(
        picked,
        { selected: selectedTrackIds.length, soloed },
        range !== null,
      )
    ) {
      return;
    }
    const body = bounceBody({
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
    });
    try {
      const ran = await gate.run(async () => {
        try {
          return await runAnnouncedJob(() => startBounceJob(path, body), {
            failLabel: "Bounce failed",
            resultCopy: bounceResultCopy,
            signal: scope.signal,
            onStart: (job) =>
              setRun((r) =>
                r.kind === "running" ? { ...r, jobId: job.id } : r,
              ),
          });
        } catch (err) {
          // Nobody is looking at Deliver, so there is no one to ask.
          if (
            isModelNeeded(err) &&
            useDawStore.getState().stage !== "deliver"
          ) {
            throw new Error(notDownloadedLine(err.model));
          }
          throw err;
        }
      });
      if (ran.kind === "declined") {
        // Declining is a choice, not a failure: back to idle.
        setRun({ kind: "idle" });
        return;
      }
      if (scope.signal.aborted) return;
      useDawStore.getState().setBounceRangeTarget(null);
      setRun({ kind: "done", paths: jobResultPaths(ran.value) });
    } catch (err) {
      if (isAbortError(err)) {
        setRun({ kind: "idle" });
      } else if (err instanceof JobCancelledError) {
        setRun({ kind: "cancelled", paths: jobResultPaths(err.job) });
      } else {
        setRun({ kind: "failed", reason: errorMessage(err) });
      }
    } finally {
      scope.dispose();
    }
  }, [gate]);

  const cancel = useCallback(async () => {
    const r = runRef.current;
    if (r.kind !== "running" || r.jobId == null) return;
    setRun({ ...r, cancelling: true, cancelError: null });
    try {
      await cancelPipelineRun(r.jobId);
    } catch (err) {
      setRun((now) =>
        now.kind === "running"
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
      gate,
      start: () => void start(),
      cancel: () => void cancel(),
      again,
    }),
    [run, job, choices, gate, start, cancel, again],
  );
  return <Flow.Provider value={value}>{children}</Flow.Provider>;
}
