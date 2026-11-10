import { shareProjectKey } from "../shareMode";
import { apiFetch } from "./http";

const settled = new Map<string, readonly number[]>();
const inFlight = new Map<string, Promise<readonly number[]>>();

function isPeakList(body: unknown): body is number[] {
  return (
    Array.isArray(body) &&
    body.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

async function fetchPeaks(
  token: string,
  versionId: string,
): Promise<number[] | null> {
  try {
    const res = await apiFetch(shareProjectKey(token), {
      guest: `/peaks?version_id=${encodeURIComponent(versionId)}`,
    });
    const body: unknown = await res.json();
    return isPeakList(body) ? body : null;
  } catch {
    // A link that may not play (403), a busy host or a bad body: no waveform.
    return null;
  }
}

/**
 * The episode's loudness envelope (0..1 columns) for a review link's overview
 * strip, asked for the same version it is remembered under. Fetched once per
 * share and version once it has columns; empty when the link may not play, the
 * host has no local copy, the mix is silent or the read failed. An empty answer
 * is never remembered, so the next ask tries again.
 */
export function loadReviewPeaks(
  token: string,
  versionId: string,
): Promise<readonly number[]> {
  const key = `${token}\u0000${versionId}`;
  const done = settled.get(key);
  if (done) return Promise.resolve(done);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchPeaks(token, versionId)
    .then((peaks) => {
      if (peaks && peaks.length > 0) settled.set(key, peaks);
      return peaks ?? [];
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function clearReviewPeaksCache(): void {
  settled.clear();
  inFlight.clear();
}
