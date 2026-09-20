export function recordE2eEnabled(
  search: string = window.location.search,
): boolean {
  if (new URLSearchParams(search).get("e2e") !== "1") {
    return false;
  }
  return Boolean(
    (window as unknown as { __SHARECUT_E2E?: boolean }).__SHARECUT_E2E,
  );
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
