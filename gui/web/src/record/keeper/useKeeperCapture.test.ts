import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecordSnapshot } from "../types";
import { useKeeperCapture } from "./useKeeperCapture";

vi.mock("./graph", () => ({
  attachKeeperTap: vi.fn(async () => () => undefined),
}));

vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return {
    ...actual,
    createOpfsSink: vi.fn(async () => new actual.MemorySink()),
  };
});

const snap: RecordSnapshot = {
  session_id: "room1",
  state: "recording",
  take_index: 0,
  recording_ms: 0,
  participants: [],
  caps: { recorded: 4, producers: 2 },
};

const args = {
  role: "guest" as const,
  snapshot: snap,
  participantId: "p_g",
  muted: false,
  consented: true,
};

describe("useKeeperCapture", () => {
  it("does not start a session until enabled", () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({
        ...args,
        enabled: false,
        stream,
      }),
    );
    expect(result.current.recordingLocally).toBe(false);
  });

  it("flags recording locally after the session is writing", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({
        ...args,
        enabled: true,
        stream,
      }),
    );
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(true);
    });
    expect(result.current.error).toBeNull();
  });

  it("does not claim a local copy when OPFS is unavailable", async () => {
    const { createOpfsSink } = await import("./store");
    vi.mocked(createOpfsSink).mockRejectedValueOnce(
      new Error(
        "This browser cannot store a local keeper copy (OPFS unavailable).",
      ),
    );
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({
        ...args,
        enabled: true,
        stream,
      }),
    );
    await waitFor(() => {
      expect(result.current.error).toMatch(/OPFS unavailable/);
    });
    expect(result.current.recordingLocally).toBe(false);
  });

  it("does not error when resetKey remounts during an apply", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { rerender, result } = renderHook(
      ({ resetKey, muted }: { resetKey: number; muted: boolean }) =>
        useKeeperCapture({
          ...args,
          enabled: true,
          stream,
          resetKey,
          muted,
        }),
      { initialProps: { resetKey: 0, muted: false } },
    );
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(true);
    });
    rerender({ resetKey: 1, muted: true });
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });
});
