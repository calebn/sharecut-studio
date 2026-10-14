import { hostFetch } from "../api/documentTransport";
import { readApiFailure } from "../utils/apiError";

export type MoveSpeakerLaneSpanRequest = {
  fromLane: string;
  toLane: string;
  timelineStart: number;
  timelineEnd: number;
};

export type MoveSpeakerLaneSpanResult = {
  from_lane: string;
  to_lane: string;
  source_start: number;
  source_end: number;
  words_moved: number;
  history_head_id: string;
};

export async function moveSpeakerLaneSpan(
  projectPath: string,
  request: MoveSpeakerLaneSpanRequest,
): Promise<MoveSpeakerLaneSpanResult> {
  const res = await hostFetch("/api/speaker/move-lane-span", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: projectPath,
      from_lane: request.fromLane,
      to_lane: request.toLane,
      timeline_start: request.timelineStart,
      timeline_end: request.timelineEnd,
    }),
  });
  if (!res.ok) throw await readApiFailure(res);
  return (await res.json()) as MoveSpeakerLaneSpanResult;
}
