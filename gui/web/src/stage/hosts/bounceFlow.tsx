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

interface BounceOwner {
  projectPath: string | null;
  projectEpoch: number;
}

type BounceAttempt = { owner: BounceOwner };

type BounceState = {
  owner: BounceOwner;
  onDeliver: boolean;
  run: BounceRun;
  attempt: BounceAttempt | null;
  choices: BounceChoices;
};

/** A project-owned bounce that keeps running when the person leaves Deliver. */
export function BounceFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const activityJob = useDawStore((s) => s.activityJob);
  const onDeliver = useDawStore((s) => s.stage === "deliver");
  const [state, setState] = useState<BounceState>(() => ({
    owner: { projectPath, projectEpoch },
    onDeliver,
    run: { kind: "idle" },
    attempt: null,
    choices: BOUNCE_DEFAULTS,
  }));
  const { owner, run, choices } = state;
  if (
    owner.projectPath !== projectPath ||
    owner.projectEpoch !== projectEpoch
  ) {
    setState({
      owner: { projectPath, projectEpoch },
      onDeliver,
      run: { kind: "idle" },
      attempt: null,
      choices: BOUNCE_DEFAULTS,
    });
  } else if (state.onDeliver !== onDeliver) {
    setState({
      ...state,
      onDeliver,
      choices: onDeliver ? choices : BOUNCE_DEFAULTS,
      run:
        !onDeliver && (run.kind === "failed" || run.kind === "cancelled")
          ? { kind: "idle" }
          : run,
    });
  }
  const gate = useModelGate();
  const resetGate = gate.reset;
  const inFlight = useRef<BounceAttempt | null>(null);
  useEffect(() => resetGate(), [owner, resetGate]);

  const wasDeliver = useRef(onDeliver);
  useEffect(() => {
    const was = wasDeliver.current;
    wasDeliver.current = onDeliver;
    if (was && !onDeliver) useDawStore.getState().setBounceRangeTarget(null);
  }, [onDeliver]);

  const setChoices = useCallback(
    (next: BounceChoices) => {
      setState((current) =>
        current.owner === owner ? { ...current, choices: next } : current,
      );
    },
    [owner],
  );

  const start = useCallback(async () => {
    const s = useDawStore.getState();
    const path = s.projectPath;
    if (
      !path ||
      path !== owner.projectPath ||
      s.projectEpoch !== owner.projectEpoch ||
      inFlight.current?.owner === owner
    )
      return;
    const range = s.bounceRangeTarget;
    const picked = choices;
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
    const scope = projectScopedSignal({
      lifetime: "document",
      path,
      epoch: owner.projectEpoch,
    });
    const attempt: BounceAttempt = { owner };
    inFlight.current = attempt;
    setState((current) =>
      current.owner === owner
        ? {
            ...current,
            attempt,
            run: {
              kind: "running",
              jobId: null,
              cancelling: false,
              cancelError: null,
              range,
            },
          }
        : current,
    );
    try {
      const ran = await gate.run(async () => {
        try {
          return await runAnnouncedJob(() => startBounceJob(path, body), {
            failLabel: "Bounce failed",
            resultCopy: bounceResultCopy,
            signal: scope.signal,
            onStart: (job) =>
              setState((current) =>
                current.owner === owner &&
                current.attempt === attempt &&
                current.run.kind === "running"
                  ? { ...current, run: { ...current.run, jobId: job.id } }
                  : current,
              ),
          });
        } catch (err) {
          if (
            isModelNeeded(err) &&
            useDawStore.getState().stage !== "deliver"
          ) {
            throw new Error(notDownloadedLine(err.model));
          }
          throw err;
        }
      });
      if (scope.signal.aborted) return;
      if (ran.kind === "declined") {
        setState((current) =>
          current.owner === owner && current.attempt === attempt
            ? { ...current, run: { kind: "idle" } }
            : current,
        );
        return;
      }
      if (useDawStore.getState().bounceRangeTarget === range) {
        useDawStore.getState().setBounceRangeTarget(null);
      }
      setState((current) =>
        current.owner === owner && current.attempt === attempt
          ? {
              ...current,
              run: { kind: "done", paths: jobResultPaths(ran.value) },
            }
          : current,
      );
    } catch (err) {
      if (scope.signal.aborted) return;
      if (isAbortError(err)) {
        setState((current) =>
          current.owner === owner && current.attempt === attempt
            ? { ...current, run: { kind: "idle" } }
            : current,
        );
      } else if (err instanceof JobCancelledError) {
        setState((current) =>
          current.owner === owner && current.attempt === attempt
            ? {
                ...current,
                run: { kind: "cancelled", paths: jobResultPaths(err.job) },
              }
            : current,
        );
      } else {
        setState((current) =>
          current.owner === owner && current.attempt === attempt
            ? { ...current, run: { kind: "failed", reason: errorMessage(err) } }
            : current,
        );
      }
    } finally {
      scope.dispose();
      if (inFlight.current === attempt) inFlight.current = null;
    }
  }, [gate, owner, choices]);

  const cancel = useCallback(async () => {
    const r = run;
    const attempt = state.attempt;
    const currentProject = useDawStore.getState();
    if (
      r.kind !== "running" ||
      r.jobId == null ||
      attempt === null ||
      inFlight.current !== attempt ||
      currentProject.projectPath !== owner.projectPath ||
      currentProject.projectEpoch !== owner.projectEpoch
    )
      return;
    setState((current) =>
      current.owner === owner && current.attempt === attempt
        ? { ...current, run: { ...r, cancelling: true, cancelError: null } }
        : current,
    );
    try {
      await cancelPipelineRun(r.jobId);
    } catch (err) {
      setState((current) =>
        current.owner === owner &&
        current.attempt === attempt &&
        current.run.kind === "running" &&
        current.run.jobId === r.jobId
          ? {
              ...current,
              run: {
                ...current.run,
                cancelling: false,
                cancelError: errorMessage(err),
              },
            }
          : current,
      );
    }
  }, [owner, run, state.attempt]);

  const again = useCallback(() => {
    setState((current) =>
      current.owner === owner ? { ...current, run: { kind: "idle" } } : current,
    );
  }, [owner]);

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
    [run, job, choices, setChoices, gate, start, cancel, again],
  );
  return <Flow.Provider value={value}>{children}</Flow.Provider>;
}
