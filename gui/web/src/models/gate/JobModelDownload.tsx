import { useEffect, useRef, useState } from "react";
import { runPointerCommand } from "../../commands/pointer";
import { useDawStore } from "../../state/dawStore";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { Button } from "../../ui";
import { modelNeededOfJob } from "../../utils/apiError";
import { useModels } from "../useModels";
import { ModelGateDialog } from "./ModelGate";
import { rowInstalled, useModelGate } from "./useModelGate";

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
  variant,
}: {
  job: PipelineJobSnapshot | null;
  className?: string;
  variant?: "primary";
}) {
  const gate = useModelGate();
  const { models } = useModels();
  const need = job ? modelNeededOfJob(job) : null;
  const jobId = job?.id;
  const resetGate = gate.reset;
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const doneRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    resetGate();
    setDownloaded(null);
  }, [jobId, resetGate]);
  useEffect(() => {
    if (downloaded) doneRef.current?.focus();
  }, [downloaded]);

  const row = need ? (models?.find((m) => m.id === need.id) ?? null) : null;
  if (downloaded && !gate.prompt) {
    return (
      <span ref={doneRef} tabIndex={-1}>
        {downloaded} downloaded.
      </span>
    );
  }
  if (!need || !row) {
    return null;
  }
  if (
    rowInstalled(row, { id: need.id, variant: need.variant ?? undefined }) &&
    !gate.prompt
  ) {
    return null;
  }
  const kind = job?.kind ?? "";

  async function download() {
    if (!need) return;
    const epoch = useDawStore.getState().projectEpoch;
    const ran = await gate.run(
      async ({ afterDownload }) => afterDownload,
      [{ id: need.id, variant: need.variant ?? undefined, installed: false }],
    );
    if (ran.kind !== "ran" || !ran.value) return;
    setDownloaded(need.label);
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
      <Button
        variant={variant}
        className={className}
        onClick={() => void download()}
      >
        Download {need.label}
      </Button>
      <ModelGateDialog gate={gate} />
    </>
  );
}
