import type { PipelineJobSnapshot } from "../types/pipeline";
import { isPipelineKindJob } from "../utils/pipeline";
import { useDawStore } from "./dawStore";
import {
  currentMediaKey,
  recordJobMedia,
  runIncludesTranscribe,
} from "./jobMedia";

/** Seed chrome immediately from a start-job snapshot (pipeline vs Activity). */
export function seedStudioJob(job: PipelineJobSnapshot): void {
  if (
    isPipelineKindJob(job) &&
    runIncludesTranscribe({ fromStep: job.from_step, onlyStep: job.only_step })
  ) {
    recordJobMedia(job.id, currentMediaKey());
  }
  const s = useDawStore.getState();
  s.setActivityJob(job);
  s.setPipelineJob(isPipelineKindJob(job) ? job : null);
}
