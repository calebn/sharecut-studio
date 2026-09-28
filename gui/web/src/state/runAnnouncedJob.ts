import { followExportJob } from "../api";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { useDawStore } from "./dawStore";
import { seedStudioJob } from "./seedStudioJob";

/**
 * Start a job that reports its own result copy (Bounce, Export deliverables),
 * seed it onto the Activity chip, follow it to a terminal status, and hand the
 * copy to `useJobStatusAnnouncement` (#704). The job is registered with
 * `expectJobResult` before the chip sees it, so the generic "ok" headline
 * never races the copy. A failure or abort settles that registration and
 * rethrows for the caller.
 */
export async function runAnnouncedJob(
  start: () => Promise<PipelineJobSnapshot>,
  opts: {
    failLabel: string;
    resultCopy: (paths: string[]) => string;
    signal?: AbortSignal;
  },
): Promise<string[]> {
  const job = await start();
  const s = useDawStore.getState();
  s.expectJobResult(job.id);
  seedStudioJob(job);
  try {
    const paths = await followExportJob(job.id, opts.failLabel, {
      signal: opts.signal,
    });
    s.announceJobResult(job.id, opts.resultCopy(paths));
    return paths;
  } catch (err) {
    s.settleJobResult(job.id);
    throw err;
  }
}
