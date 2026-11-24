import { withSessionTokenQuery } from "../sessionAuth";
import { apiFetch, HOST_KEY } from "./http";

export type SegmentKind = "intro" | "outro" | "sponsor" | "sting" | "other";

export interface SegmentClipRow {
  audio: string;
  offset_sec: number;
  duration_sec: number;
  [key: string]: unknown;
}

/** One library segment: its newest version and every version number. */
export interface SegmentRow {
  id: string;
  name: string;
  kind: SegmentKind;
  version: number;
  versions: number[];
  clips: SegmentClipRow[];
  [key: string]: unknown;
}

/** A segment whose newest version could not be read; listed rather than hidden. */
export interface DamagedSegmentRow {
  id: string;
  version: number;
  damaged: true;
  problem: string;
  code: string;
}

export type SegmentListRow = SegmentRow | DamagedSegmentRow;

export interface SegmentSaveRequest {
  path: string;
  name: string;
  kind?: SegmentKind | null;
  clip_ids?: string[] | null;
  /** A timeline range such as `0:00-0:22`. */
  time_range?: string | null;
  role?: string | null;
}

export interface SegmentSaveResult {
  status: "added" | "new_version" | "unchanged";
  id: string;
  version: number;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function isDamagedSegment(
  row: SegmentListRow,
): row is DamagedSegmentRow {
  return "damaged" in row && row.damaged === true;
}

export async function loadSegments(
  signal?: AbortSignal,
): Promise<SegmentListRow[]> {
  const res = await apiFetch(HOST_KEY, { host: "/api/segments" }, { signal });
  return (await res.json()) as SegmentListRow[];
}

export async function loadSegment(
  id: string,
  signal?: AbortSignal,
): Promise<SegmentRow> {
  const res = await apiFetch(
    HOST_KEY,
    { host: `/api/segments/${encodeURIComponent(id)}` },
    { signal },
  );
  return (await res.json()) as SegmentRow;
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
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch(
    HOST_KEY,
    { host: `/api/segments/${encodeURIComponent(id)}` },
    { method: "DELETE", signal },
  );
}

/** The audio of one clip (the whole file; Studio previews one clip at a time). */
export function segmentAudioUrl(
  id: string,
  clip = 0,
  version?: number,
): string {
  const params = new URLSearchParams({ clip: String(clip) });
  if (version !== undefined) params.set("version", String(version));
  return withSessionTokenQuery(
    `/api/segments/${encodeURIComponent(id)}/audio?${params.toString()}`,
  );
}
