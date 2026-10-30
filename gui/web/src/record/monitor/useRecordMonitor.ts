import { useCallback, useEffect, useRef, useState } from "react";
import { MIX_MINUS_RAMP_S, MixMinusGraph } from "../../audio/mixMinus";
import { errorMessage } from "../../utils/apiError";
import { audioContextCtor } from "../../utils/audio";
import type { RecordRole, RecordSnapshot } from "../types";
import { detachE2eRemote, injectE2eRemote, recordE2eEnabled } from "./e2eHook";
import { RecordMesh } from "./mesh";
import {
  createPeerLevelTap,
  PEER_LEVEL_INTERVAL_MS,
  type PeerLevelTap,
  readPeerLevels,
  sameLevels,
} from "./peerLevels";
import { type SignalPayload, subscribeRecordSignal } from "./signalBus";

type Args = {
  enabled: boolean;
  localId: string | null;
  role: RecordRole;
  snapshot: RecordSnapshot | null;
  localStream: MediaStream | null;
  muted: boolean;
  send: (payload: SignalPayload) => void;
};

type SinkContext = { setSinkId?: (deviceId: string) => Promise<void> };

/** True when the browser's AudioContext can route to a chosen speaker. */
export function outputSelectable(): boolean {
  const Ctor = audioContextCtor();
  return Ctor !== undefined && "setSinkId" in Ctor.prototype;
}

export function peerMuted(
  snapshot: RecordSnapshot | null,
  peerId: string,
): boolean {
  return Boolean(
    snapshot?.participants.find((person) => person.participant_id === peerId)
      ?.muted,
  );
}

export function attachRemoteSource(
  graph: MixMinusGraph,
  sources: Map<string, AudioNode>,
  peerId: string,
  source: AudioNode,
  muted: boolean,
): void {
  const prior = sources.get(peerId);
  if (prior && prior !== source) {
    try {
      prior.disconnect();
    } catch {
      // already disconnected
    }
  }
  sources.set(peerId, source);
  graph.addRemote(peerId, source);
  graph.setRemoteMuted(peerId, muted);
}

