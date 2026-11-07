import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export function JobModelBanner({ guestShare }: { guestShare: boolean }) {
  const job = useDaw((s) => s.activityJob);
  const path = useDaw((s) => s.projectPath);
  const epoch = useDaw((s) => s.projectEpoch);
  const attempts = useRef(new Map<string, Attempt>());
  const recoveries = useRef(new Map<string, Recovery>());
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
          store.projectEpoch !== last.epoch ||
          store.projectPath !== last.path
        )
          return;
        attempt.result = { kind: "accepted", jobId: successor.id };
        if (recoveries.current.get(last.job.id)?.kind === "pending")
          put(last.job.id, null);
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
        if (attempt.observed || attempts.current.get(last.job.id) !== attempt) {
          store.announceStatus(
            errorMessage(error, "The run could not resume."),
            { tone: "error" },
          );
          return;
        }
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
      attempts.current.clear();
      recoveries.current.clear();
      seen.current.clear();
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
  const needKey = need && job ? `${job.id}:${modelKey(need)}` : null;
  useEffect(() => {
    if (!job) return;
    if (job.project_path && job.project_path !== path) return;
    if (retiredJobs.current.has(job.id)) return;
    const parent = job.retry_of
      ? attempts.current.get(job.retry_of)
      : [...attempts.current.values()].find(
          (entry) =>
            entry.result.kind === "accepted" && entry.result.jobId === job.id,
        );
    if (parent) {
      parent.observed = true;
      for (const [id, attempt] of attempts.current) {
        if (attempt === parent) recoveries.current.delete(id);
      }
    }
    if (!need || !needKey) {
      if (
        job.status === "ok" ||
        job.status === "cancelled" ||
        job.status === "error"
      ) {
        recoveries.current.delete(job.id);
        if (parent) {
          for (const [id, attempt] of attempts.current)
            if (attempt === parent) attempts.current.delete(id);
        }
        if (job.kind === "render_preview") previewRetried.current = null;
      }
      update((n) => n + 1);
      return;
    }
    if (seen.current.has(needKey)) return;
    seen.current.add(needKey);
    const preview = previewRetried.current;
    if (
      (preview?.model === modelKey(need) &&
        preview.epoch === epoch &&
        preview.path === path) ||
      (parent?.epoch === epoch &&
        parent.path === path &&
        parent.models.includes(modelKey(need)))
    ) {
      previewRetried.current = null;
      useDawStore
        .getState()
        .announceStatus(notDownloadedLine(need), { tone: "error" });
      update((n) => n + 1);
      return;
    }
    put(job.id, {
      kind: "waiting",
      wait: {
        ...need,
        origin: { job, epoch, path },
        tried: parent?.models ?? [],
      },
    });
  }, [needKey, job, need, path, epoch, guestShare, put]);

  const selected =
    (job && need ? recoveries.current.get(job.id) : undefined) ??
    [...recoveries.current.values()].find((entry) => entry.kind !== "pending");
  const selectedWait = selected?.kind === "waiting" ? selected.wait : null;
  useEffect(() => {
    if (selectedWait) stopFor(selectedWait);
    else clear();
  }, [selectedWait, stopFor, clear]);

  if (guestShare) return null;
  if (selected?.kind === "refused") {
    return (
      <div className="guest-banner">
        <StatusRow
          state="failed"
          title={selected.message}
          action={{
            label: "Try again",
            name: "Resume the stopped run",
            onAction: () => resume(selected.wait),
          }}
        />
      </div>
    );
  }
  if (!stop || stop !== selectedWait) return null;
  return (
    <div className="guest-banner" role="status">
      <ModelNeedRow model={stop} />
    </div>
  );
}
