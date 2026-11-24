import { withSessionTokenQuery } from "../sessionAuth";
import { apiFetch, HOST_KEY } from "./http";

/** The segment library (#1777). Per user, on the host's machine: a share guest never reaches it. */
export type SegmentKind = "intro" | "outro" | "sponsor" | "sting" | "other";

export type SegmentClip = {
  audio: string;
  offset_sec: number;
  duration_sec: number;
  fade_in_ms: number;
  fade_out_ms: number;
  join_in_mode: string;
  lane: number;
};

export type Segment = {
  id: string;
  name: string;
  kind: SegmentKind;
  version: number;
  versions: number[];
  role: string;
  fader_db: number;
  duck_under_dialogue: boolean;
  chapter_title: string | null;
  clips: SegmentClip[];
};

/** A segment whose newest version cannot be read. It is listed, never hidden. */
export type DamagedSegment = {
  id: string;
  version: number | null;
  damaged: true;
  problem: string;
  code: string;
};

export type SegmentRow = Segment | DamagedSegment;

export type SegmentSaveStatus = "added" | "new_version" | "unchanged";

export type SegmentSaveResult = {
  status: SegmentSaveStatus;
  id: string;
  version: number;
};

/** Clips or a time range of the episode, never both. `time_range` reads like `0:00-0:22`. */
export type SegmentSaveRequest = {
  path: string;
  name: string;
  kind?: SegmentKind;
  clip_ids?: string[];
  time_range?: string;
  role?: string;
};

const JSON_HEADERS = { "Content-Type": "application/json" };

export function isDamagedSegment(row: SegmentRow): row is DamagedSegment {
  return "damaged" in row && row.damaged === true;
}

export async function loadSegments(
  signal?: AbortSignal,
): Promise<SegmentRow[]> {
  const res = await apiFetch(HOST_KEY, { host: "/api/segments" }, { signal });
  return (await res.json()) as SegmentRow[];
}

export async function loadSegment(
  segmentId: string,
  signal?: AbortSignal,
): Promise<Segment> {
  const res = await apiFetch(
    HOST_KEY,
    { host: `/api/segments/${encodeURIComponent(segmentId)}` },
    { signal },
  );
  return (await res.json()) as Segment;
}

/** The URL an `<audio>` element plays for one clip of a segment (the newest version by default). */
export function segmentAudioUrl(
  segmentId: string,
  clip = 0,
  version?: number,
): string {
  const query = new URLSearchParams({ clip: String(clip) });
  if (version !== undefined) query.set("version", String(version));
  return withSessionTokenQuery(
    `/api/segments/${encodeURIComponent(segmentId)}/audio?${query}`,
  );
}

export async function saveSegment(
  request: SegmentSaveRequest,
  signal?: AbortSignal,
): Promise<SegmentSaveResult> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/segments" },
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
      signal,
    },
  );
  return (await res.json()) as SegmentSaveResult;
}

export async function removeSegment(
  segmentId: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch(
    HOST_KEY,
    { host: `/api/segments/${encodeURIComponent(segmentId)}` },
    { method: "DELETE", signal },
  );
}
