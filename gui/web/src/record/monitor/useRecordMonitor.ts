import { useCallback, useEffect, useInsertionEffect, useState } from "react";
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

// lib.dom types setSinkId on HTMLMediaElement only, not on AudioContext.
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

type MonitorInputs = Pick<
  Args,
  "send" | "localStream" | "snapshot" | "localId"
>;
type Acquisition = Pick<Args, "enabled" | "localId" | "role"> & {
  sessionId: string | null;
  /** A new value opens a fresh mesh and audio context for the same room. */
  attempt: number;
};
type MonitorObservation =
  | { kind: "inactive" }
  | { kind: "context-opened" }
  | { kind: "peer-count"; count: number }
  | { kind: "peer-levels"; levels: Record<string, number> }
  | { kind: "failure"; message: string };

class MonitorResources {
  private inputs: MonitorInputs;
  private readonly observe: (event: MonitorObservation) => void;
  private graph: MixMinusGraph | null = null;
  private readonly sources = new Map<string, AudioNode>();
  private readonly oscillators = new Map<string, OscillatorNode>();
  private readonly taps = new Map<string, PeerLevelTap>();
  private ctx: AudioContext | null = null;
  private mesh: RecordMesh | null = null;
  private readonly goneTimers = new Map<string, number>();
  private readonly sourceGens = new Map<string, number>();

  constructor(
    inputs: MonitorInputs,
    observe: (event: MonitorObservation) => void,
  ) {
    this.inputs = inputs;
    this.observe = observe;
  }

  commitInputs(inputs: MonitorInputs): void {
    this.inputs = inputs;
  }

