import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useRecordHostStore } from "./hostStore";
import { submitHostRecordTransport } from "./hostTransport";

const postHost = vi.fn();
const loadState = vi.fn();
const publishCloseGuard = vi.hoisted(() => vi.fn());

vi.mock("../desktop/useDesktopCloseGuard", () => ({
  publishDesktopCloseGuard: publishCloseGuard,
}));

vi.mock("../api", () => ({
  postHostRecordCommand: (...args: unknown[]) => postHost(...args),
  loadHostRecordState: (...args: unknown[]) => loadState(...args),
}));

describe("submitHostRecordTransport", () => {
  beforeEach(() => {
    postHost.mockReset();
    loadState.mockReset();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.setState({
      startPending: false,
    });
    publishCloseGuard.mockClear();
  });

  it("posts Start and stores the returned snapshot", async () => {
    postHost.mockResolvedValue({
      session_id: "room1",
      state: "recording",
      take_index: 0,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
    });
    await submitHostRecordTransport("Start");
    expect(postHost).toHaveBeenCalledWith("/tmp/p.json", "Start", {});
    expect(useRecordHostStore.getState().snapshot?.state).toBe("recording");
    expect(useRecordHostStore.getState().startPending).toBe(false);
  });

  it("arms the close guard before Start reaches the server", async () => {
    let finishStart: (value: unknown) => void = () => undefined;
    postHost.mockImplementationOnce(() => {
      expect(publishCloseGuard).toHaveBeenCalledWith(true, "host");
      expect(useRecordHostStore.getState().startPending).toBe(true);
      return new Promise((resolve) => {
        finishStart = resolve;
      });
    });
    const pending = submitHostRecordTransport("Start");
    expect(useRecordHostStore.getState().startPending).toBe(true);
    useRecordHostStore.getState().setSnapshot({
      session_id: "room1",
      state: "lobby",
      take_index: -1,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
    });
    expect(useRecordHostStore.getState().startPending).toBe(true);
    finishStart({
      session_id: "room1",
      state: "recording",
      take_index: 0,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
    });
    await pending;
    expect(useRecordHostStore.getState().startPending).toBe(false);
  });

  it("keeps the guard armed if Start may have succeeded but status is unavailable", async () => {
    useRecordHostStore.getState().setSnapshot({
      session_id: "room1",
      state: "lobby",
      take_index: -1,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
      server_time_ns: 100,
    });
    postHost.mockRejectedValueOnce(new Error("response lost"));
    loadState.mockRejectedValueOnce(new Error("status unavailable"));
    await expect(submitHostRecordTransport("Start")).rejects.toThrow(
      "status unavailable",
    );
    expect(useRecordHostStore.getState().startPending).toBe(true);
    useRecordHostStore.getState().setSnapshot({
      session_id: "room1",
      state: "lobby",
      take_index: -1,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
      server_time_ns: 100,
    });
    expect(useRecordHostStore.getState().startPending).toBe(true);
    useRecordHostStore.getState().setSnapshot({
      session_id: "room1",
      state: "stopped",
      take_index: 0,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
      server_time_ns: 101,
    });
    // A newer read is not proof that a delayed Start has finished.
    expect(useRecordHostStore.getState().startPending).toBe(true);
  });

  it("retains uncertainty when fallback reads lobby before Start commits", async () => {
    postHost.mockRejectedValueOnce(new Error("response lost"));
    loadState.mockResolvedValueOnce({
      session_id: "room1",
      state: "lobby",
      take_index: -1,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
    });
    await expect(submitHostRecordTransport("Start")).rejects.toThrow(
      "response lost",
    );
    expect(useRecordHostStore.getState().startPending).toBe(true);
  });

  it("ignores a stale Start after Pause has already stored a snapshot", async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    postHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    postHost.mockResolvedValueOnce({
      session_id: "room1",
      state: "paused",
      take_index: 0,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
    });
    const startP = submitHostRecordTransport("Start");
    await submitHostRecordTransport("Pause");
    expect(useRecordHostStore.getState().startPending).toBe(false);
    resolveStart({
      session_id: "room1",
      state: "recording",
      take_index: 0,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
    });
    await startP;
    expect(useRecordHostStore.getState().snapshot?.state).toBe("paused");
    expect(useRecordHostStore.getState().startPending).toBe(false);
  });

  it("heals a 400 when the session is already in the expected state", async () => {
    postHost.mockRejectedValueOnce(new Error("cannot start from recording"));
    loadState.mockResolvedValueOnce({
      session_id: "room1",
      state: "recording",
      take_index: 0,
      recording_ms: 0,
      start_blockers: [],
      participants: [],
      caps: { recorded: 4, producers: 2 },
    });
    await submitHostRecordTransport("Start");
    expect(useRecordHostStore.getState().snapshot?.state).toBe("recording");
  });
});
