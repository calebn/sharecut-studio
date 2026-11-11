import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { retryPipelineJob, waitForPipelineJob } from "../../api";
import { runPointerCommand } from "../../commands/pointer";
import { ModelNeedRow, useModelResume } from "../../models";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import {
  ApiError,
  errorMessage,
  isModelNeeded,
  type ModelNeeded,
  modelNeededOfJob,
  notDownloadedLine,
} from "../../utils/apiError";
import { isTerminalJobStatus } from "../../utils/pipeline";
import { FRAME_ALERT_PRIORITY, useFrameAlert } from "./frameAlerts";

const RESUMABLE = new Set(["pipeline", "render_preview"]);
type Stopped = { job: PipelineJobSnapshot; epoch: number; path: string };
type ModelWait = ModelNeeded & { origin: Stopped; tried: readonly string[] };
type Recovery =
  | { kind: "waiting"; wait: ModelWait }
  | { kind: "pending"; wait: ModelWait }
  | { kind: "refused"; wait: ModelWait; message: string };
type Attempt = {
  models: readonly string[];
  result:
    | { kind: "pending" }
    | { kind: "uncertain" }
    | { kind: "accepted"; jobId: string };
  epoch: number;
  path: string;
  observed: boolean;
};

const modelKey = (model: ModelNeeded) => `${model.id}:${model.variant}`;

type AcceptedJob = {
  jobId: string;
  originalId: string;
  attempt: Attempt;
};
type Scope = Pick<Stopped, "path" | "epoch">;
type ObserveJob = (
  job: PipelineJobSnapshot,
  scope: Scope,
  accepted?: AcceptedJob,
) => void;

function AcceptedJobObserver({
  accepted,
  observe,
}: {
  accepted: AcceptedJob;
  observe: ObserveJob;
}) {
  const [retry, setRetry] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const scope = accepted.attempt;
    const current = useDawStore.getState();
    if (
      current.projectPath !== scope.path ||
      current.projectEpoch !== scope.epoch
    )
      return;
    void waitForPipelineJob(accepted.jobId, { signal: controller.signal }).then(
      (terminal) => {
        if (!controller.signal.aborted) observe(terminal, scope, accepted);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const store = useDawStore.getState();
        if (
          store.projectPath !== scope.path ||
          store.projectEpoch !== scope.epoch
        )
          return;
        const next = errorMessage(error, "Could not check the resumed run.");
        setMessage(next);
        store.announceStatus(next, { tone: "error", toast: false });
      },
    );
    return () => controller.abort();
  }, [accepted, observe, retry]);

  useFrameAlert(
    FRAME_ALERT_PRIORITY.failed,
    message
      ? {
          state: "failed",
          title: message,
          action: {
            label: "Try again",
            name: "Check the resumed run",
            onAction: () => {
              setMessage(null);
              setRetry((value) => value + 1);
            },
          },
        }
      : null,
  );
  return null;
}

function RefusedRunAlert({
  message,
  onTryAgain,
}: {
  message: string;
  onTryAgain: () => void;
}) {
  useFrameAlert(FRAME_ALERT_PRIORITY.failed, {
    state: "failed",
    title: message,
    action: {
      label: "Try again",
      name: "Resume the stopped run",
      onAction: onTryAgain,
    },
  });
  return null;
}

