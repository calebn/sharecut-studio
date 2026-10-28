import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordState } from "../api";
import { RecordStage } from "../stage/hosts/RecordStage";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { HostRoomProvider } from "./hostRoomContext";
import { useRecordHostStore } from "./hostStore";
import { useHostRoom } from "./useHostRoom";

const send = vi.fn();

vi.mock("./hostWire", () => ({
  sendRecordHostCommand: (...args: unknown[]) => send(...args),
}));

vi.mock("../api", () => ({
  loadHostRecordState: vi.fn(async () => null),
  hostRecordUploadTransport: () => ({
    status: async () => ({ segments: [] }),
    put: async () => ({
      acked: true,
      take_index: 0,
      participant_id: "p_host",
      segment_index: 0,
      part_seq: 0,
      file_ack: false,
    }),
  }),
}));

vi.mock("./hostKeeperStorage", () => ({
  prepareHostKeeperStorage: vi.fn(async () => undefined),
  retryHostKeeperStorage: vi.fn(async () => undefined),
}));

import { useDawStore } from "../state/dawStore";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Hana",
});

describe("useHostRoom", () => {
  beforeEach(() => {
    vi.mocked(loadHostRecordState).mockClear();
    vi.mocked(loadHostRecordState).mockResolvedValue(null);
    send.mockClear();
    useRecordHostStore.setState({
      snapshot: null,
      connected: false,
      dropped: false,
      transportError: null,
      captureHealth: null,
    });
    useDawStore.setState({ projectPath: "/p" });
  });

  it("hydrates without any panel open and reports no room", async () => {
    const { result } = renderHook(() => useHostRoom());
    expect(result.current.roomLookup).toBe("checking");
    await waitFor(() => expect(result.current.roomLookup).toBe("none"));
    expect(loadHostRecordState).toHaveBeenCalledWith("/p");
  });

  it("does not hydrate when disabled", async () => {
    renderHook(() => useHostRoom({}, { hydrate: false }));
    await act(async () => undefined);
    expect(loadHostRecordState).not.toHaveBeenCalled();
  });

  it("fetches once when hydration turns on", async () => {
    const { rerender } = renderHook(
      ({ on }) => useHostRoom({}, { hydrate: on }),
      { initialProps: { on: false } },
    );
    await act(async () => undefined);
    expect(loadHostRecordState).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(loadHostRecordState).toHaveBeenCalledTimes(1));
    rerender({ on: true });
    await act(async () => undefined);
    expect(loadHostRecordState).toHaveBeenCalledTimes(1);
  });

  it("applies a found snapshot and rechecks on demand", async () => {
    const snap = recordSnapshot({
      state: "lobby",
      participants: [host],
    });
    vi.mocked(loadHostRecordState).mockResolvedValue(snap);
    const { result } = renderHook(() => useHostRoom());
    await waitFor(() => expect(result.current.roomLookup).toBe("found"));
    expect(result.current.host?.display_name).toBe("Hana");
    act(() => result.current.recheck());
    await waitFor(() => expect(loadHostRecordState).toHaveBeenCalledTimes(2));
  });

  it("reports a failed lookup", async () => {
    vi.mocked(loadHostRecordState).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useHostRoom());
    await waitFor(() => expect(result.current.roomLookup).toBe("failed"));
    expect(result.current.hydrateError).toBe("boom");
  });

  it("derives mic-loss attention only while on air", async () => {
    useRecordHostStore.setState({
      snapshot: recordSnapshot({ state: "recording", participants: [host] }),
    });
    const { result, rerender } = renderHook(
      ({ lost }) => useHostRoom({ micLost: lost }),
      { initialProps: { lost: true } },
    );
    expect(result.current.micLossNeedsAttention).toBe(true);
    rerender({ lost: false });
    expect(result.current.micLossNeedsAttention).toBe(false);
    await act(async () => undefined);
  });

  it("sends mute through the host wire", async () => {
    const { result } = renderHook(() => useHostRoom());
    result.current.setMuted(true);
    expect(send).toHaveBeenCalledWith("SetMuted", { muted: true });
    await act(async () => undefined);
  });

  it("clears a stored transport error when it unmounts", async () => {
    useRecordHostStore.setState({ transportError: "x" });
    const { unmount } = renderHook(() => useHostRoom());
    unmount();
    expect(useRecordHostStore.getState().transportError).toBeNull();
  });

  it("lets the Record stage read the provided room without hydrating itself", async () => {
    const Harness = () => {
      const room = useHostRoom({}, { hydrate: false });
      return (
        <HostRoomProvider value={room}>
          <RecordStage />
        </HostRoomProvider>
      );
    };
    render(<Harness />);
    await act(async () => undefined);
    expect(loadHostRecordState).not.toHaveBeenCalled();
  });
});
