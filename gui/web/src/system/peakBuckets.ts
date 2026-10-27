/**
 * Folds `peaks` into at most `limit` values, each the loudest of the run it
 * replaces, so a strip never draws more bars than it has pixels. A strip that
 * already fits comes back as it is.
 */
export function bucketPeaks(
  peaks: readonly number[],
  limit: number,
): readonly number[] {
  const buckets = Math.max(1, Math.floor(limit));
  if (peaks.length <= buckets) return peaks;
  const folded: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const from = Math.floor((bucket * peaks.length) / buckets);
    const to = Math.floor(((bucket + 1) * peaks.length) / buckets);
    let loudest = 0;
    for (let index = from; index < to; index++) {
      loudest = Math.max(loudest, peaks[index]);
    }
    folded.push(loudest);
  }
  return folded;
}
