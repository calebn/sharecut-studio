import { describe, expect, it } from "vitest";
import { RecordMesh } from "./mesh";

type FakeSender = {
  track: { kind: string; enabled: boolean } | null;
  replaceTrack: (track: MediaStreamTrack | null) => Promise<void>;
};

class FakePC {
  signalingState = "stable";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  iceServers: RTCIceServer[];
  senders: FakeSender[] = [];
  transceivers: { direction: string }[] = [];
  closed = false;
  onicecandidate:
    | ((ev: {
        candidate: { toJSON: () => RTCIceCandidateInit } | null;
      }) => void)
    | null = null;
  ontrack:
    | ((ev: { streams: MediaStream[]; track: MediaStreamTrack }) => void)
    | null = null;
  onnegotiationneeded: (() => void) | null = null;

  constructor(config: RTCConfiguration) {
    this.iceServers = config.iceServers ?? [];
  }

  addTransceiver(_kind: string, init: { direction: string }) {
    const sender: FakeSender = {
      track: null,
      replaceTrack: async (track) => {
        sender.track = track as FakeSender["track"];
      },
    };
    this.senders.push(sender);
    this.transceivers.push({ direction: init.direction });
    queueMicrotask(() => this.onnegotiationneeded?.());
    return { direction: init.direction, sender };
  }

  getSenders() {
    return this.senders;
  }

  addTrack(track: MediaStreamTrack) {
    const sender: FakeSender = {
      track: track as FakeSender["track"],
      replaceTrack: async (next) => {
        sender.track = next as FakeSender["track"];
      },
    };
    this.senders.push(sender);
    return sender;
  }

  async createOffer() {
    return { type: "offer" as const, sdp: "offer-sdp" };
  }

  async createAnswer() {
    return { type: "answer" as const, sdp: "answer-sdp" };
  }

  async setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
    this.signalingState = desc.type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    this.signalingState =
      desc.type === "offer" ? "have-remote-offer" : "stable";
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit | null) {
    return;
  }

  close() {
    this.closed = true;
  }
}

function track(): MediaStreamTrack {
  return { kind: "audio", enabled: true } as MediaStreamTrack;
}

