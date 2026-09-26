import {
  type TakeClipping,
  type TakeClipRegion,
  takeRelativeMs,
} from "./clipRegions";
import {
  type ByteSink,
  keeperMetaPath,
  keeperWavPath,
  MAX_KEEPER_SEGMENTS,
  parseKeeperMeta,
  prunedKeeperMarker,
} from "./store";

/**
 * Rebuild one take's clipping report from OPFS keeper metadata, so it
 * survives a reload. `known` is false when any segment is pending, legacy or
 * unreadable (crash recovery and older clients carry no clip regions).
 */
export async function readTakeClipping(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  takeIndex: number,
): Promise<TakeClipping> {
  const count = Math.min(
    await sink.nextSegmentIndex(sessionId, takeIndex, participantId),
    MAX_KEEPER_SEGMENTS,
  );
  const regions: TakeClipRegion[] = [];
  let known = true;
  for (let segmentIndex = 0; segmentIndex < count; segmentIndex += 1) {
    const wavPath = keeperWavPath({
      sessionId,
      takeIndex,
      participantId,
      segmentIndex,
    });
    const bytes = await sink.read(keeperMetaPath(wavPath));
    if (prunedKeeperMarker(bytes, wavPath)) continue;
    const meta = parseKeeperMeta(bytes);
    if (!meta || meta.complete !== true || meta.clippingRegions === undefined) {
      known = false;
      continue;
    }
    regions.push(
      ...takeRelativeMs(segmentIndex, meta.joinOffsetMs, meta.clippingRegions),
    );
  }
  regions.sort((a, b) => a.startMs - b.startMs);
  return { takeIndex, regions, known };
}
