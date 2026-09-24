export const RECORD_E2E_BUILD =
  import.meta.env.MODE === "test" || import.meta.env.VITE_SHARECUT_E2E === "1";

export function recordE2eEnabled(
  search: string = window.location.search,
): boolean {
  if (!RECORD_E2E_BUILD || new URLSearchParams(search).get("e2e") !== "1") {
    return false;
  }
  return Boolean(
    (window as unknown as { __SHARECUT_E2E?: boolean }).__SHARECUT_E2E,
  );
}

const E2E_ROOM_TONE_PCM_FLAG = "__SHARECUT_E2E_ROOM_TONE_PCM";

type RecordE2eWindow = Window & {
  __SHARECUT_E2E?: boolean;
  __SHARECUT_E2E_ROOM_TONE_PCM?: boolean;
};

/**
 * Supplies deterministic microphone PCM for the one room-tone browser test.
 *
 * Headless Chromium's fake microphone can expose a live MediaStream while its
 * AudioContext clock barely advances. This opt-in test hook leaves the normal
 * worklet path intact, but lets that test exercise the real PCM-to-WAV, local
 * persistence, and Accept flow without relaxing the production timeout.
 */
export function e2eRoomTonePcm(
  sampleRate: number,
  durationSec: number,
  search: string = window.location.search,
): Float32Array | null {
  if (!RECORD_E2E_BUILD) {
    return null;
  }
  const e2eWindow = window as RecordE2eWindow;
  if (!recordE2eEnabled(search) || !e2eWindow[E2E_ROOM_TONE_PCM_FLAG]) {
    return null;
  }
  return new Float32Array(
    Math.max(1, Math.round(sampleRate * durationSec)),
  ).fill(0.001);
}

export function injectE2eRemote(
  ctx: AudioContext,
  graph: {
    addRemote: (id: string, source: AudioNode) => void;
    setRemoteMuted: (id: string, muted: boolean) => void;
  },
  sources: Map<string, AudioNode>,
  oscillators: Map<string, OscillatorNode>,
  peerId: string,
  muted = false,
): AudioNode | null {
  if (!RECORD_E2E_BUILD) {
    return null;
  }
  if (sources.has(peerId) && oscillators.has(peerId)) {
    graph.setRemoteMuted(peerId, muted);
    return sources.get(peerId) ?? null;
  }
  if (sources.has(peerId)) {
    return null;
  }
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const source = ctx.createMediaStreamSource(dest.stream);
  oscillators.set(peerId, osc);
  sources.set(peerId, source);
  graph.addRemote(peerId, source);
  graph.setRemoteMuted(peerId, muted);
  return source;
}

export function detachE2eRemote(
  sources: Map<string, AudioNode>,
  oscillators: Map<string, OscillatorNode>,
  peerId: string,
): void {
  const osc = oscillators.get(peerId);
  if (osc) {
    try {
      osc.stop();
    } catch {
      // already stopped
    }
    oscillators.delete(peerId);
  }
  const source = sources.get(peerId);
  if (source) {
    source.disconnect();
    sources.delete(peerId);
  }
}
