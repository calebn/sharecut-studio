import type { PipelineJobSnapshot } from "../types/pipeline";
import { apiFetch } from "./http";

export type SplitSpeakersRequest = {
  trackId: string;
  speakerCount: number;
  /** One name per speaker, or null to let the server number them. */
  names: string[] | null;
  /** Each named speaker's voice sample in recording seconds, or null for none. */
  enrollment: Record<string, Array<[number, number]>> | null;
};

export async function startSplitSpeakersJob(
  projectPath: string,
  request: SplitSpeakersRequest,
): Promise<PipelineJobSnapshot> {
  const res = await apiFetch(
    "",
    { host: "/api/speaker/split" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        track_id: request.trackId,
        speaker_count: request.speakerCount,
        names: request.names,
        enrollment: request.enrollment,
      }),
    },
  );
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}
