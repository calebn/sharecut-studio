import { useEffect, useRef, useState } from "react";
import { retryPipelineJob } from "../../api";
import { runPointerCommand } from "../../commands/pointer";
import { ModelNeedRow, useModelResume } from "../../models";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { StatusRow } from "../../system/StatusRow";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import {
  ApiError,
  errorMessage,
  isModelNeeded,
  type ModelNeeded,
  modelNeededOfJob,
  notDownloadedLine,
} from "../../utils/apiError";

const RESUMABLE = new Set(["pipeline", "render_preview"]);
type Stopped = { job: PipelineJobSnapshot; epoch: number; path: string };
type ModelWait = ModelNeeded & { origin: Stopped; tried: readonly string[] };
type Attempt = {
  models: readonly string[];
  result:
    | { kind: "pending" }
    | { kind: "uncertain" }
    | { kind: "accepted"; jobId: string };
  epoch: number;
  path: string;
};
type Refused = { wait: ModelWait; message: string };

const modelKey = (model: ModelNeeded) => `${model.id}:${model.variant}`;

export function JobModelBanner({ guestShare }: { guestShare: boolean }) {
  const job = useDaw((s) => s.activityJob);
  const need =
    guestShare || !job || !RESUMABLE.has(job.kind ?? "")
      ? null
      : modelNeededOfJob(job);
  const retryFinished =
    !job ||
    job.status === "ok" ||
    job.status === "cancelled" ||
    (job.status === "error" && !need);
  const needRef = useRef(need);
  needRef.current = need;
  const attempts = useRef(new Map<string, Attempt>());
  const previewRetried = useRef<{
    model: string;
    epoch: number;
    path: string;
  } | null>(null);
  const [refused, setRefused] = useState<Refused | null>(null);

  function resume(wait: ModelWait) {
    const last = wait.origin;
    const current = useDawStore.getState();
    if (
      guestShare ||
      current.projectEpoch !== last.epoch ||
      current.projectPath !== last.path ||
      current.activityJob?.id !== last.job.id
    )
      return;
    setRefused(null);
    const key = modelKey(wait);
    if (last.job.kind === "render_preview") {
      previewRetried.current = {
        model: key,
        epoch: last.epoch,
        path: last.path,
      };
      runPointerCommand("render.refreshMix");
      return;
    }
    if (attempts.current.get(last.job.id)?.result.kind === "pending") return;
    const attempt: Attempt = {
      models: [...wait.tried, key],
      result: { kind: "pending" },
      epoch: last.epoch,
      path: last.path,
    };
    attempts.current.set(last.job.id, attempt);
    void retryPipelineJob(last.path, last.job.id).then(
      (successor) => {
        const store = useDawStore.getState();
        if (
          store.projectEpoch !== last.epoch ||
          store.projectPath !== last.path
        )
          return;
        attempt.result = { kind: "accepted", jobId: successor.id };
        if (store.activityJob?.id === last.job.id)
          store.setActivityJob(successor);
      },
      (error: unknown) => {
        const store = useDawStore.getState();
        if (
          store.projectEpoch !== last.epoch ||
          store.projectPath !== last.path
        )
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
        if (store.activityJob?.id !== last.job.id) return;
        if (isModelNeeded(error)) {
          if (attempt.models.includes(modelKey(error.model))) {
            store.announceStatus(notDownloadedLine(error.model), {
              tone: "error",
            });
          } else {
            stopFor({ ...error.model, origin: last, tried: attempt.models });
          }
          return;
        }
        const message = errorMessage(error, "The run could not resume.");
        if (
          error instanceof ApiError &&
          (error.code === "pipeline_retry_stale" ||
            error.code === "pipeline_retry_unavailable")
        ) {
          store.announceStatus(message, { tone: "error" });
          return;
        }
        store.announceStatus(message, { tone: "error", toast: false });
        setRefused({ wait, message });
      },
    );
  }

  const { stop, stopFor, clear } = useModelResume<ModelWait>(resume);
  const needKey = need && job ? `${job.id}:${need.id}:${need.variant}` : null;
  useEffect(() => {
    const model = needRef.current;
    setRefused(null);
    if (needKey === null || !model) {
      if (retryFinished) {
        previewRetried.current = null;
        for (const [id, attempt] of attempts.current) {
          if (
            (attempt.result.kind === "accepted" &&
              attempt.result.jobId === job?.id) ||
            id === job?.retry_of
          )
            attempts.current.delete(id);
        }
      }
      clear();
      return;
    }
    const attempt = job?.retry_of
      ? attempts.current.get(job.retry_of)
      : [...attempts.current.values()].find(
          (entry) =>
            entry.result.kind === "accepted" && entry.result.jobId === job?.id,
        );
    const current = useDawStore.getState();
    const preview = previewRetried.current;
    if (
      (preview?.model === modelKey(model) &&
        preview.epoch === current.projectEpoch &&
        preview.path === current.projectPath) ||
      (attempt?.epoch === current.projectEpoch &&
        attempt.path === current.projectPath &&
        attempt.models.includes(modelKey(model)))
    ) {
      previewRetried.current = null;
      useDawStore
        .getState()
        .announceStatus(notDownloadedLine(model), { tone: "error" });
      clear();
      return;
    }
    const store = useDawStore.getState();
    const active = store.activityJob;
    if (!active || active.id !== job?.id) {
      clear();
      return;
    }
    stopFor({
      ...model,
      origin: {
        job: active,
        epoch: store.projectEpoch,
        path: store.projectPath,
      },
      tried: [],
    });
  }, [needKey, retryFinished, job?.id, job?.retry_of, clear, stopFor]);
  if (guestShare) return null;
  if (refused) {
    return (
      <div className="guest-banner">
        <StatusRow
          state="failed"
          title={refused.message}
          action={{
            label: "Try again",
            name: "Resume the stopped run",
            onAction: () => resume(refused.wait),
          }}
        />
      </div>
    );
  }
  if (!stop) return null;
  return (
    <div className="guest-banner" role="status">
      <ModelNeedRow model={stop} />
    </div>
  );
}
