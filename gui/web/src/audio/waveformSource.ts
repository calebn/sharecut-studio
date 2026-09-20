import { audioUrl } from "../api";
import { isShareProjectKey } from "../shareMode";
import { TILE_SEC } from "../utils/timelineZoom.generated";
import { getActiveProxyEngine } from "./proxyPeek";
import { extractPeaksOffThread } from "./waveformWorker";
import {
  byteRangeForTime,
  isPcmWavPath,
  parseWavHeader,
  type WavHeader,
  wavPcmToFloat32,
} from "./wavHeader";

export type WaveformKind = "raw" | "stem";

export type DetailFetchRequest = {
  projectPath: string;
  trackId: string;
  kind: WaveformKind;
  mediaPath: string | null;
  mediaVersion: string;
  startSec: number;
  endSec: number;
  binsPerSec: number;
  signal: AbortSignal;
};

export const DETAIL_FETCH_MAX_SEC = TILE_SEC * 4;

const headerCache = new Map<string, WavHeader>();

export function clearWavHeaderCache(): void {
  headerCache.clear();
}

export function headerCacheKey(
  projectPath: string,
  trackId: string,
  kind: string,
  mediaVersion: string,
): string {
  return `${projectPath}|${trackId}|${kind}|${mediaVersion}`;
}

async function fetchRange(
  url: string,
  start: number,
  endExclusive: number,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  const res = await fetch(url, {
    signal,
    headers: { Range: `bytes=${start}-${endExclusive - 1}` },
  });
  if (res.status === 206) {
    return res.arrayBuffer();
  }
  if (res.status === 200) {
    const len = Number(res.headers.get("content-length") || 0);
    if (len > 0 && len <= endExclusive - start + 64) {
      return res.arrayBuffer();
    }
    await res.body?.cancel();
    return null;
  }
  return null;
}

async function loadWavHeader(
  url: string,
  cacheKey: string,
  signal: AbortSignal,
): Promise<WavHeader | null> {
  const hit = headerCache.get(cacheKey);
  if (hit) {
    return hit;
  }
  const buf = await fetchRange(url, 0, 4096, signal);
  if (!buf) {
    return null;
  }
  try {
    const header = parseWavHeader(buf);
    headerCache.set(cacheKey, header);
    return header;
  } catch {
    return null;
  }
}

async function peaksFromWavRange(
  url: string,
  header: WavHeader,
  startSec: number,
  endSec: number,
  binsPerSec: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const { start, endExclusive } = byteRangeForTime(header, startSec, endSec);
  if (endExclusive <= start) {
    return new Uint8Array(0);
  }
  const bytes = await fetchRange(url, start, endExclusive, signal);
  if (!bytes) {
    return null;
  }
  const pcm = wavPcmToFloat32(bytes, header);
  return extractPeaksOffThread(
    pcm,
    header.sampleRate,
    binsPerSec,
    startSec,
    signal,
  );
}

async function peaksFromWindowedPcm(
  req: DetailFetchRequest,
): Promise<Uint8Array | null> {
  const url = audioUrl(req.projectPath, req.kind, req.trackId, {
    startSec: req.startSec,
    endSec: req.endSec,
  });
  const res = await fetch(url, { signal: req.signal });
  if (!res.ok) {
    return null;
  }
  const buf = await res.arrayBuffer();
  try {
    const header = parseWavHeader(buf);
    const pcm = wavPcmToFloat32(buf.slice(header.dataOffset), header);
    return extractPeaksOffThread(
      pcm,
      header.sampleRate,
      req.binsPerSec,
      req.startSec,
      req.signal,
    );
  } catch {
    return null;
  }
}

export async function fetchDetailPeaks(
  req: DetailFetchRequest,
): Promise<Uint8Array | null> {
  if (req.signal.aborted) {
    return null;
  }
  const duration = Math.max(0, req.endSec - req.startSec);
  if (duration > DETAIL_FETCH_MAX_SEC + 0.01) {
    req = { ...req, endSec: req.startSec + DETAIL_FETCH_MAX_SEC };
  }
  const proxy = getActiveProxyEngine();
  if (proxy) {
    const peeked = proxy.copyCachedPcmWindow(
      req.trackId,
      req.startSec,
      req.endSec,
    );
    if (peeked) {
      return extractPeaksOffThread(
        peeked.pcm,
        peeked.sampleRate,
        req.binsPerSec,
        req.startSec,
        req.signal,
      );
    }
  }
  if (isShareProjectKey(req.projectPath)) {
    return null;
  }
  const url = audioUrl(req.projectPath, req.kind, req.trackId);
  const hk = headerCacheKey(
    req.projectPath,
    req.trackId,
    req.kind,
    req.mediaVersion,
  );
  if (req.kind === "raw" && isPcmWavPath(req.mediaPath)) {
    const header = await loadWavHeader(url, hk, req.signal);
    if (header) {
      const peaks = await peaksFromWavRange(
        url,
        header,
        req.startSec,
        req.endSec,
        req.binsPerSec,
        req.signal,
      );
      if (peaks) {
        return peaks;
      }
    }
  }
  if (req.kind === "stem") {
    const header = await loadWavHeader(url, hk, req.signal);
    if (header) {
      const peaks = await peaksFromWavRange(
        url,
        header,
        req.startSec,
        req.endSec,
        req.binsPerSec,
        req.signal,
      );
      if (peaks) {
        return peaks;
      }
    }
  }
  return peaksFromWindowedPcm(req);
}

export { extractPeaksOffThread };
