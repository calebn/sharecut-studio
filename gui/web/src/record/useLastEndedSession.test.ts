import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordSessionSummary } from "./types";

const loadHostRecordSessions = vi.fn();
vi.mock("../api", () => ({
  loadHostRecordSessions: (...args: unknown[]) =>
    loadHostRecordSessions(...args),
}));

import { useLastEndedSession } from "./useLastEndedSession";

const session = (
  id: string,
  over: Partial<RecordSessionSummary> = {},
): RecordSessionSummary => ({
  session_id: id,
  number: 1,
  state: "ended",
  target_kind: null,
  takes: [{ take_index: 0, recording_ms: 1000 }],
  participants: [],
  landed: true,
  ended_at: "2026-10-25T10:00:00Z",
  ...over,
});

beforeEach(() => {
  loadHostRecordSessions.mockReset();
});

describe("useLastEndedSession", () => {
  it("picks the newest ended session with takes and ignores open ones", async () => {
    loadHostRecordSessions.mockResolvedValue([
      session("a"),
      session("b"),
      session("c", { takes: [], landed: false }),
      session("d", { state: "open" }),
    ]);
    const { result } = renderHook(() => useLastEndedSession("/p", true));
    await waitFor(() => expect(result.current?.session_id).toBe("b"));
  });

  it("does not fetch while disabled and refetches when enabled again", async () => {
    loadHostRecordSessions.mockResolvedValue([session("a")]);
    const { result, rerender } = renderHook(
      ({ on }) => useLastEndedSession("/p", on),
      { initialProps: { on: false } },
    );
    expect(loadHostRecordSessions).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    rerender({ on: true });
    await waitFor(() => expect(result.current?.session_id).toBe("a"));
    rerender({ on: false });
    expect(result.current).toBeNull();
    rerender({ on: true });
    await waitFor(() =>
      expect(loadHostRecordSessions).toHaveBeenCalledTimes(2),
    );
  });

  it("returns null on re-enable until the new fetch resolves", async () => {
    loadHostRecordSessions.mockResolvedValueOnce([session("old")]);
    const { result, rerender } = renderHook(
      ({ on }) => useLastEndedSession("/p", on),
      { initialProps: { on: true } },
    );
    await waitFor(() => expect(result.current?.session_id).toBe("old"));
    rerender({ on: false });
    let resolve: (v: RecordSessionSummary[]) => void = () => undefined;
    loadHostRecordSessions.mockReturnValueOnce(
      new Promise((r) => (resolve = r)),
    );
    rerender({ on: true });
    expect(result.current).toBeNull();
    resolve([session("new")]);
    await waitFor(() => expect(result.current?.session_id).toBe("new"));
  });

  it("ignores a response that lands after the project changed", async () => {
    let resolveFirst: (v: RecordSessionSummary[]) => void = () => undefined;
    loadHostRecordSessions
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce([session("second")]);
    const { result, rerender } = renderHook(
      ({ path }) => useLastEndedSession(path, true),
      { initialProps: { path: "/one" } },
    );
    rerender({ path: "/two" });
    await waitFor(() => expect(result.current?.session_id).toBe("second"));
    resolveFirst([session("first")]);
    await Promise.resolve();
    expect(result.current?.session_id).toBe("second");
  });

  it("ignores a response that lands after being disabled", async () => {
    let resolve: (v: RecordSessionSummary[]) => void = () => undefined;
    loadHostRecordSessions.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result, rerender } = renderHook(
      ({ on }) => useLastEndedSession("/p", on),
      { initialProps: { on: true } },
    );
    rerender({ on: false });
    resolve([session("late")]);
    await Promise.resolve();
    expect(result.current).toBeNull();
  });

  it("yields null when the fetch fails", async () => {
    loadHostRecordSessions.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useLastEndedSession("/p", true));
    await waitFor(() => expect(loadHostRecordSessions).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
