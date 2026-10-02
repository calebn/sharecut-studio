import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import type { RecordSignal } from "../record/monitor/signalBus";
import { useRecordMonitor } from "../record/monitor/useRecordMonitor";
import type { RecordParticipant, RecordSnapshot } from "../record/types";
import { useDawStore } from "../state/dawStore";
import { flushInbound } from "../sync/inboundQueue";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import { useHostSync } from "./useHostSync";

vi.mock("../state/requestDrainLazy", () => ({ requestHostDrainLazy: vi.fn() }));
vi.mock("../api", () => ({
  loadSessionMeta: vi.fn(async () => ({ mtime_ns: 0, exists: false })),
  loadSessionState: vi.fn(async () => null),
  postSessionState: vi.fn(),
}));
vi.mock("../audio/mixMinus", () => ({
  MIX_MINUS_RAMP_S: 0,
  MixMinusGraph: class {
    dispose() {}
    disconnectLocal() {}
    setRemoteMuted() {}
    removeRemote() {}
  },
}));
vi.mock("../utils/audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audio")>()),
  audioContextCtor: () =>
    class {
      async resume() {}
      async close() {}
    },
}));

class PeerConnection {
  static instances: PeerConnection[] = [];
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  setRemoteDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.remoteDescription = description;
      this.signalingState =
        description.type === "offer" ? "have-remote-offer" : "stable";
    },
  );
  constructor() {
    PeerConnection.instances.push(this);
  }
  addTransceiver() {
    return {
      direction: "sendrecv",
      sender: { track: null, replaceTrack: async () => undefined },
    };
  }
  getSenders() {
    return [];
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "answer" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    this.signalingState = "stable";
  }
  async addIceCandidate() {}
  close() {
    this.closed = true;
  }
}

function participant(id: string, generation = 1): RecordParticipant {
  return {
    participant_id: id,
    role: id === "p_host" ? "host" : "guest",
    display_name: id,
    connected: true,
    consented: true,
    muted: false,
    headphones_ack: true,
    connected_wall_ms: generation,
  };
}
function room(
  sessionId = "room",
  peers: RecordParticipant[] = [],
): RecordSnapshot {
  return {
    session_id: sessionId,
    state: "lobby",
    take_index: 0,
    caps: { recorded: 4, producers: 2 },
    participants: [participant("p_host"), ...peers],
  };
}
function snapshot(value: RecordSnapshot) {
  return { plane: "record", type: "Snapshot", snapshot: value };
}
function offer(from = "guest", generation = 1): RecordSignal {
  return {
    plane: "record",
    type: "Signal",
    from,
    to: "p_host",
    connected_wall_ms: generation,
    description: { type: "offer", sdp: `${from}-${generation}` },
  };
}
const send = vi.fn();

function mount(initial: RecordSnapshot | null) {
  useRecordHostStore.getState().setSnapshot(initial);
  return renderHook(() => {
    const current = useDawStore();
    useHostSync(
      current.projectPath,
      current.applyAgentSession,
      () => ({}),
      true,
      current.lastAppliedRevision,
      current.lastAppliedCommandId,
      false,
      "record-causality",
    );
    const currentRoom = useRecordHostStore((state) => state.snapshot);
    useRecordMonitor({
      enabled: currentRoom !== null,
      localId: currentRoom ? "p_host" : null,
      role: "host",
      snapshot: currentRoom,
      localStream: null,
      muted: false,
      send,
    });
  });
}
async function deliver(...frames: unknown[]) {
  await act(async () => {
    for (const frame of frames) FakeWebSocket.instances[0].deliver(frame);
    flushInbound();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
}
function descriptions() {
  return PeerConnection.instances.flatMap((peer) =>
    peer.setRemoteDescription.mock.calls.map(([value]) => value),
  );
}

beforeEach(() => {
  FakeWebSocket.reset();
  PeerConnection.instances = [];
  send.mockClear();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("RTCPeerConnection", PeerConnection);
  useDawStore
    .getState()
    .hydrate("/tmp/host-record-causality.project.json", minimalProject());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["same-room", "new-room", "initial-null"])(
  "applies the recording roster before a co-batched offer (%s)",
  async (initial) => {
    mount(
      initial === "initial-null"
        ? null
        : room(initial === "new-room" ? "old-room" : "room"),
    );
    const signal = offer();
    await deliver(snapshot(room("room", [participant("guest")])), signal);
    expect(descriptions()).toEqual([signal.description]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "guest",
        description: { type: "answer", sdp: "answer" },
      }),
    );
  },
);

it("replaces an old connection generation before its new offer and rejects a stale offer", async () => {
  mount(room("room", [participant("guest", 1)]));
  const previous = PeerConnection.instances[0];
  await deliver(
    snapshot(room("room", [participant("guest", 2)])),
    offer("guest", 1),
    offer("guest", 2),
  );
  expect(previous.closed).toBe(true);
  expect(descriptions()).toEqual([offer("guest", 2).description]);
});

it("preserves multiple roster and offer pairs within one inbound flush", async () => {
  mount(room());
  await deliver(
    snapshot(room("room", [participant("guest-a")])),
    offer("guest-a"),
    snapshot(room("room", [participant("guest-a"), participant("guest-b")])),
    offer("guest-b"),
  );
  expect(descriptions()).toEqual(
    expect.arrayContaining([
      offer("guest-a").description,
      offer("guest-b").description,
    ]),
  );
  expect(descriptions()).toHaveLength(2);
});

it("does not deliver a queued snapshot or offer from a retired socket", async () => {
  mount(room());
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    const socket = FakeWebSocket.instances[0];
    socket.deliver(snapshot(room("new-room", [participant("guest")])));
    socket.deliver(offer());
    socket.close(4403);
    flushInbound();
    await Promise.resolve();
  });
  expect(useRecordHostStore.getState().snapshot?.session_id).toBe("room");
  expect(descriptions()).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});
