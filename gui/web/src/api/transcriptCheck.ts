import { isShareProjectKey } from "../shareMode";
import type { TranscriptCheckStatus } from "../types/project";
import { apiFetch, HOST_KEY } from "./http";

function requireHost(projectPath: string) {
  if (isShareProjectKey(projectPath))
    throw new Error("The transcript check is only available to the host.");
}

/** Read whether the transcript is checked, with the count of unsure words. */
export async function loadTranscriptCheck(
  projectPath: string,
): Promise<TranscriptCheckStatus> {
  requireHost(projectPath);
  const params = new URLSearchParams({ path: projectPath });
  const response = await apiFetch(HOST_KEY, {
    host: `/api/transcript/refine/status?${params}`,
  });
  return response.json() as Promise<TranscriptCheckStatus>;
}

/**
 * Mark the transcript checked for the host. Safe to repeat. "Cut anyway" is not
 * this: it keeps `waiveTranscriptRefine`, which records a waiver. With
 * `expectedFingerprint` the server refuses (409 `transcript_changed`) when the
 * transcript is no longer the one the host reviewed.
 */
export async function markTranscriptChecked(
  projectPath: string,
  notes?: string,
  expectedFingerprint?: string,
): Promise<TranscriptCheckStatus> {
  requireHost(projectPath);
  const response = await apiFetch(
    HOST_KEY,
    { host: "/api/transcript/refine/done" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        notes,
        expected_fingerprint: expectedFingerprint,
      }),
    },
  );
  return response.json() as Promise<TranscriptCheckStatus>;
}
