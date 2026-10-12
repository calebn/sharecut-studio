import { hostFetch } from "../api/documentTransport";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { readApiError } from "../utils/apiError";

export type SplitSpeakersRequest = {
  trackId: string;
  speakerCount: number;
  /** One name per speaker, or null to let the server number them. */
  names: string[] | null;
};

export async function startSplitSpeakersJob(
  projectPath: string,
  request: SplitSpeakersRequest,
): Promise<PipelineJobSnapshot> {
  const res = await hostFetch("/api/speaker/split", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: projectPath,
      track_id: request.trackId,
      speaker_count: request.speakerCount,
      names: request.names,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}