export function JobModelBanner({ guestShare }: { guestShare: boolean }) {
  const job = useDaw((s) => s.activityJob);
  const pipelineJob = useDaw((s) => s.pipelineJob);
  const path = useDaw((s) => s.projectPath);
  const epoch = useDaw((s) => s.projectEpoch);
  const attempts = useRef(new Map<string, Attempt>());
  const recoveries = useRef(new Map<string, Recovery>());
  const acceptedJobs = useRef(new Map<string, AcceptedJob>());
  const terminalJobs = useRef(new Set<string>());
  const mounted = useRef(false);
  const seen = useRef(new Set<string>());
  const identity = useRef({ path, epoch, job });
  const retiredJobs = useRef(new Set<string>());
  const previewRetried = useRef<{
    model: string;
    epoch: number;
    path: string;
  } | null>(null);
  const [, update] = useState(0);

  const put = useCallback((id: string, recovery: Recovery | null) => {
    if (recovery) recoveries.current.set(id, recovery);
    else recoveries.current.delete(id);
    update((n) => n + 1);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const observe = useCallback<ObserveJob>(
    (observed, scope, accepted) => {
      const store = useDawStore.getState();
      if (
        !mounted.current ||
        store.projectPath !== scope.path ||
        store.projectEpoch !== scope.epoch ||
        (observed.project_path && observed.project_path !== scope.path)
      )
        return;
      if (
        retiredJobs.current.has(observed.id) ||
        (observed.retry_of && retiredJobs.current.has(observed.retry_of))
      ) {
        retiredJobs.current.add(observed.id);
        return;
      }
      if (
        accepted &&
        (accepted.jobId !== observed.id ||
          attempts.current.get(accepted.originalId) !== accepted.attempt)
      )
        return;
      const parentEntry = accepted
        ? ([accepted.originalId, accepted.attempt] as const)
        : [...attempts.current.entries()].find(
            ([id, entry]) =>
              id === observed.retry_of ||
              (entry.result.kind === "accepted" &&
                entry.result.jobId === observed.id),
          );
      const parent = parentEntry?.[1];
      const terminal = isTerminalJobStatus(observed.status);
      if (terminal) {
        terminalJobs.current.add(observed.id);
        acceptedJobs.current.delete(observed.id);
      }
      if (parentEntry) {
        const [originalId, attempt] = parentEntry;
        attempt.observed = true;
        attempt.result = { kind: "accepted", jobId: observed.id };
        recoveries.current.delete(originalId);
        if (
          !terminal &&
          !terminalJobs.current.has(observed.id) &&
          !acceptedJobs.current.has(observed.id)
        ) {
          acceptedJobs.current.set(observed.id, {
            jobId: observed.id,
            originalId,
            attempt,
          });
        }
      }
      const need = RESUMABLE.has(observed.kind ?? "")
        ? modelNeededOfJob(observed)
        : null;
      if (!need) {
        if (terminal) {
          recoveries.current.delete(observed.id);
          if (parentEntry) attempts.current.delete(parentEntry[0]);
          if (observed.kind === "render_preview") previewRetried.current = null;
        }
        update((n) => n + 1);
        return;
      }
      const needKey = `${observed.id}:${modelKey(need)}`;
      if (seen.current.has(needKey)) return;
      seen.current.add(needKey);
      const preview = previewRetried.current;
      if (
        (preview?.model === modelKey(need) &&
          preview.epoch === scope.epoch &&
          preview.path === scope.path) ||
        (parent?.epoch === scope.epoch &&
          parent.path === scope.path &&
          parent.models.includes(modelKey(need)))
      ) {
        previewRetried.current = null;
        store.announceStatus(notDownloadedLine(need), { tone: "error" });
        update((n) => n + 1);
        return;
      }
      put(observed.id, {
        kind: "waiting",
        wait: {
          ...need,
          origin: { job: observed, path: scope.path, epoch: scope.epoch },
          tried: parent?.models ?? [],
        },
      });
    },
    [put],
  );

  function resume(wait: ModelWait) {
    const last = wait.origin;
    const current = useDawStore.getState();
    if (
      guestShare ||
      current.projectEpoch !== last.epoch ||
      current.projectPath !== last.path
    )
      return;
    if (recoveries.current.get(last.job.id)?.kind === "pending") return;
    const key = modelKey(wait);
    if (last.job.kind === "render_preview") {
      put(last.job.id, null);
      previewRetried.current = {
        model: key,
        epoch: last.epoch,
        path: last.path,
      };
      runPointerCommand("render.refreshMix");
      return;
    }
    const attempt: Attempt = {
      models: [...wait.tried, key],
      result: { kind: "pending" },
      epoch: last.epoch,
      path: last.path,
      observed: false,
    };
    attempts.current.set(last.job.id, attempt);
    put(last.job.id, { kind: "pending", wait });
    void retryPipelineJob(last.path, last.job.id).then(
      (successor) => {
        const store = useDawStore.getState();
        if (
          !mounted.current ||
          store.projectEpoch !== last.epoch ||
          store.projectPath !== last.path
        ) {
          retiredJobs.current.add(last.job.id);
          retiredJobs.current.add(successor.id);
          return;
        }
        if (attempts.current.get(last.job.id) !== attempt) return;
        if (terminalJobs.current.has(successor.id)) return;
        observe(successor, attempt, {
          jobId: successor.id,
          originalId: last.job.id,
          attempt,
        });
        if (store.activityJob?.id === last.job.id)
          store.setActivityJob(successor);
      },
      (error: unknown) => {
        const store = useDawStore.getState();
        if (
          !mounted.current ||
          store.projectEpoch !== last.epoch ||
          store.projectPath !== last.path
        )
          return;
        if (attempt.observed || attempts.current.get(last.job.id) !== attempt)
          return;
        const refusedBeforeAdmission =
          isModelNeeded(error) ||
          (error instanceof ApiError &&
            (error.code === "pipeline_busy" ||
              error.code === "pipeline_retry_stale" ||
              error.code === "pipeline_retry_unavailable"));
        if (refusedBeforeAdmission) {
          if (attempts.current.get(last.job.id) === attempt)
            attempts.current.delete(last.job.id);
        } else {
          attempt.result = { kind: "uncertain" };
        }
        if (isModelNeeded(error)) {
          if (attempt.models.includes(modelKey(error.model))) {
            put(last.job.id, null);
            store.announceStatus(notDownloadedLine(error.model), {
              tone: "error",
            });
          } else {
            put(last.job.id, {
              kind: "waiting",
              wait: { ...error.model, origin: last, tried: attempt.models },
            });
          }
          return;
        }
        const message = errorMessage(error, "The run could not resume.");
        if (
          error instanceof ApiError &&
          (error.code === "pipeline_retry_stale" ||
            error.code === "pipeline_retry_unavailable")
        ) {
          put(last.job.id, null);
          store.announceStatus(message, { tone: "error" });
          return;
        }
        store.announceStatus(message, { tone: "error", toast: false });
        put(last.job.id, { kind: "refused", wait, message });
      },
    );
  }

  const { stop, stopFor, clear } = useModelResume<ModelWait>(resume);
  useEffect(() => {
    if (identity.current.path !== path || identity.current.epoch !== epoch) {
      const previous = identity.current;
      if (previous.job?.project_path === previous.path)
        retiredJobs.current.add(previous.job.id);
      for (const id of recoveries.current.keys()) retiredJobs.current.add(id);
      for (const [id, attempt] of attempts.current) {
        retiredJobs.current.add(id);
        if (attempt.result.kind === "accepted")
          retiredJobs.current.add(attempt.result.jobId);
      }
      for (const id of terminalJobs.current) retiredJobs.current.add(id);
      attempts.current.clear();
      recoveries.current.clear();
      seen.current.clear();
      acceptedJobs.current.clear();
      terminalJobs.current.clear();
      previewRetried.current = null;
      clear();
      update((n) => n + 1);
    }
    identity.current = { path, epoch, job };
  }, [path, epoch, job, clear]);

  const need = useMemo(
    () =>
      guestShare ||
      !job ||
      !RESUMABLE.has(job.kind ?? "") ||
      (job.project_path && job.project_path !== path)
        ? null
        : modelNeededOfJob(job),
    [guestShare, job, path],
  );
  useEffect(() => {
    if (!guestShare && job) observe(job, { path, epoch });
  }, [job, path, epoch, guestShare, observe]);

  useEffect(() => {
    if (guestShare || !pipelineJob || pipelineJob.id === job?.id) return;
    const linked =
      (pipelineJob.retry_of &&
        (attempts.current.has(pipelineJob.retry_of) ||
          retiredJobs.current.has(pipelineJob.retry_of))) ||
      acceptedJobs.current.has(pipelineJob.id) ||
      retiredJobs.current.has(pipelineJob.id);
    if (linked) observe(pipelineJob, { path, epoch });
  }, [pipelineJob, job, path, epoch, guestShare, observe]);

  const selected =
    (job && need ? recoveries.current.get(job.id) : undefined) ??
    [...recoveries.current.values()].find((entry) => entry.kind !== "pending");
  const selectedWait = selected?.kind === "waiting" ? selected.wait : null;
  useEffect(() => {
    if (selectedWait) stopFor(selectedWait);
    else clear();
  }, [selectedWait, stopFor, clear]);

  if (guestShare) return null;
  return (
    <>
      {[...acceptedJobs.current.values()]
        .filter(
          (entry) =>
            entry.attempt.path === path && entry.attempt.epoch === epoch,
        )
        .map((accepted) => (
          <AcceptedJobObserver
            key={accepted.jobId}
            accepted={accepted}
            observe={observe}
          />
        ))}
      {selected?.kind === "refused" ? (
        <RefusedRunAlert
          message={selected.message}
          onTryAgain={() => resume(selected.wait)}
        />
      ) : stop && stop === selectedWait ? (
        <div className="guest-banner" role="status">
          <ModelNeedRow model={stop} />
        </div>
      ) : null}
    </>
  );
}
