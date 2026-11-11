import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  cancelPipelineRun,
  JobCancelledError,
  startBounceJob,
} from "../../api";
import {
  EXPORT_STARTING_REASON,
  exportBusyReason,
  registerBounceRunner,
} from "../../commands/bounceRunnerHandle";
import type { ExecuteResult } from "../../commands/types";
import { useNowSec } from "../../hooks/useNowSec";
import { useModelResume, useModels } from "../../models";
import { useDawStore } from "../../state/dawStore";
import { projectScopedSignal } from "../../state/projectScopedSignal";
import { runAnnouncedJob } from "../../state/runAnnouncedJob";
import {
  errorMessage,
  isAbortError,
  isModelNeeded,
  type ModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import { jobResultPaths } from "../../utils/pipeline";
import {
  type BounceRequest,
  bounceBody,
  bounceResultCopy,
} from "../edit/exportRange";
import { bounceResultAction, fileIdsOf } from "./bounceResultAction";
import { type BounceRun, BounceRunContext, IDLE } from "./bounceRunnerContext";
import { hostFileAccess } from "./useDeliverFiles";
import { useStallAnnouncement } from "./useStallAnnouncement";

type BounceModelNeed = ModelNeeded & {
  request: BounceRequest;
  projectPath: string;
  projectEpoch: number;
};

const ALREADY_RUNNING = "Export is already running";

/**
 * The host's range and episode export, outside any stage so it outlives them: the same
 * `BounceService` job as MCP `bounce_audio_tool` and CLI `podcast pipeline bounce`.
 * Progress is the Activity chip and the result is a toast. A project switch stops
 * following the job and returns to idle.
 */
export function BounceRunnerProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const activityJob = useDawStore((s) => s.activityJob);
  const announceStatus = useDawStore((s) => s.announceStatus);
  const [run, setRun] = useState<BounceRun>(IDLE);
  const runRef = useRef(run);
  runRef.current = run;
  const activeAttempt = useRef<symbol | null>(null);
  const startRef = useRef<(request: BounceRequest) => Promise<ExecuteResult>>(
    () => Promise.resolve({ status: "ok" }),
  );
  const restart = useRef<(need: BounceModelNeed) => void>(() => undefined);
  const retried = useRef<string | null>(null);
  const { download } = useModels();
  const downloadRef = useRef(download);
  downloadRef.current = download;
  const { stopFor, clear } = useModelResume<BounceModelNeed>((need) =>
    restart.current(need),
  );

  useEffect(() => {
    activeAttempt.current = null;
    runRef.current = IDLE;
    setRun(IDLE);
    retried.current = null;
    clear();
  }, [projectPath, projectEpoch, clear]);

  const launch = useCallback(
    (
      request: BounceRequest,
      path: string,
      epoch: number,
    ): Promise<ExecuteResult> => {
      const body = bounceBody(request);
      const scope = projectScopedSignal(path);
      const attempt = Symbol();
      activeAttempt.current = attempt;
      const isCurrent = () => {
        const current = useDawStore.getState();
        return (
          activeAttempt.current === attempt &&
          !scope.signal.aborted &&
          current.projectPath === path &&
          current.projectEpoch === epoch
        );
      };
      const running: BounceRun = {
        kind: "running",
        jobId: null,
        cancelling: false,
      };
      runRef.current = running;
      setRun(running);
      let started = false;
      void (async () => {
        try {
          await runAnnouncedJob(() => startBounceJob(path, body), {
            kind: "bounce",
            failLabel: "Export failed",
            summarizeResult: (job) => {
              if (job.status === "cancelled" && !jobResultPaths(job).length)
                return null;
              const action = bounceResultAction(
                path,
                fileIdsOf(job),
                hostFileAccess(),
              );
              return {
                copy: bounceResultCopy(request),
                ...(action ? { action } : {}),
              };
            },
            signal: scope.signal,
            onStart: (job) => {
              started = true;
              if (!isCurrent()) return;
              const next: BounceRun = { ...running, jobId: job.id };
              runRef.current = next;
              setRun(next);
            },
          });
        } catch (err) {
          if (!isCurrent() || isAbortError(err)) return;
          if (isModelNeeded(err)) {
            const model = err.model;
            if (retried.current === model.id) {
              announceStatus(notDownloadedLine(model), { tone: "error" });
            } else {
              stopFor({
                ...model,
                request,
                projectPath: path,
                projectEpoch: epoch,
              });
              announceStatus(notDownloadedLine(model), {
                tone: "error",
                action: {
                  label: "Get",
                  run: () =>
                    void downloadRef.current(
                      [model.id],
                      model.id === "whisper" && model.variant
                        ? { whisperModel: model.variant }
                        : undefined,
                    ),
                },
              });
            }
          } else if (!(err instanceof JobCancelledError) && !started) {
            announceStatus(`Export failed. ${errorMessage(err)}`, {
              tone: "error",
            });
          }
        } finally {
          scope.dispose();
          if (activeAttempt.current === attempt) {
            activeAttempt.current = null;
            runRef.current = IDLE;
            setRun(IDLE);
          }
        }
      })();
      return Promise.resolve({ status: "ok" });
    },
    [announceStatus, stopFor],
  );

  const start = useCallback(
    (request: BounceRequest): Promise<ExecuteResult> => {
      const s = useDawStore.getState();
      const path = s.projectPath;
      if (!path || s.guestMode !== null)
        return Promise.resolve({
          status: "disabled",
          reason: path ? "Only the host can export" : "Open a project",
        });
      if (runRef.current.kind === "running")
        return Promise.resolve({ status: "disabled", reason: ALREADY_RUNNING });
      const busy = exportBusyReason(s.activityJob);
      if (busy) return Promise.resolve({ status: "disabled", reason: busy });
      retried.current = null;
      clear();
      return launch(request, path, s.projectEpoch);
    },
    [launch, clear],
  );
  startRef.current = start;

  restart.current = (need) => {
    const current = useDawStore.getState();
    if (
      current.projectPath !== need.projectPath ||
      current.projectEpoch !== need.projectEpoch ||
      runRef.current.kind === "running"
    )
      return;
    retried.current = need.id;
    void launch(need.request, need.projectPath, need.projectEpoch);
  };

  const cancel = useCallback(async (): Promise<ExecuteResult> => {
    const r = runRef.current;
    if (r.kind !== "running")
      return { status: "disabled", reason: "Nothing is exporting" };
    if (r.jobId === null)
      return { status: "disabled", reason: EXPORT_STARTING_REASON };
    const next: BounceRun = { ...r, cancelling: true };
    runRef.current = next;
    setRun(next);
    try {
      await cancelPipelineRun(r.jobId);
    } catch (err) {
      const now = runRef.current;
      if (now.kind === "running" && now.jobId === r.jobId) {
        const back: BounceRun = { ...now, cancelling: false };
        runRef.current = back;
        setRun(back);
      }
      announceStatus(`Couldn't cancel the export. ${errorMessage(err)}`, {
        tone: "error",
      });
    }
    return { status: "ok" };
  }, [announceStatus]);

  useEffect(
    () =>
      registerBounceRunner({
        start: (request) => startRef.current(request),
        cancel,
      }),
    [cancel],
  );

  const job =
    run.kind === "running" &&
    activityJob != null &&
    activityJob.id === run.jobId
      ? activityJob
      : null;
  const nowSec = useNowSec(run.kind === "running");
  useStallAnnouncement(
    [
      {
        running: run.kind === "running" && !run.cancelling,
        tracked: job != null,
        lastProgressAt: job?.last_progress_at,
      },
    ],
    nowSec,
    (message) => announceStatus(message, { toast: false }),
  );

  return (
    <BounceRunContext.Provider value={run}>
      {children}
    </BounceRunContext.Provider>
  );
}