  syncRoster(): void {
    const { localId } = this.inputs;
    const mesh = this.mesh;
    const graph = this.graph;
    const snap = this.inputs.snapshot;
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
    const ctx = this.ctx;
    const sources = this.sources;
    const oscillators = this.oscillators;
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
          this.observe({ kind: "peer-count", count: sources.size });
        }
      }
    }
  }

  acquire({
    enabled,
    localId,
    role,
    sessionId,
  }: Acquisition): (() => void) | undefined {
    const sources = this.sources;
    const oscillators = this.oscillators;
    const taps = this.taps;
    const dropTap = (peerId: string) => {
      taps.get(peerId)?.dispose();
      taps.delete(peerId);
    };
    if (!enabled || !localId || !sessionId) {
      this.mesh?.dispose();
      this.mesh = null;
      this.graph?.dispose();
      this.graph = null;
      for (const timer of this.goneTimers.values()) {
        window.clearTimeout(timer);
      }
      this.goneTimers.clear();
      this.sourceGens.clear();
      for (const id of [...sources.keys()]) {
        detachE2eRemote(sources, oscillators, id);
      }
      for (const id of [...taps.keys()]) {
        dropTap(id);
      }
      const ctx = this.ctx;
      this.ctx = null;
      if (ctx) {
        void ctx.close();
      }
      this.observe({ kind: "inactive" });
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) {
      this.observe({ kind: "failure", message: "AudioContext unavailable" });
      return;
    }
    let cancelled = false;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.observe({ kind: "context-opened" });
    const graph = new MixMinusGraph(ctx, { localId });
    this.graph = graph;
    const gone = this.goneTimers;
    const gens = this.sourceGens;
    const mesh = new RecordMesh({
      localId,
      role,
      localStream: this.inputs.localStream,
      send: (payload) => this.inputs.send(payload),
      onError: (err) => {
        this.observe({
          kind: "failure",
          message: errorMessage(err, "signal failed"),
        });
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
          peerMuted(this.inputs.snapshot, peerId),
        );
        dropTap(peerId);
        const tap = createPeerLevelTap(ctx, source);
        if (tap) {
          taps.set(peerId, tap);
        }
        this.observe({ kind: "peer-count", count: sources.size });
      },
      onRemoteGone: (peerId) => {
        if (cancelled) {
          return;
        }
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
          this.observe({ kind: "peer-count", count: sources.size });
        }, holdMs);
        gone.set(peerId, timer);
      },
    });
    this.mesh = mesh;
    void ctx.resume().catch(() => undefined);
    const unsub = subscribeRecordSignal((msg) => {
      void mesh.handleSignal(msg).catch((err: unknown) => {
        this.observe({
          kind: "failure",
          message: errorMessage(err, "signal failed"),
        });
      });
    });
    this.syncRoster();
    return () => {
      cancelled = true;
      unsub();
      mesh.dispose();
      this.mesh = null;
      graph.dispose();
      this.graph = null;
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
      this.ctx = null;
      void ctx.close();
    };
  }

  watchLevels(remoteCount: number): (() => void) | undefined {
    if (remoteCount === 0) {
      return;
    }
    const taps = this.taps;
    const timer = window.setInterval(() => {
      const next = readPeerLevels(taps);
      this.observe({ kind: "peer-levels", levels: next });
    }, PEER_LEVEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }

  connectLocal(localStream: MediaStream | null, role: RecordRole): void {
    this.mesh?.setLocalStream(localStream);
    const graph = this.graph;
    const ctx = this.ctx;
    if (!graph || !ctx) {
      return;
    }
    graph.disconnectLocal();
    if (localStream && role !== "producer") {
      const source = ctx.createMediaStreamSource(localStream);
      graph.connectLocal(source);
    }
  }

  setSendEnabled(enabled: boolean): void {
    this.mesh?.setSendEnabled(enabled);
  }

  readonly setSinkId = async (deviceId: string): Promise<boolean> => {
    const ctx = this.ctx as SinkContext | null;
    if (!ctx?.setSinkId) {
      return false;
    }
    await ctx.setSinkId(deviceId);
    return true;
  };
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
  /** Route the room's audio to a speaker ("" is the default). False, and nothing done, without a context. */
  setSinkId: (deviceId: string) => Promise<boolean>;
  /** Clears the failure and opens a fresh mesh and audio context. */
  retry: () => void;
} {
  const [remoteCount, setRemoteCount] = useState(0);
  const [levels, setLevels] = useState<Record<string, number>>({});
  if (remoteCount === 0 && Object.keys(levels).length > 0) {
    setLevels({});
  }
  const [error, setError] = useState<string | null>(null);
  const [contextGeneration, setContextGeneration] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const sessionId = snapshot?.session_id ?? null;
  const [monitor] = useState(
    () =>
      new MonitorResources(
        { send, localStream, snapshot, localId },
        (event) => {
          switch (event.kind) {
            case "inactive":
              setRemoteCount(0);
              setLevels((prev) => (Object.keys(prev).length === 0 ? prev : {}));
              break;
            case "context-opened":
              setContextGeneration((n) => n + 1);
              break;
            case "peer-count":
              setRemoteCount(event.count);
              break;
            case "peer-levels":
              setLevels((prev) =>
                sameLevels(prev, event.levels) ? prev : event.levels,
              );
              break;
            case "failure":
              setError(event.message);
              break;
          }
        },
      ),
  );
  const rosterKey =
    snapshot?.participants
      .map(
        (person) =>
          `${person.participant_id}:${Number(person.connected)}:${Number(person.muted)}:${person.connected_wall_ms ?? ""}`,
      )
      .join("|") ?? "";

  useInsertionEffect(() => {
    monitor.commitInputs({ send, localStream, snapshot, localId });
  }, [monitor, send, localStream, snapshot, localId]);

  useEffect(
    () => monitor.acquire({ enabled, localId, role, sessionId, attempt }),
    [monitor, enabled, localId, role, sessionId, attempt],
  );
  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);
  useEffect(() => monitor.watchLevels(remoteCount), [monitor, remoteCount]);
  useEffect(() => {
    monitor.connectLocal(localStream, role);
  }, [monitor, localStream, role]);
  useEffect(() => {
    monitor.setSendEnabled(!muted && role !== "producer");
  }, [monitor, muted, role]);
  useEffect(() => {
    monitor.syncRoster();
  }, [monitor, localId, rosterKey]);

  return {
    hearing: remoteCount > 0,
    remoteCount,
    error,
    levels,
    outputSupported: outputSelectable(),
    contextGeneration,
    setSinkId: monitor.setSinkId,
    retry,
  };
}
