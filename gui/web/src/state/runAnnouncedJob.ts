import { followJobToOk, JobCancelledError } from "../api";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { errorMessage } from "../utils/apiError";
import { joinSentences } from "../utils/format";
import { lateCancelCopy } from "../utils/pipeline";
import { plainError } from "../utils/plainError";
import { useDawStore } from "./dawStore";
import { seedStudioJob } from "./seedStudioJob";
import type { AnnouncedJobKind, JobResultOwner, ToastAction } from "./types";

export async function runAnnouncedJob(
  start: () => Promise<PipelineJobSnapshot>,
  opts: {
    kind: AnnouncedJobKind;
    failLabel: string;
    summarizeResult: (
      job: PipelineJobSnapshot,
    ) => { copy: string; action?: ToastAction } | null;
    signal?: AbortSignal;
    onStart?: (job: PipelineJobSnapshot) => void;
  },
): Promise<PipelineJobSnapshot> {
  const s = useDawStore.getState();
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const token = s.beginJobResultStart(opts.kind);
  let owner: JobResultOwner | undefined;
  const isCurrent = () => {
    const current = useDawStore.getState();
    if (opts.signal?.aborted || token.projectEpoch !== current.projectEpoch)
      return false;
    if (!owner) return current.jobResultStarts.has(token);
    const record = current.jobFeedback.get(owner.jobId);
    return record?.kind === "following" && record.owner === owner;
  };
  const assertCurrent = () => {
    if (!isCurrent()) throw new DOMException("Aborted", "AbortError");
  };
  const release = () => s.releaseJobResultStart(token, owner);
  opts.signal?.addEventListener("abort", release, { once: true });
  try {
    assertCurrent();
    const job = await start();
    assertCurrent();
    owner = { start: token, jobId: job.id };
    if (!s.bindJobResultStart(owner))
      throw new DOMException("Aborted", "AbortError");
    assertCurrent();
    seedStudioJob(job);
    assertCurrent();
    opts.onStart?.(job);
    assertCurrent();
    const { done, cancellation } = await followJobToOk(job.id, opts.failLabel, {
      signal: opts.signal,
    }).then(
      (done) => ({ done, cancellation: null }),
      (err: unknown) => {
        if (err instanceof JobCancelledError) {
          return { done: err.job, cancellation: err };
        }
        throw err;
      },
    );
    if (cancellation && !isCurrent()) throw cancellation;
    assertCurrent();

    let summary: { copy: string; action?: ToastAction } | null;
    try {
      summary = opts.summarizeResult(done);
      if (!summary && !cancellation) throw new Error(opts.failLabel);
    } catch (error) {
      assertCurrent();
      s.finishJobResult(owner, {
        kind: "failure",
        copy: plainError(joinSentences([opts.failLabel, errorMessage(error)])),
      });
      throw error;
    }
    assertCurrent();
    s.finishJobResult(
      owner,
      summary
        ? {
            kind: "verified",
            copy: cancellation ? lateCancelCopy(summary.copy) : summary.copy,
            ...(summary.action ? { action: summary.action } : {}),
          }
        : { kind: "cancelled-empty" },
    );
    if (cancellation) throw cancellation;
    return done;
  } finally {
    opts.signal?.removeEventListener("abort", release);
    release();
  }
}
