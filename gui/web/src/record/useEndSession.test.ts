import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revokeHostRoom = vi.fn();
vi.mock("../api", () => ({
  revokeHostRoom: (...args: unknown[]) => revokeHostRoom(...args),
}));

import { END_SESSION_UNDO_MS } from "./types";
import { useEndSession } from "./useEndSession";

const onEnded = vi.fn();
const onFailed = vi.fn();

type Props = {
  projectPath: string | null;
  sessionId: string | null;
  canEnd: boolean;
};
const base: Props = { projectPath: "/p", sessionId: "room1", canEnd: true };

const mountHook = (props: Props = base) =>
  renderHook((p: Props) => useEndSession({ ...p, onEnded, onFailed }), {
    initialProps: props,
  });

beforeEach(() => {
  vi.useFakeTimers();
  revokeHostRoom.mockReset();
  revokeHostRoom.mockResolvedValue(undefined);
  onEnded.mockReset();
  onFailed.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useEndSession", () => {
  it("revokes the room only after the undo window", async () => {
    const { result } = mountHook();
    act(() => result.current.end());
    expect(result.current.ending).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(END_SESSION_UNDO_MS - 1);
    });
    expect(revokeHostRoom).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(revokeHostRoom).toHaveBeenCalledWith("/p", "room1");
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(result.current.ending).toBe(false);
  });

  it("leaves the room untouched when undone", async () => {
    const { result } = mountHook();
    act(() => result.current.end());
    act(() => result.current.undo());
    expect(result.current.ending).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(END_SESSION_UNDO_MS * 2);
    });
    expect(revokeHostRoom).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("ends the room at once when the stage unmounts inside the window", () => {
    const { result, unmount } = mountHook();
    act(() => result.current.end());
    unmount();
    expect(revokeHostRoom).toHaveBeenCalledWith("/p", "room1");
  });

  it("withdraws the end when a take starts", async () => {
    const { result, rerender } = mountHook();
    act(() => result.current.end());
    rerender({ ...base, canEnd: false });
    expect(result.current.ending).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(END_SESSION_UNDO_MS * 2);
    });
    expect(revokeHostRoom).not.toHaveBeenCalled();
  });

  it("withdraws the end when another room replaces this one", async () => {
    const { result, rerender } = mountHook();
    act(() => result.current.end());
    rerender({ ...base, sessionId: "room2" });
    expect(result.current.ending).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(END_SESSION_UNDO_MS * 2);
    });
    expect(revokeHostRoom).not.toHaveBeenCalled();
  });

  it("does not start while a take is running or there is no room", () => {
    const running = mountHook({ ...base, canEnd: false });
    act(() => running.result.current.end());
    expect(running.result.current.ending).toBe(false);
    const none = mountHook({ ...base, sessionId: null });
    act(() => none.result.current.end());
    expect(none.result.current.ending).toBe(false);
  });

  it("is busy while the revoke is in flight and ignores a second press", async () => {
    let settle!: () => void;
    revokeHostRoom.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const { result } = mountHook();
    act(() => result.current.end());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(END_SESSION_UNDO_MS);
    });
    expect(result.current.busy).toBe(true);
    act(() => result.current.end());
    expect(result.current.ending).toBe(false);
    await act(async () => {
      settle();
    });
    expect(result.current.busy).toBe(false);
    expect(revokeHostRoom).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("does not report after the stage unmounted", async () => {
    revokeHostRoom.mockRejectedValue(new Error("offline"));
    const { result, unmount } = mountHook();
    act(() => result.current.end());
    unmount();
    expect(revokeHostRoom).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reports a failed revoke", async () => {
    revokeHostRoom.mockRejectedValue(new Error("offline"));
    const { result } = mountHook();
    act(() => result.current.end());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(END_SESSION_UNDO_MS);
    });
    expect(onFailed).toHaveBeenCalledWith("offline");
    expect(onEnded).not.toHaveBeenCalled();
  });
});
