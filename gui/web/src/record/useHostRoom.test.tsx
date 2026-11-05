import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordState } from "../api";
import { executePointerCommand } from "../commands/pointer";
import { RecordStage } from "../stage/hosts/RecordStage";
import { deferred } from "../test/deferred";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { HostRoomProvider } from "./hostRoomContext";
import { useRecordHostStore } from "./hostStore";
import { useHostRoom } from "./useHostRoom";

const send = vi.fn();

vi.mock("../commands/pointer", async (importActual) => ({
  ...(await importActual<typeof import("../commands/pointer")>()),
  executePointerCommand: vi.fn(async () => ({ status: "ok" as const })),
}));

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
import { useRecordUpload } from "./upload/useRecordUpload";

vi.mock("./upload/useRecordUpload", async (importActual) => {
  const actual =
    await importActual<typeof import("./upload/useRecordUpload")>();
  return { ...actual, useRecordUpload: vi.fn(actual.useRecordUpload) };
});

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
    vi.mocked(executePointerCommand).mockReset();
    vi.mocked(executePointerCommand).mockResolvedValue({ status: "ok" });
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

  it("exposes the store's micLive", () => {
    const { result } = renderHook(() => useHostRoom());
    expect(result.current.micLive).toBe(false);
    act(() => useRecordHostStore.getState().setMicLive(true));
    expect(result.current.micLive).toBe(true);
    act(() => useRecordHostStore.getState().setMicLive(false));
  });

  it("forgets the room lookup when the project changes", async () => {
    vi.mocked(loadHostRecordState).mockResolvedValueOnce(
      recordSnapshot({ state: "lobby", participants: [host] }),
    );
    const { result } = renderHook(() => useHostRoom());
    await waitFor(() => expect(result.current.roomLookup).toBe("found"));
    vi.mocked(loadHostRecordState).mockReturnValue(
      new Promise(() => undefined),
    );
    act(() => useDawStore.setState({ projectPath: "/q" }));
    expect(result.current.roomLookup).toBe("checking");
    expect(result.current.doneNotice).toBeNull();
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

  it("retains failed lookup/error while disabled and resets only project presentation", async () => {
    vi.mocked(loadHostRecordState).mockRejectedValueOnce(
      new Error("lookup failed"),
    );
    const { result, rerender } = renderHook(
      ({ on }) => useHostRoom({}, { hydrate: on }),
      { initialProps: { on: true } },
    );
    await waitFor(() => expect(result.current.roomLookup).toBe("failed"));
    const live = recordSnapshot({ server_time_ns: 20, participants: [host] });
    act(() => useRecordHostStore.setState({ snapshot: live }));
    rerender({ on: false });
    expect(result.current.roomLookup).toBe("failed");
    expect(result.current.hydrateError).toBe("lookup failed");
    act(() => result.current.recheck());
    expect(loadHostRecordState).toHaveBeenCalledTimes(1);
    expect(result.current.hydrateError).toBe("lookup failed");
    act(() => useDawStore.setState({ projectPath: "/q" }));
    expect(result.current.roomLookup).toBe("checking");
    expect(result.current.hydrateError).toBe("lookup failed");
    expect(useRecordHostStore.getState().snapshot).toBe(live);
    const next = deferred<ReturnType<typeof recordSnapshot> | null>();
    vi.mocked(loadHostRecordState).mockReturnValueOnce(next.promise);
    rerender({ on: true });
    expect(loadHostRecordState).toHaveBeenCalledTimes(2);
    expect(result.current.hydrateError).toBeNull();
    expect(result.current.roomLookup).toBe("checking");
    await act(async () =>
      next.resolve(
        recordSnapshot({ server_time_ns: 10, participants: [host] }),
      ),
    );
    expect(result.current.roomLookup).toBe("found");
    expect(useRecordHostStore.getState().snapshot).toBe(live);
  });

  it("retains lookup while rechecking but lets a current null result clear a live snapshot", async () => {
    vi.mocked(loadHostRecordState).mockRejectedValueOnce(
      new Error("first failure"),
    );
    const { result } = renderHook(() => useHostRoom());
    await waitFor(() => expect(result.current.roomLookup).toBe("failed"));
    const first = deferred<ReturnType<typeof recordSnapshot> | null>();
    vi.mocked(loadHostRecordState).mockReturnValueOnce(first.promise);
    act(() => result.current.recheck());
    expect(result.current.roomLookup).toBe("failed");
    expect(result.current.hydrateError).toBeNull();
    await act(async () =>
      first.resolve(
        recordSnapshot({ server_time_ns: 10, participants: [host] }),
      ),
    );
    expect(result.current.roomLookup).toBe("found");
    const second = deferred<ReturnType<typeof recordSnapshot> | null>();
    vi.mocked(loadHostRecordState).mockReturnValueOnce(second.promise);
    act(() => result.current.recheck());
    expect(result.current.roomLookup).toBe("found");
    act(() =>
      useRecordHostStore.setState({
        snapshot: recordSnapshot({ server_time_ns: 30, participants: [host] }),
      }),
    );
    await act(async () => second.resolve(null));
    expect(result.current.roomLookup).toBe("none");
    expect(useRecordHostStore.getState().snapshot).toBeNull();
  });

  it.each(["resolve", "reject"])(
    "rejects a retired project's late hydration %s",
    async (settlement) => {
      const old = deferred<ReturnType<typeof recordSnapshot> | null>();
      const fresh = deferred<ReturnType<typeof recordSnapshot> | null>();
      vi.mocked(loadHostRecordState)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise);
      const { result } = renderHook(() => useHostRoom());
      act(() => useDawStore.setState({ projectPath: "/q" }));
      const accepted = recordSnapshot({
        session_id: "new-room",
        server_time_ns: 20,
        participants: [host],
      });
      await act(async () => fresh.resolve(accepted));
      expect(result.current.roomLookup).toBe("found");
      await act(async () => {
        if (settlement === "resolve")
          old.resolve(
            recordSnapshot({
              session_id: "old-room",
              server_time_ns: 30,
              participants: [host],
            }),
          );
        else old.reject(new Error("old failure"));
      });
      expect(useRecordHostStore.getState().snapshot).toBe(accepted);
      expect(result.current.hydrateError).toBeNull();
      expect(result.current.roomLookup).toBe("found");
      expect(loadHostRecordState).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a retired same-project recheck when responses settle out of order", async () => {
    vi.mocked(loadHostRecordState).mockResolvedValueOnce(
      recordSnapshot({ server_time_ns: 1, participants: [host] }),
    );
    const { result } = renderHook(() => useHostRoom());
    await waitFor(() => expect(result.current.roomLookup).toBe("found"));
    const old = deferred<ReturnType<typeof recordSnapshot> | null>();
    const fresh = deferred<ReturnType<typeof recordSnapshot> | null>();
    vi.mocked(loadHostRecordState)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    act(() => result.current.recheck());
    act(() => result.current.recheck());
    const accepted = recordSnapshot({
      server_time_ns: 20,
      participants: [host],
    });
    await act(async () => fresh.resolve(accepted));
    await act(async () =>
      old.resolve(recordSnapshot({ server_time_ns: 30, participants: [host] })),
    );
    expect(useRecordHostStore.getState().snapshot).toBe(accepted);
    expect(loadHostRecordState).toHaveBeenCalledTimes(3);
  });

  it("retains a completed command notice across hydration changes and clears it on project change", async () => {
    const { result, rerender } = renderHook(
      ({ on }) => useHostRoom({}, { hydrate: on }),
      { initialProps: { on: false } },
    );
    act(() => useDawStore.setState({ statusAnnouncement: "Link copied" }));
    await act(async () => result.current.runCommand("record.copyGuestLink"));
    expect(result.current.doneNotice).toBe("Link copied");
    const pending = deferred<ReturnType<typeof recordSnapshot> | null>();
    vi.mocked(loadHostRecordState).mockReturnValueOnce(pending.promise);
    rerender({ on: true });
    expect(result.current.doneNotice).toBe("Link copied");
    rerender({ on: false });
    expect(result.current.doneNotice).toBe("Link copied");
    act(() => useDawStore.setState({ projectPath: "/q" }));
    expect(result.current.doneNotice).toBeNull();
    await act(async () => pending.resolve(null));
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

  it("owes host files only for takes the host mic joined", async () => {
    const take = (ids: string[]) => ({
      take_index: 1,
      session_start_wall_ms: 0,
      session_start_iso: "2026-01-01T00:00:00Z",
      stopped_wall_ms: 5,
      consented_participant_ids: ids,
      pauses: [],
      segment_reports: {},
    });
    const expected = () =>
      vi.mocked(useRecordUpload).mock.lastCall?.[0].captureExpected;
    useRecordHostStore.setState({
      snapshot: recordSnapshot({
        state: "stopped",
        take_index: 1,
        participants: [host],
        takes: [take(["p_g"])],
      }),
    });
    const { rerender } = renderHook(() => useHostRoom());
    expect(expected()).toBe(false);
    useRecordHostStore.setState({
      snapshot: recordSnapshot({
        state: "stopped",
        take_index: 1,
        participants: [host],
        takes: [take(["p_host", "p_g"])],
      }),
    });
    rerender();
    expect(expected()).toBe(true);
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
