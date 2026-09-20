import type { PipelineJobSnapshot } from "../types/pipeline";
import { isPipelineKindJob } from "../utils/pipeline";
import { useDawStore } from "./dawStore";

/** Seed chrome immediately from a start-job snapshot (pipeline vs Activity). */
export function seedStudioJob(job: PipelineJobSnapshot): void {
  const s = useDawStore.getState();
  s.setActivityJob(job);
  s.setPipelineJob(isPipelineKindJob(job) ? job : null);
}