export function useRecordMonitor({
  enabled,
  localId,
  role,
  snapshot,
  localStream,
  muted,
  send,
}: Args): {
  hearing: boolean;
  remoteCount: number;
  error: string | null;
  /** Each remote peer's level, 0 to 1, from an analyser on their audio. Client-side only. */
  levels: Record<string, number>;
  outputSupported: boolean;
  /** Counts each AudioContext opened, so the speaker pick is applied to a new one. */
  contextGeneration: number;
  /** Route the room's audio to a speaker ("" is the default). A no-op without a context. */
  setSinkId: (deviceId: string) => Promise<void>;
} {
  const [remoteCount, setRemoteCount] = useState(0);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [contextGeneration, setContextGeneration] = useState(0);
  const sessionId = snapshot?.session_id ?? null;
  const sendRef = useRef(send);
  sendRef.current = send;
  const streamRef = useRef(localStream);
  streamRef.current = localStream;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const graphRef = useRef<MixMinusGraph | null>(null);
  const sourcesRef = useRef(new Map<string, AudioNode>());
  const oscillatorsRef = useRef(new Map<string, OscillatorNode>());
  const tapsRef = useRef(new Map<string, PeerLevelTap>());
  const ctxRef = useRef<AudioContext | null>(null);
  const meshRef = useRef<RecordMesh | null>(null);
  const goneTimers = useRef(new Map<string, number>());
  const sourceGens = useRef(new Map<string, number>());
  const syncRosterRef = useRef<() => void>(() => undefined);

  const rosterKey =
    snapshot?.participants
      .map(
        (person) =>
          `${person.participant_id}:${Number(person.connected)}:${Number(person.muted)}:${person.connected_wall_ms ?? ""}`,
      )
      .join("|") ?? "";

  syncRosterRef.current = () => {
    const mesh = meshRef.current;
    const graph = graphRef.current;
    const snap = snapshotRef.current;
    if (!mesh || !snap || !localId) {
      return;
    }
    const peers = snap.participants.filter(
      (person) => person.connected && person.participant_id !== localId,
    );
    mesh.syncPeers(
      peers.map((person) => ({
        id: person.participant_id,
        gen: person.connected_wall_ms ?? person.joined_wall_ms ?? 0,
      })),
    );
    const ctx = ctxRef.current;
    const sources = sourcesRef.current;
    const oscillators = oscillatorsRef.current;
    for (const person of peers) {
      graph?.setRemoteMuted(person.participant_id, person.muted);
      if (recordE2eEnabled() && ctx && graph) {
        const injected = injectE2eRemote(
          ctx,
          graph,
          sources,
          oscillators,
          person.participant_id,
          person.muted,
        );
        if (injected) {
          setRemoteCount(sources.size);
        }
      }
    }
  };

  useEffect(() => {
    const sources = sourcesRef.current;
    const oscillators = oscillatorsRef.current;
    const taps = tapsRef.current;
    const dropTap = (peerId: string) => {
      taps.get(peerId)?.dispose();
      taps.delete(peerId);
    };
    if (!enabled || !localId || !sessionId) {
      meshRef.current?.dispose();
      meshRef.current = null;
      graphRef.current?.dispose();
      graphRef.current = null;
      for (const timer of goneTimers.current.values()) {
        window.clearTimeout(timer);
      }
      goneTimers.current.clear();
      sourceGens.current.clear();
      for (const id of [...sources.keys()]) {
        detachE2eRemote(sources, oscillators, id);
      }
      for (const id of [...taps.keys()]) {
        dropTap(id);
      }
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) {
        void ctx.close();
      }
      setRemoteCount(0);
      setLevels((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) {
      setError("AudioContext unavailable");
      return;
    }
    let cancelled = false;
    const ctx = new Ctor();
    ctxRef.current = ctx;
    setContextGeneration((n) => n + 1);
    const graph = new MixMinusGraph(ctx, { localId });
    graphRef.current = graph;
    const gone = goneTimers.current;
    const gens = sourceGens.current;
    const mesh = new RecordMesh({
      localId,
      role,
      localStream: streamRef.current,
      send: (payload) => sendRef.current(payload),
      onError: (err) => {
        setError(errorMessage(err, "signal failed"));
      },
      onRemoteTrack: (peerId, stream) => {
        if (cancelled) {
          return;
        }
        const previous = gone.get(peerId);
        if (previous !== undefined) {
          window.clearTimeout(previous);
          gone.delete(peerId);
        }
        const gen = (gens.get(peerId) ?? 0) + 1;
        gens.set(peerId, gen);
        const source = ctx.createMediaStreamSource(stream);
        attachRemoteSource(
          graph,
          sources,
          peerId,
          source,
          peerMuted(snapshotRef.current, peerId),
        );
        dropTap(peerId);
        const tap = createPeerLevelTap(ctx, source);
        if (tap) {
          taps.set(peerId, tap);
        }
        setRemoteCount(sources.size);
      },
      onRemoteGone: (peerId) => {
        const previous = gone.get(peerId);
        if (previous !== undefined) {
          window.clearTimeout(previous);
        }
        graph.removeRemote(peerId);
        const holdMs = MIX_MINUS_RAMP_S * 1000 + 5;
        const heldGen = gens.get(peerId);
        const timer = window.setTimeout(() => {
          gone.delete(peerId);
          if (gens.get(peerId) !== heldGen) {
            return;
          }
          detachE2eRemote(sources, oscillators, peerId);
          dropTap(peerId);
          setRemoteCount(sources.size);
        }, holdMs);
        gone.set(peerId, timer);
      },
    });
    meshRef.current = mesh;
    void ctx.resume().catch(() => undefined);
    const unsub = subscribeRecordSignal((msg) => {
      void mesh.handleSignal(msg).catch((err: unknown) => {
        setError(errorMessage(err, "signal failed"));
      });
    });
    syncRosterRef.current();
    return () => {
      cancelled = true;
      unsub();
      mesh.dispose();
      meshRef.current = null;
      graph.dispose();
      graphRef.current = null;
      for (const timer of gone.values()) {
        window.clearTimeout(timer);
      }
      gone.clear();
      gens.clear();
      for (const id of [...sources.keys()]) {
        detachE2eRemote(sources, oscillators, id);
      }
      for (const id of [...taps.keys()]) {
        dropTap(id);
      }
      ctxRef.current = null;
      void ctx.close();
    };
  }, [enabled, localId, role, sessionId]);

  useEffect(() => {
    if (remoteCount === 0) {
      setLevels((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const taps = tapsRef.current;
    const timer = window.setInterval(() => {
      const next = readPeerLevels(taps);
      setLevels((prev) => (sameLevels(prev, next) ? prev : next));
    }, PEER_LEVEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [remoteCount]);

  useEffect(() => {
    meshRef.current?.setLocalStream(localStream);
    const graph = graphRef.current;
    const ctx = ctxRef.current;
    if (!graph || !ctx) {
      return;
    }
    graph.disconnectLocal();
    if (localStream && role !== "producer") {
      const source = ctx.createMediaStreamSource(localStream);
      graph.connectLocal(source);
    }
  }, [localStream, role]);

  useEffect(() => {
    meshRef.current?.setSendEnabled(!muted && role !== "producer");
  }, [muted, role]);

  useEffect(() => {
    syncRosterRef.current();
  }, [localId, rosterKey]);

  const setSinkId = useCallback(async (deviceId: string) => {
    const ctx = ctxRef.current as SinkContext | null;
    await ctx?.setSinkId?.(deviceId);
  }, []);

  return {
    hearing: remoteCount > 0,
    remoteCount,
    error,
    levels,
    outputSupported: outputSelectable(),
    contextGeneration,
    setSinkId,
  };
}
