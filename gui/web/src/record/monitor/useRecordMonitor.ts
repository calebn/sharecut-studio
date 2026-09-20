import { useEffect, useRef, useState } from "react";
import { MIX_MINUS_RAMP_S, MixMinusGraph } from "../../audio/mixMinus";
import type { RecordRole, RecordSnapshot } from "../types";
import { detachE2eRemote, injectE2eRemote, recordE2eEnabled } from "./e2eHook";
import { RecordMesh } from "./mesh";
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

function audioContextCtor(): typeof AudioContext | undefined {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext || w.webkitAudioContext;
}

export function useRecordMonitor({
  enabled,
  localId,
  role,
  snapshot,
  localStream,
  muted,
  send,
}: Args): { hearing: boolean; remoteCount: number; error: string | null } {
  const [remoteCount, setRemoteCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
  const ctxRef = useRef<AudioContext | null>(null);
  const meshRef = useRef<RecordMesh | null>(null);
  const localSrcRef = useRef<MediaStreamAudioSourceNode | null>(null);
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
    if (!enabled || !localId || !sessionId) {
      meshRef.current?.dispose();
      meshRef.current = null;
      graphRef.current?.dispose();
      graphRef.current = null;
      localSrcRef.current = null;
      for (const timer of goneTimers.current.values()) {
        window.clearTimeout(timer);
      }
      goneTimers.current.clear();
      sourceGens.current.clear();
      for (const id of [...sources.keys()]) {
        detachE2eRemote(sources, oscillators, id);
      }
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) {
        void ctx.close();
      }
      setRemoteCount(0);
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
        setError(err instanceof Error ? err.message : "signal failed");
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
          setRemoteCount(sources.size);
        }, holdMs);
        gone.set(peerId, timer);
      },
    });
    meshRef.current = mesh;
    void ctx.resume().catch(() => undefined);
    const unsub = subscribeRecordSignal((msg) => {
      void mesh.handleSignal(msg).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "signal failed");
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
      localSrcRef.current = null;
      for (const timer of gone.values()) {
        window.clearTimeout(timer);
      }
      gone.clear();
      gens.clear();
      for (const id of [...sources.keys()]) {
        detachE2eRemote(sources, oscillators, id);
      }
      ctxRef.current = null;
      void ctx.close();
    };
  }, [enabled, localId, role, sessionId]);

  useEffect(() => {
    meshRef.current?.setLocalStream(localStream);
    const graph = graphRef.current;
    const ctx = ctxRef.current;
    if (!graph || !ctx) {
      return;
    }
    if (localSrcRef.current) {
      localSrcRef.current.disconnect();
      localSrcRef.current = null;
    }
    if (localStream && role !== "producer") {
      const source = ctx.createMediaStreamSource(localStream);
      localSrcRef.current = source;
      graph.connectLocal(source);
    }
  }, [localStream, role]);

  useEffect(() => {
    meshRef.current?.setSendEnabled(!muted && role !== "producer");
  }, [muted, role]);

  useEffect(() => {
    syncRosterRef.current();
  }, [localId, rosterKey]);

  return {
    hearing: remoteCount > 0,
    remoteCount,
    error,
  };
}
