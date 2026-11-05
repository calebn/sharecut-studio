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

/** Export and Bounce keep their own Model need row on Deliver, which resumes them. */
const OWNED_BY_DELIVER = new Set(["export", "bounce"]);

const TRY_AGAIN: Record<string, string> = {
  split_speakers: "Split again.",
};

type Stopped = { job: PipelineJobSnapshot; epoch: number };

async function resumeJob({ job, epoch }: Stopped, label: string) {
  const store = useDawStore.getState();
  if (store.projectEpoch !== epoch) {
    return;
  }
  if (job.kind === "render_preview") {
    runPointerCommand("render.refreshMix");
    return;
  }
  if (job.kind === "pipeline") {
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
    return;
  }
  store.announceStatus(
    `${label} downloaded. ${TRY_AGAIN[job.kind ?? ""] ?? "Try again."}`,
  );
}

/**
 * Under the header while the latest job failed for a missing model: the Model need row, in place.
 * Get downloads it and the failed step runs again by itself when it lands. Guests never see it.
 */
export function JobModelBanner({ guestShare }: { guestShare: boolean }) {
  const job = useDaw((s) => s.activityJob);
  const need =
    guestShare || !job || OWNED_BY_DELIVER.has(job.kind ?? "")
      ? null
      : modelNeededOfJob(job);
  const needRef = useRef(need);
  needRef.current = need;
  const failed = useRef<Stopped | null>(null);
  const retried = useRef<string | null>(null);
  const { stop, stopFor, clear } = useModelResume((model) => {
    retried.current = model.id;
    if (failed.current) void resumeJob(failed.current, model.label);
  });
  const needKey = need && job ? `${job.id}:${need.id}:${need.variant}` : null;
  useEffect(() => {
    const model = needRef.current;
    if (needKey === null || !model) {
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
  }, [needKey, stopFor, clear]);
  if (!stop) {
    return null;
  }
  return (
    <div className="guest-banner" role="status">
      <ModelNeedRow model={stop} />
    </div>
  );
}
