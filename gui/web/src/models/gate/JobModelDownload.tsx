import { useEffect } from "react";
import { runPointerCommand } from "../../commands/pointer";
import { useDawStore } from "../../state/dawStore";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { Button } from "../../ui";
import { modelNeededFromPayload } from "../../utils/apiError";
import { useModels } from "../useModels";
import { ModelGateDialog } from "./ModelGate";
import { useModelGate } from "./useModelGate";

const TRY_AGAIN: Record<string, string> = {
  pipeline: "Press Run again; From step skips the steps that finished.",
  export: "Export again.",
  bounce: "Bounce again.",
  split_speakers: "Split again.",
};

/**
 * Download beside a job that failed for a missing model. Only a refreshed mix
 * resumes by itself (the render is idempotent); every other kind says what to
 * press next. Inert without a models provider, so guests never see it.
 */
export function JobModelDownload({
  job,
  className,
}: {
  job: PipelineJobSnapshot | null;
  className?: string;
}) {
  const gate = useModelGate();
  const { models } = useModels();
  const need =
    job?.status === "error" && job.error_code === "model_needed"
      ? modelNeededFromPayload(job.error_model)
      : null;
  const jobId = job?.id;
  const resetGate = gate.reset;
  useEffect(() => {
    resetGate();
  }, [jobId, resetGate]);

  if (!need || !models) {
    return null;
  }
  const row = models.find((m) => m.id === need.id);
  const installed =
    row?.state.kind === "installed" &&
    (need.id !== "whisper" || !need.variant || row.variant === need.variant);
  if (installed && !gate.prompt) {
    return null;
  }
  const kind = job?.kind ?? "";

  async function download() {
    if (!need) return;
    const epoch = useDawStore.getState().projectEpoch;
    const ran = await gate.run(
      async () => true,
      [{ id: need.id, variant: need.variant ?? undefined, installed: false }],
    );
    if (ran.kind !== "ran") return;
    if (
      kind === "render_preview" &&
      useDawStore.getState().projectEpoch === epoch
    ) {
      runPointerCommand("render.refreshMix");
      return;
    }
    useDawStore
      .getState()
      .announceStatus(
        `${need.label} downloaded. ${TRY_AGAIN[kind] ?? "Try again."}`,
      );
  }

  return (
    <>
      <Button className={className} onClick={() => void download()}>
        Download {need.label}
      </Button>
      <ModelGateDialog gate={gate} />
    </>
  );
}
