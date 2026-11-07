import { useEffect, useRef } from "react";
import { retryPipelineJob } from "../../api";
import { runPointerCommand } from "../../commands/pointer";
import { ModelNeedRow, useModelResume } from "../../models";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import {
  errorMessage,
  modelNeededOfJob,
  notDownloadedLine,
} from "../../utils/apiError";

const RESUMABLE = new Set(["pipeline", "render_preview"]);

type Stopped = { job: PipelineJobSnapshot; epoch: number; path: string };
type Retried = { model: string; jobId: string | null };

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
  const failed = useRef<Stopped | null>(null);
  const retried = useRef<Retried | null>(null);
  const { stop, stopFor, clear } = useModelResume((model) => {
    const last = failed.current;
    if (!last) return;
    const current = useDawStore.getState();
    if (
      current.projectEpoch !== last.epoch ||
      current.projectPath !== last.path
    )
      return;
    const modelKey = `${model.id}:${model.variant}`;
    if (last.job.kind === "render_preview") {
      retried.current = { model: modelKey, jobId: null };
      runPointerCommand("render.refreshMix");
      return;
    }
    void retryPipelineJob(last.path, last.job.id).then(
      (successor) => {
        const store = useDawStore.getState();
        if (
          store.projectEpoch !== last.epoch ||
          store.projectPath !== last.path
        )
          return;
        retried.current = { model: modelKey, jobId: successor.id };
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
        store.announceStatus(errorMessage(error, "The run could not resume."), {
          tone: "error",
        });
      },
    );
  });
  const needKey = need && job ? `${job.id}:${need.id}:${need.variant}` : null;
  useEffect(() => {
    const model = needRef.current;
    if (needKey === null || !model) {
      if (retryFinished) retried.current = null;
      clear();
      return;
    }
    if (
      retried.current?.model === `${model.id}:${model.variant}` &&
      (retried.current.jobId === null || retried.current.jobId === job?.id)
    ) {
      retried.current = null;
      useDawStore
        .getState()
        .announceStatus(notDownloadedLine(model), { tone: "error" });
      clear();
      return;
    }
    failed.current = {
      job: useDawStore.getState().activityJob as PipelineJobSnapshot,
      epoch: useDawStore.getState().projectEpoch,
      path: useDawStore.getState().projectPath,
    };
    stopFor(model);
  }, [needKey, retryFinished, stopFor, clear]);
  if (!stop) {
    return null;
  }
  return (
    <div className="guest-banner" role="status">
      <ModelNeedRow model={stop} />
    </div>
  );
}