function stream(): MediaStream {
  const audio = track();
  return {
    getAudioTracks: () => [audio],
  } as MediaStream;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("RecordMesh", () => {
  it("producers only add recvonly transceivers and never send", async () => {
    const created: FakePC[] = [];
    const sent: unknown[] = [];
    const mesh = new RecordMesh({
      localId: "P",
      role: "producer",
      localStream: stream(),
      send: (payload) => sent.push(payload),
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers(["A"]);
    await flush();
    expect(created[0]?.transceivers).toEqual([{ direction: "recvonly" }]);
    expect(created[0]?.senders[0]?.track).toBeNull();
    mesh.setLocalStream(stream());
    await flush();
    expect(created[0]?.senders[0]?.track).toBeNull();
    mesh.dispose();
  });

  it("recorded peers attach the local send track and mute disables it", async () => {
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers(["B"]);
    await flush();
    await flush();
    expect(created[0]?.transceivers).toEqual([{ direction: "sendrecv" }]);
    expect(created[0]?.senders[0]?.track?.kind).toBe("audio");
    mesh.setSendEnabled(false);
    expect(created[0]?.senders[0]?.track?.enabled).toBe(false);
    mesh.dispose();
  });

  it("recorded peers wait for a send track before offering", async () => {
    const sent: Array<{ to: string; description?: { type: string } }> = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: null,
      send: (payload) => sent.push(payload),
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) =>
        new FakePC(config) as unknown as RTCPeerConnection,
    });
    mesh.syncPeers(["B"]);
    await flush();
    expect(sent.some((row) => row.description?.type === "offer")).toBe(false);
    mesh.setLocalStream(stream());
    await flush();
    await flush();
    expect(sent.some((row) => row.description?.type === "offer")).toBe(true);
    mesh.dispose();
  });

  it("offers to the remote and answers an inbound offer", async () => {
    const sent: Array<{ to: string; description?: { type: string } }> = [];
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "B",
      role: "guest",
      localStream: stream(),
      send: (payload) => sent.push(payload),
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers(["A"]);
    await flush();
    expect(sent.some((row) => row.description?.type === "offer")).toBe(true);
    await mesh.handleSignal({
      type: "Signal",
      from: "A",
      to: "B",
      description: { type: "offer", sdp: "remote-offer" },
    });
    expect(sent.some((row) => row.description?.type === "answer")).toBe(true);
    mesh.syncPeers([]);
    expect(created[0]?.closed).toBe(true);
    mesh.dispose();
  });

  it("does not offer again after answering when the send track is already attached", async () => {
    const sent: Array<{ to: string; description?: { type: string } }> = [];
    const mesh = new RecordMesh({
      localId: "B",
      role: "guest",
      localStream: stream(),
      send: (payload) => sent.push(payload),
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) =>
        new FakePC(config) as unknown as RTCPeerConnection,
    });
    mesh.syncPeers(["A"]);
    await flush();
    const offersBefore = sent.filter(
      (row) => row.description?.type === "offer",
    ).length;
    await mesh.handleSignal({
      type: "Signal",
      from: "A",
      to: "B",
      description: { type: "answer", sdp: "remote-answer" },
    });
    mesh.setLocalStream(stream());
    await flush();
    const offersAfter = sent.filter(
      (row) => row.description?.type === "offer",
    ).length;
    expect(offersAfter).toBe(offersBefore);
    mesh.dispose();
  });

  it("ignores signals from peers that are not on the roster", async () => {
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers(["B"]);
    await mesh.handleSignal({
      type: "Signal",
      from: "zombie",
      to: "A",
      description: { type: "offer", sdp: "x" },
    });
    expect(created).toHaveLength(1);
    mesh.dispose();
  });

  it("does not open peers from signals after dispose", async () => {
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers(["B"]);
    await flush();
    expect(created).toHaveLength(1);
    mesh.dispose();
    expect(created[0]?.closed).toBe(true);
    await mesh.handleSignal({
      type: "Signal",
      from: "B",
      to: "A",
      description: { type: "offer", sdp: "late" },
    });
    expect(created).toHaveLength(1);
  });

  it("reports negotiation failures through onError", async () => {
    const errors: unknown[] = [];
    class BoomPC extends FakePC {
      async setRemoteDescription(): Promise<void> {
        throw new Error("setRemote failed");
      }
    }
    const mesh = new RecordMesh({
      localId: "C",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      onError: (err) => {
        errors.push(err);
      },
      createPeer: (config) =>
        new BoomPC(config) as unknown as RTCPeerConnection,
    });
    mesh.syncPeers(["B"]);
    await flush();
    await expect(
      mesh.handleSignal({
        type: "Signal",
        from: "B",
        to: "C",
        description: { type: "offer", sdp: "x" },
      }),
    ).rejects.toThrow("setRemote failed");
    await flush();
    expect(
      errors.some(
        (err) => err instanceof Error && err.message === "setRemote failed",
      ),
    ).toBe(true);
    mesh.dispose();
  });

  it("reconnects a live peer by closing the PC and re-offering once", async () => {
    const created: FakePC[] = [];
    const sent: Array<{ to: string; description?: { type: string } }> = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: stream(),
      send: (payload) => sent.push(payload),
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers(["B"]);
    await flush();
    expect(created).toHaveLength(1);
    const offersBefore = sent.filter(
      (row) => row.description?.type === "offer",
    ).length;
    expect(created[0]?.senders[0]?.track?.kind).toBe("audio");
    mesh.reconnectPeer("B");
    mesh.reconnectPeer("B");
    await flush();
    await flush();
    expect(created).toHaveLength(2);
    expect(created[0]?.closed).toBe(true);
    const offersAfter = sent.filter(
      (row) => row.description?.type === "offer",
    ).length;
    expect(offersAfter).toBe(offersBefore + 1);
    expect(created[1]?.senders[0]?.track?.kind).toBe("audio");
    mesh.dispose();
  });

  it("does not reconnect a peer that is not on the roster", async () => {
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers(["B"]);
    await flush();
    mesh.reconnectPeer("zombie");
    await flush();
    expect(created).toHaveLength(1);
    mesh.dispose();
  });

  it("reconnects when syncPeers sees a generation change on a live peer", async () => {
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers([{ id: "B", gen: 1 }]);
    await flush();
    expect(created).toHaveLength(1);
    mesh.syncPeers([{ id: "B", gen: 2 }]);
    await flush();
    await flush();
    expect(created).toHaveLength(2);
    expect(created[0]?.closed).toBe(true);
    mesh.dispose();
  });

  it("reconnects once more if a gen arrives while reconnecting", async () => {
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers([{ id: "B", gen: 1 }]);
    await flush();
    mesh.syncPeers([{ id: "B", gen: 2 }]);
    mesh.syncPeers([{ id: "B", gen: 3 }]);
    await flush();
    await flush();
    await flush();
    expect(created.length).toBeGreaterThanOrEqual(3);
    expect(created[0]?.closed).toBe(true);
    mesh.dispose();
  });

  it("ignores signals whose connected_wall_ms does not match the mesh gen", async () => {
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "C",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers([{ id: "B", gen: 5 }]);
    await flush();
    await mesh.handleSignal({
      type: "Signal",
      from: "B",
      to: "C",
      connected_wall_ms: 4,
      description: { type: "offer", sdp: "stale" },
    });
    expect(created[0]?.remoteDescription).toBeNull();
    await mesh.handleSignal({
      type: "Signal",
      from: "B",
      to: "C",
      connected_wall_ms: 5,
      description: { type: "offer", sdp: "fresh" },
    });
    expect(created[0]?.remoteDescription?.sdp).toBe("fresh");
    mesh.dispose();
  });

  it("clears reconnecting on dispose so later signals do not reopen", async () => {
    const created: FakePC[] = [];
    const mesh = new RecordMesh({
      localId: "A",
      role: "guest",
      localStream: stream(),
      send: () => undefined,
      onRemoteTrack: () => undefined,
      onRemoteGone: () => undefined,
      createPeer: (config) => {
        const pc = new FakePC(config);
        created.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    mesh.syncPeers([{ id: "B", gen: 1 }]);
    await flush();
    mesh.reconnectPeer("B");
    mesh.dispose();
    await mesh.handleSignal({
      type: "Signal",
      from: "B",
      to: "A",
      connected_wall_ms: 1,
      description: { type: "offer", sdp: "late" },
    });
    expect(created).toHaveLength(2);
    expect(created.every((pc) => pc.closed)).toBe(true);
  });
});
