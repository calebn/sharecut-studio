import type { RecordRole } from "../types";
import type { RecordSignal, SignalPayload } from "./signalBus";

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

const PENDING_ICE_MAX = 64;

export type PeerFactory = (config: RTCConfiguration) => RTCPeerConnection;

export type MeshPeerRef = {
  id: string;
  gen: number;
};

export type RecordMeshOpts = {
  localId: string;
  role: RecordRole;
  localStream: MediaStream | null;
  send: (payload: SignalPayload) => void;
  onRemoteTrack: (peerId: string, stream: MediaStream) => void;
  onRemoteGone: (peerId: string) => void;
  onError?: (err: unknown) => void;
  iceServers?: RTCIceServer[];
  createPeer?: PeerFactory;
};

type PeerSlot = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  chain: Promise<void>;
  dead: boolean;
};

export class RecordMesh {
  private readonly localId: string;
  private readonly role: RecordRole;
  private readonly send: (payload: SignalPayload) => void;
  private readonly onRemoteTrack: (peerId: string, stream: MediaStream) => void;
  private readonly onRemoteGone: (peerId: string) => void;
  private readonly onError?: (err: unknown) => void;
  private readonly iceServers: RTCIceServer[];
  private readonly createPeer: PeerFactory;
  private localStream: MediaStream | null;
  private sendEnabled = true;
  private readonly peers = new Map<string, PeerSlot>();
  private readonly wanted = new Set<string>();
  private readonly gens = new Map<string, number>();
  private readonly reconnecting = new Set<string>();
  private readonly dirtyGens = new Set<string>();
  private readonly flightGen = new Map<string, number | undefined>();
  private closed = false;

