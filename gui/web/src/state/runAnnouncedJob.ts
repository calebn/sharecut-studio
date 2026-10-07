import { followJobToOk, JobCancelledError } from "../api";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { jobResultPaths, lateCancelCopy } from "../utils/pipeline";
import { useDawStore } from "./dawStore";
import { seedStudioJob } from "./seedStudioJob";

/**
 * Start a job that reports its own result copy (Bounce, Export deliverables),
 * seed it onto the Activity chip, follow it to a terminal status, and hand the
 * copy to `useJobStatusAnnouncement` (#704). The job is registered with
 * `expectJobResult` before the chip sees it, so the generic "ok" headline
 * never races the copy. `onStart` receives the started job (for Cancel and
 * live progress). Resolves with the `ok` snapshot. A failure, a cancel
 * (`JobCancelledError`) or an abort settles that registration and rethrows for
 * the caller; a cancel that came after the job wrote its files announces them
 * as a late cancel instead. An abort only stops this client following the job. The server job
 * is not cancelled: it keeps running, may still write files to `export/`, and its
 * result is never announced. An abort that lands while `start()` runs throws
 * before anything is registered or seeded.
 */
export async function runAnnouncedJob(
  start: () => Promise<PipelineJobSnapshot>,
  opts: {
    failLabel: string;
    resultCopy: (paths: string[]) => string;
    signal?: AbortSignal;
    onStart?: (job: PipelineJobSnapshot) => void;
  },
): Promise<PipelineJobSnapshot> {
  const job = await start();
  // A project switch (or dialog close) while the start POST was in flight: the
  // server job keeps running, but do not put it on the chip that now belongs to
  // another project.
  if (opts.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const s = useDawStore.getState();
  s.expectJobResult(job.id);
  seedStudioJob(job);
  opts.onStart?.(job);
  try {
    const done = await followJobToOk(job.id, opts.failLabel, {
      signal: opts.signal,
    });
    s.announceJobResult(job.id, opts.resultCopy(jobResultPaths(done)));
    return done;
  } catch (err) {
    const written =
      err instanceof JobCancelledError ? jobResultPaths(err.job) : [];
    if (written.length) {
      s.announceJobResult(job.id, lateCancelCopy(opts.resultCopy(written)));
    } else {
      s.settleJobResult(job.id);
    }
    throw err;
  }
}
