import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { Suspense, startTransition, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../../test/deferred";
import type { RecordSnapshot } from "../types";
import type { RecordMeshOpts } from "./mesh";
import { useRecordMonitor } from "./useRecordMonitor";

const fixture = vi.hoisted(() => ({
  meshes: [] as RecordMeshOpts[],
  dispose: vi.fn(),
  roster: vi.fn(),
  muted: vi.fn(),
}));
vi.mock("./mesh", () => ({
  RecordMesh: class {
    constructor(options: RecordMeshOpts) {
      fixture.meshes.push(options);
    }
    dispose = fixture.dispose;
    syncPeers = fixture.roster;
    setLocalStream() {}
    setSendEnabled() {}
    async handleSignal() {}
  },
}));
vi.mock("../../audio/mixMinus", () => ({
  MIX_MINUS_RAMP_S: 0,
  MixMinusGraph: class {
    setRemoteMuted = fixture.muted;
    disconnectLocal() {}
    addRemote() {}
    dispose() {}
  },
}));
vi.mock("../../utils/audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/audio")>()),
  audioContextCtor: () =>
    class {
      async resume() {}
      async close() {}
    },
}));

function room(muted = false): RecordSnapshot {
  return {
    session_id: "room",
    state: "lobby",
    take_index: 0,
    caps: { recorded: 4, producers: 2 },
    participants: [
      {
        participant_id: "peer",
        role: "guest",
        display_name: "Ava",
        connected: true,
        consented: true,
        muted,
        headphones_ack: true,
      },
    ],
  };
}
const initialRoom = room();

beforeEach(() => {
  fixture.meshes.length = 0;
  vi.clearAllMocks();
});

it("retains the monitor owner while publishing a committed sender and roster", () => {
  const first = vi.fn();
  const second = vi.fn();
  const { rerender } = renderHook(
    ({ send, snapshot }) =>
      useRecordMonitor({
        enabled: true,
        localId: "me",
        role: "guest",
        snapshot,
        localStream: null,
        muted: false,
        send,
      }),
    { initialProps: { send: first, snapshot: initialRoom } },
  );
  expect(fixture.meshes).toHaveLength(1);
  const mesh = fixture.meshes[0];
  mesh.send({ to: "peer", candidate: null });
  expect(first).toHaveBeenCalledTimes(1);
  rerender({ send: second, snapshot: room(true) });
  expect(fixture.meshes).toHaveLength(1);
  expect(fixture.dispose).not.toHaveBeenCalled();
  mesh.send({ to: "peer", candidate: null });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(fixture.muted).toHaveBeenLastCalledWith("peer", true);
  expect(fixture.roster).toHaveBeenLastCalledWith([{ id: "peer", gen: 0 }]);
});

it("does not publish a sender from an attempted suspended render", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const pending = deferred();
  const consumedGate = vi.spyOn(pending.promise, "then");
  function Probe({ tentative }: { tentative: boolean }) {
    useRecordMonitor({
      enabled: true,
      localId: "me",
      role: "guest",
      snapshot: initialRoom,
      localStream: null,
      muted: false,
      send: tentative ? second : first,
    });
    if (tentative) throw pending.promise;
    return <p>Committed monitor</p>;
  }
  function Host() {
    const [tentative, setTentative] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => startTransition(() => setTentative(true))}
        >
          Attempt
        </button>
        <button type="button" onClick={() => setTentative(false)}>
          Keep committed
        </button>
        <Suspense fallback={<p>Loading monitor</p>}>
          <Probe tentative={tentative} />
        </Suspense>
      </>
    );
  }
  render(<Host />);
  expect(fixture.meshes).toHaveLength(1);
  const mesh = fixture.meshes[0];
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Attempt" }));
  });
  expect(consumedGate).toHaveBeenCalled();
  expect(screen.queryByText("Loading monitor")).not.toBeInTheDocument();
  expect(screen.getByText("Committed monitor")).toBeInTheDocument();
  mesh.send({ to: "peer", candidate: null });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep committed" }));
  expect(fixture.meshes).toHaveLength(1);
  expect(fixture.dispose).not.toHaveBeenCalled();
});
