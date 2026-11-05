import { useEffect, useState } from "react";
import {
  loadWaveformStatus,
  loadWaveformTiles,
  WaveformFetchError,
} from "../../api";
import { isShareProjectKey } from "../../shareMode";
import { MAX_TILES_PER_REQUEST } from "../../utils/timelineZoom.generated";
import { levelTileCount } from "../../waveform/pyramidMath";
import { isReady, type ReadyEntry } from "../../waveform/types";
import { binPeaks, mixPeaks } from "./episodePeaks";

const NONE: readonly number[] = [];
const DEFAULT_RETRY_MS = 3000;

type PeaksOwner = {
  projectPath: string | null;
  totalSec: number;
  revision: string;
};

type PeaksRead = {
  owner: PeaksOwner;
  peaks: readonly number[];
};

async function stemPeaks(
  projectPath: string,
  ref: string,
  meta: ReadyEntry,
  totalSec: number,
  signal: AbortSignal,
): Promise<number[]> {
  const level = meta.levels.length - 1;
  const tiles = levelTileCount(meta, level);
  const parts: Int16Array[] = [];
  for (let start = 0; start < tiles; start += MAX_TILES_PER_REQUEST) {
    const bytes = await loadWaveformTiles(
      projectPath,
      {
        key: meta.key,
        ref,
        level,
        start,
        count: Math.min(MAX_TILES_PER_REQUEST, tiles - start),
      },
      signal,
    );
    parts.push(new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2)));
  }
  const bins = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    bins.set(part, at);
    at += part.length;
  }
  return binPeaks(bins, meta, meta.levels[level]!.spp, totalSec);
}

/**
 * Whole-episode peaks (0..1) over `totalSec` of the timeline, from the fresh
 * rendered stems' coarsest pyramid level. Empty while loading, when no stem is
 * built, and after an error. A pyramid still building is asked again once
 * (after Retry-After when given); `revision` loads the peaks again.
 */
export function useEpisodePeaks(
  projectPath: string | null,
  totalSec: number,
  revision: string,
): readonly number[] {
  const [read, setRead] = useState<PeaksRead>(() => ({
    owner: { projectPath, totalSec, revision },
    peaks: NONE,
  }));
  const { owner } = read;
  if (
    owner.projectPath !== projectPath ||
    !Object.is(owner.totalSec, totalSec) ||
    owner.revision !== revision
  ) {
    setRead({ owner: { projectPath, totalSec, revision }, peaks: NONE });
  }
  useEffect(() => {
    const { projectPath, totalSec } = owner;
    if (!projectPath || isShareProjectKey(projectPath) || !(totalSec > 0))
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (retry: boolean) => {
      const wait = (ms: number) => {
        if (!retry) return;
        clearTimeout(timer);
        timer = setTimeout(() => void load(false), ms);
      };
      try {
        const status = await loadWaveformStatus(
          projectPath,
          "stem",
          controller.signal,
        );
        const entries = Object.entries(status.media);
        const ready = entries.filter(
          ([, e]) => isReady(e) && e.levels.length > 0,
        );
        if (entries.some(([, e]) => e.status === "generating"))
          wait(DEFAULT_RETRY_MS);
        const settled = await Promise.allSettled(
          ready.map(([ref, e]) =>
            stemPeaks(
              projectPath,
              ref,
              e as ReadyEntry,
              totalSec,
              controller.signal,
            ),
          ),
        );
        if (controller.signal.aborted) return;
        const rejected = settled.find((r) => r.status === "rejected");
        if (rejected && settled.every((r) => r.status === "rejected"))
          throw rejected.reason;
        const peaks = mixPeaks(
          settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
        );
        setRead((current) =>
          current.owner === owner ? { owner, peaks } : current,
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        if (
          err instanceof WaveformFetchError &&
          (err.status === 429 || err.status === 503)
        )
          wait((err.retryAfterSec || 0) * 1000 || DEFAULT_RETRY_MS);
      }
    };
    void load(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [owner]);
  return read.peaks;
}
