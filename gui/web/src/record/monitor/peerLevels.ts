import { createChannelPeakTap } from "../../audio/channelPeakTap";
import { peakDbFromSamples } from "../../audio/metering";
import { dbToFraction } from "../../ui/metering";

export type PeerLevelTap = { read: () => number; dispose: () => void };

/** How often the tiles' levels refresh, in ms. */
export const PEER_LEVEL_INTERVAL_MS = 100;

/** Levels move in 5% steps, so a steady voice does not re-render the room. */
const STEP = 0.05;

/**
 * A silent analyser beside one remote peer's source: it never reaches the
 * speakers, so the mix-minus graph and what the guest hears stay as they were.
 * Null when the context cannot build one.
 */
export function createPeerLevelTap(
  ctx: Parameters<typeof createChannelPeakTap>[0],
  source: AudioNode,
): PeerLevelTap | null {
  try {
    const tap = createChannelPeakTap(ctx, source);
    return {
      read: () => dbToFraction(peakDbFromSamples(tap.read())),
      dispose: () => tap.dispose(),
    };
  } catch {
    return null;
  }
}

export function readPeerLevels(
  taps: ReadonlyMap<string, PeerLevelTap>,
): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const [peerId, tap] of taps) {
    levels[peerId] = Math.round(tap.read() / STEP) * STEP;
  }
  return levels;
}

export function sameLevels(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Math.abs(a[key] - (b[key] ?? Number.NaN)) < 1e-9)
  );
}
