import { useEffect, useRef } from "react";
import { startPipelineRun } from "../../api";
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

type Stopped = { job: PipelineJobSnapshot; epoch: number };

async function resumeJob({ job, epoch }: Stopped) {
  const store = useDawStore.getState();
  if (store.projectEpoch !== epoch) {
    return;
  }
  if (job.kind === "render_preview") {
    runPointerCommand("render.refreshMix");
    return;
  }
  try {
    const started = await startPipelineRun(job.project_path, {
      fromStep: job.from_step ?? undefined,
      onlyStep: job.only_step ?? undefined,
      skipSteps: job.skip_steps,
      unattended: job.unattended,
    });
    if (useDawStore.getState().projectEpoch === epoch) {
      useDawStore.getState().setPipelineJob(started);
    }
  } catch (error) {
    store.announceStatus(errorMessage(error), { tone: "error" });
  }
}

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
  const retried = useRef<string | null>(null);
  const { stop, stopFor, clear } = useModelResume((model) => {
    retried.current = model.id;
    if (failed.current) void resumeJob(failed.current);
  });
  const needKey = need && job ? `${job.id}:${need.id}:${need.variant}` : null;
  useEffect(() => {
    const model = needRef.current;
    if (needKey === null || !model) {
      if (retryFinished) retried.current = null;
      clear();
      return;
    }
    if (retried.current === model.id) {
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
