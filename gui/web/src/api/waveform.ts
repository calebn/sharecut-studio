import { hostFetch } from "../api/documentTransport";
import {
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import { ApiError } from "../utils/apiError";
import type { WaveformKind, WaveformStatus } from "../waveform/types";

export class WaveformFetchError extends ApiError {
  readonly retryAfterSec: number | null;

  constructor(status: number, retryAfterSec: number | null) {
    super(`Waveform request failed (${status})`, null, status);
    this.name = "WaveformFetchError";
    this.retryAfterSec = retryAfterSec;
  }
}

async function waveformResponse(res: Response): Promise<Response> {
  if (res.ok) {
    return res;
  }
  const retry = Number(res.headers.get("Retry-After"));
  throw new WaveformFetchError(
    res.status,
    Number.isFinite(retry) && retry >= 0 ? retry : null,
  );
}

/**
 * A waveform route: the review route (`sharePath` under the share's API
 * base) for a `share:` key, otherwise the host route. Throws
 * `WaveformFetchError` when not ok.
 */
async function waveformFetch(
  projectPath: string,
  hostPath: string,
  sharePath: string,
  signal?: AbortSignal,
): Promise<Response> {
  const res = isShareProjectKey(projectPath)
    ? await fetch(
        `${reviewApiBase(shareTokenFromKey(projectPath)!)}${sharePath}`,
        { signal },
      )
    : await hostFetch(hostPath, { signal });
  return waveformResponse(res);
}

/** Pyramid status of every listed media ref (`docs/waveform.md` § API). */
export async function loadWaveformStatus(
  projectPath: string,
  kind: WaveformKind,
  signal?: AbortSignal,
): Promise<WaveformStatus> {
  // Guests only get raw media.
  if (isShareProjectKey(projectPath) && kind !== "raw") {
    return { format_version: 1, media: {} };
  }
  const params = new URLSearchParams({ path: projectPath, kind });
  const res = await waveformFetch(
    projectPath,
    `/api/waveform/status?${params}`,
    "/daw/waveform/status",
    signal,
  );
  return res.json() as Promise<WaveformStatus>;
}

/** Concatenated bins of data tiles `[start, start + count)` of one level. */
export async function loadWaveformTiles(
  projectPath: string,
  req: {
    key: string;
    ref: string;
    level: number;
    start: number;
    count: number;
  },
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const params = new URLSearchParams({
    ref: req.ref,
    level: String(req.level),
    start: String(req.start),
    count: String(req.count),
  });
  const key = encodeURIComponent(req.key);
  const sharePath = `/daw/waveform/tiles/${key}?${params}`;
  params.set("path", projectPath);
  const res = await waveformFetch(
    projectPath,
    `/api/waveform/tiles/${key}?${params}`,
    sharePath,
    signal,
  );
  return res.arrayBuffer();
}

/**
 * Host deep zoom: int16 `(min, max)` pairs for one PCM block. There is no
 * guest route; raw samples never go to guests.
 */
export async function loadWaveformPcm(
  projectPath: string,
  req: { key: string; ref: string; block: number },
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (isShareProjectKey(projectPath)) {
    throw new WaveformFetchError(403, null);
  }
  const params = new URLSearchParams({
    path: projectPath,
    ref: req.ref,
    block: String(req.block),
  });
  const res = await hostFetch(
    `/api/waveform/pcm/${encodeURIComponent(req.key)}?${params}`,
    { signal },
  );
  return (await waveformResponse(res)).arrayBuffer();
}

export type WaveformSnapPayload = {
  track_id: string;
  start: number;
  end: number;
  timeline_mode: boolean;
  preview: Record<string, unknown> | null;
  islands: Array<{ start: number; end: number; midpoint: number }>;
  ticks: number[];
};

export async function loadWaveformSnap(
  projectPath: string,
  trackId: string,
  start: number,
  end: number,
  timeline = false,
  signal?: AbortSignal,
  focus?: number,
): Promise<WaveformSnapPayload | null> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const params = new URLSearchParams({
      track_id: trackId,
      start: String(start),
      end: String(end),
      timeline: timeline ? "true" : "false",
    });
    if (focus != null) {
      params.set("focus", String(focus));
    }
    const res = await fetch(
      `${reviewApiBase(token)}/daw/waveform-snap?${params.toString()}`,
      { signal },
    );
    if (!res.ok) {
      return null;
    }
    return res.json() as Promise<WaveformSnapPayload>;
  }
  const params = new URLSearchParams({
    path: projectPath,
    track_id: trackId,
    start: String(start),
    end: String(end),
    timeline: timeline ? "true" : "false",
  });
  if (focus != null) {
    params.set("focus", String(focus));
  }
  const res = await hostFetch(`/api/waveform-snap?${params.toString()}`, {
    signal,
  });
  if (!res.ok) {
    return null;
  }
  return res.json() as Promise<WaveformSnapPayload>;
}
