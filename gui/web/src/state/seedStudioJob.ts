import type { PipelineJobSnapshot } from "../types/pipeline";
import { isPipelineKindJob } from "../utils/pipeline";
import { useDawStore } from "./dawStore";
import { currentMediaKey, recordJobMedia } from "./jobMedia";

/** Seed chrome immediately from a start-job snapshot (pipeline vs Activity). */
export function seedStudioJob(job: PipelineJobSnapshot): void {
  if (
    isPipelineKindJob(job) &&
    (job.only_step ?? "transcribe_tracks") === "transcribe_tracks"
  ) {
    recordJobMedia(job.id, currentMediaKey());
  }
  const s = useDawStore.getState();
  s.setActivityJob(job);
  s.setPipelineJob(isPipelineKindJob(job) ? job : null);
}