  constructor(opts: RecordMeshOpts) {
    this.localId = opts.localId;
    this.role = opts.role;
    this.localStream = opts.localStream;
    this.send = opts.send;
    this.onRemoteTrack = opts.onRemoteTrack;
    this.onRemoteGone = opts.onRemoteGone;
    this.onError = opts.onError;
    this.iceServers = opts.iceServers ?? DEFAULT_ICE_SERVERS;
    this.createPeer =
      opts.createPeer ?? ((config) => new RTCPeerConnection(config));
  }

  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    for (const [peerId, slot] of this.peers) {
      void this.attachAndMaybeOffer(peerId, slot);
    }
    this.applySendEnabled();
  }

  setSendEnabled(enabled: boolean): void {
    this.sendEnabled = enabled;
    this.applySendEnabled();
  }

  syncPeers(peers: Array<string | MeshPeerRef>): void {
    const refs = peers
      .map((peer) => (typeof peer === "string" ? { id: peer, gen: 0 } : peer))
      .filter((peer) => peer.id && peer.id !== this.localId);
    this.wanted.clear();
    const incoming = new Map<string, number>();
    for (const peer of refs) {
      this.wanted.add(peer.id);
      incoming.set(peer.id, peer.gen);
    }
    for (const id of [...this.peers.keys()]) {
      if (!this.wanted.has(id)) {
        this.closePeer(id);
      }
    }
    for (const id of this.wanted) {
      const gen = incoming.get(id) ?? 0;
      const prev = this.gens.get(id);
      this.gens.set(id, gen);
      if (!this.peers.has(id)) {
        this.openPeer(id);
      } else if (prev !== undefined && prev !== gen) {
        this.reconnectPeer(id);
      }
    }
  }

  hasPeer(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  reconnectPeer(peerId: string): void {
    if (this.closed || !this.wanted.has(peerId)) {
      this.reconnecting.delete(peerId);
      this.dirtyGens.delete(peerId);
      this.flightGen.delete(peerId);
      return;
    }
    if (this.reconnecting.has(peerId)) {
      const flight = this.flightGen.get(peerId);
      const current = this.gens.get(peerId);
      if (current !== undefined && current !== flight) {
        this.dirtyGens.add(peerId);
      }
      return;
    }
    this.reconnecting.add(peerId);
    this.flightGen.set(peerId, this.gens.get(peerId));
    this.closePeer(peerId);
    this.openPeer(peerId);
    const slot = this.peers.get(peerId);
    const finish = (): void => {
      this.reconnecting.delete(peerId);
      this.flightGen.delete(peerId);
      if (this.closed) {
        return;
      }
      if (this.dirtyGens.delete(peerId) && this.wanted.has(peerId)) {
        this.reconnectPeer(peerId);
      }
    };
    if (!slot) {
      finish();
      return;
    }
    void this.enqueue(slot, async () => undefined).finally(finish);
  }

  handleSignal(msg: RecordSignal): Promise<void> {
    if (msg.to !== this.localId || msg.from === this.localId || this.closed) {
      return Promise.resolve();
    }
    const expected = this.gens.get(msg.from);
    if (
      msg.connected_wall_ms != null &&
      expected != null &&
      msg.connected_wall_ms !== expected
    ) {
      return Promise.resolve();
    }
    let slot = this.peers.get(msg.from);
    if (!slot) {
      if (!this.wanted.has(msg.from)) {
        return Promise.resolve();
      }
      slot = this.openPeer(msg.from);
    }
    return this.enqueue(slot, () => this.applySignal(slot, msg));
  }

  dispose(): void {
    this.closed = true;
    this.wanted.clear();
    this.reconnecting.clear();
    this.dirtyGens.clear();
    this.flightGen.clear();
    this.gens.clear();
    for (const id of [...this.peers.keys()]) {
      this.closePeer(id);
    }
  }

  private openPeer(peerId: string): PeerSlot {
    const pc = this.createPeer({ iceServers: this.iceServers });
    const slot: PeerSlot = {
      pc,
      polite: this.localId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
      chain: Promise.resolve(),
      dead: false,
    };
    this.peers.set(peerId, slot);
    pc.onicecandidate = (ev) => {
      if (this.closed || slot.dead) {
        return;
      }
      this.send(
        this.outbound(peerId, {
          candidate: ev.candidate ? ev.candidate.toJSON() : { candidate: "" },
        }),
      );
    };
    pc.ontrack = (ev) => {
      if (this.closed || slot.dead) {
        return;
      }
      const stream =
        ev.streams[0] ?? new MediaStream(ev.track ? [ev.track] : []);
      this.onRemoteTrack(peerId, stream);
    };
    pc.onnegotiationneeded = () => {
      void this.attachAndMaybeOffer(peerId, slot);
    };
    if (this.role === "producer") {
      pc.addTransceiver("audio", { direction: "recvonly" });
    } else {
      pc.addTransceiver("audio", { direction: "sendrecv" });
      void this.attachAndMaybeOffer(peerId, slot);
    }
    return slot;
  }

  private enqueue(slot: PeerSlot, work: () => Promise<void>): Promise<void> {
    if (this.closed || slot.dead) {
      return Promise.resolve();
    }
    const next = slot.chain.then(async () => {
      if (this.closed || slot.dead) {
        return;
      }
      await work();
    });
    slot.chain = next.catch((err: unknown) => {
      this.onError?.(err);
    });
    return next;
  }

  private async ensureSenders(slot: PeerSlot): Promise<boolean> {
    if (this.role === "producer" || !this.localStream || slot.dead) {
      return false;
    }
    const track = this.localStream.getAudioTracks()[0];
    if (!track) {
      return false;
    }
    const sender = slot.pc
      .getSenders()
      .find((item) => !item.track || item.track.kind === "audio");
    if (sender) {
      if (sender.track !== track) {
        const wasNull = sender.track == null;
        await sender.replaceTrack(track);
        this.applySendEnabled();
        return wasNull;
      }
      return false;
    }
    slot.pc.addTrack(track, this.localStream);
    this.applySendEnabled();
    return true;
  }

  private applySendEnabled(): void {
    const enabled = this.sendEnabled && this.role !== "producer";
    for (const slot of this.peers.values()) {
      if (slot.dead) {
        continue;
      }
      for (const sender of slot.pc.getSenders()) {
        if (sender.track) {
          sender.track.enabled = enabled;
        }
      }
    }
  }

  private hasSendTrack(): boolean {
    return Boolean(this.localStream?.getAudioTracks()[0]);
  }

  private shouldOffer(): boolean {
    if (this.closed) {
      return false;
    }
    return this.role === "producer" || this.hasSendTrack();
  }

  private async attachAndMaybeOffer(
    peerId: string,
    slot: PeerSlot,
  ): Promise<void> {
    return this.enqueue(slot, () => this.offerIfNeeded(peerId, slot));
  }

  private async offerIfNeeded(peerId: string, slot: PeerSlot): Promise<void> {
    if (this.closed || slot.dead) {
      return;
    }
    const alreadyNegotiated = Boolean(slot.pc.remoteDescription);
    slot.makingOffer = true;
    try {
      const attachedNew = await this.ensureSenders(slot);
      if (
        this.closed ||
        slot.dead ||
        !this.shouldOffer() ||
        slot.pc.signalingState !== "stable"
      ) {
        return;
      }
      if (alreadyNegotiated && !attachedNew) {
        return;
      }
      const offer = await slot.pc.createOffer();
      await slot.pc.setLocalDescription(offer);
      const description = slot.pc.localDescription;
      if (description && !slot.dead && !this.closed) {
        this.send(
          this.outbound(peerId, {
            description: { type: description.type, sdp: description.sdp ?? "" },
          }),
        );
      }
    } catch (err) {
      if (!this.closed && !slot.dead) {
        this.onError?.(err);
      }
    } finally {
      slot.makingOffer = false;
    }
  }

  private async applySignal(slot: PeerSlot, msg: RecordSignal): Promise<void> {
    if (this.closed || slot.dead) {
      return;
    }
    if (msg.description) {
      const offerCollision =
        msg.description.type === "offer" &&
        (slot.makingOffer || slot.pc.signalingState !== "stable");
      slot.ignoreOffer = !slot.polite && offerCollision;
      if (slot.ignoreOffer) {
        return;
      }
      await slot.pc.setRemoteDescription(msg.description);
      await this.flushIce(slot);
      if (msg.description.type === "offer") {
        await this.ensureSenders(slot);
        const answer = await slot.pc.createAnswer();
        await slot.pc.setLocalDescription(answer);
        const description = slot.pc.localDescription;
        if (description && !slot.dead && !this.closed) {
          this.send(
            this.outbound(msg.from, {
              description: {
                type: description.type,
                sdp: description.sdp ?? "",
              },
            }),
          );
        }
      }
      return;
    }
    if (msg.candidate) {
      slot.pendingIce.push(msg.candidate);
      while (slot.pendingIce.length > PENDING_ICE_MAX) {
        slot.pendingIce.shift();
      }
      await this.flushIce(slot);
    }
  }

  private async flushIce(slot: PeerSlot): Promise<void> {
    if (!slot.pc.remoteDescription || slot.dead) {
      return;
    }
    const queued = slot.pendingIce.splice(0);
    for (const candidate of queued) {
      try {
        await slot.pc.addIceCandidate(candidate.candidate ? candidate : null);
      } catch {
        // outdated
      }
    }
  }

  private outbound(
    peerId: string,
    rest: Omit<SignalPayload, "to" | "connected_wall_ms">,
  ): SignalPayload {
    const gen = this.gens.get(peerId);
    if (gen === undefined) {
      return { to: peerId, ...rest };
    }
    return { to: peerId, connected_wall_ms: gen, ...rest };
  }

  private closePeer(peerId: string): void {
    if (!this.wanted.has(peerId)) {
      this.reconnecting.delete(peerId);
      this.dirtyGens.delete(peerId);
      this.flightGen.delete(peerId);
      this.gens.delete(peerId);
    }
    const slot = this.peers.get(peerId);
    if (!slot) {
      return;
    }
    slot.dead = true;
    slot.pendingIce.length = 0;
    this.peers.delete(peerId);
    slot.pc.onicecandidate = null;
    slot.pc.ontrack = null;
    slot.pc.onnegotiationneeded = null;
    slot.pc.close();
    this.onRemoteGone(peerId);
  }
}
