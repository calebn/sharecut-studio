import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useRecordHostStore } from "./hostStore";
import { submitHostRecordTransport } from "./hostTransport";

const postHost = vi.fn();
const loadState = vi.fn();

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
