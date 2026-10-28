import { jobMediaKey } from "../../state/jobMedia";

/**
 * Whether the job in view was started on the audio the tracks hold now. A run
 * that finished on this audio has covered every source, even one with nothing
 * to transcribe (silence, every word deleted, no media), so it still reads
 * done. A job started elsewhere (reload, another tab) or on other audio does
 * not.
 */
export function useJobCoverage(
  jobId: string | null,
  mediaKey: string,
): boolean {
  if (jobId === null) return false;
  const started = jobMediaKey(jobId);
  return started !== undefined && started === mediaKey;
}
