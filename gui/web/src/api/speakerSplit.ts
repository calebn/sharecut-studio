import { hostFetch } from "../api/documentTransport";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { readApiFailure } from "../utils/apiError";

export type SpeakerDoctorReport = {
  available_backends: string[];
  recommended: string | null;
};

/** Reports importable backends on the host; it does not check model downloads. */
export async function getSpeakerDoctor(): Promise<SpeakerDoctorReport> {
  const res = await hostFetch("/api/speaker/doctor");
  if (!res.ok) throw await readApiFailure(res);
  return (await res.json()) as SpeakerDoctorReport;
}

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
  if (!res.ok) throw await readApiFailure(res);
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}
