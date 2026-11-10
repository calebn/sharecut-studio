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

async function fetchPeaks(token: string): Promise<number[] | null> {
  try {
    const res = await apiFetch(shareProjectKey(token), { guest: "/peaks" });
    const body: unknown = await res.json();
    return isPeakList(body) ? body : null;
  } catch {
    // A link that may not play (403), a busy host or a bad body: no waveform.
    return null;
  }
}

/**
 * The episode's loudness envelope (0..1 columns) for a review link's overview
 * strip. Fetched once per share and version; empty when the link may not play,
 * the host has no local copy, or the read failed (a failure is not remembered).
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
  const request = fetchPeaks(token)
    .then((peaks) => {
      if (peaks) settled.set(key, peaks);
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
