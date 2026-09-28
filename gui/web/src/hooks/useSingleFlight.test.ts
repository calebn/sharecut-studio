import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";
import { useSingleFlight } from "./useSingleFlight";

describe("useSingleFlight", () => {
  it("is busy while a task is pending and resolves its value", async () => {
    const { result } = renderHook(() => useSingleFlight());
    expect(result.current.busy).toBe(false);

    const task = deferred<number>();
    let runPromise!: Promise<number | undefined>;
    act(() => {
      runPromise = result.current.run(() => task.promise);
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    act(() => {
      task.resolve(42);
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(await runPromise).toBe(42);
  });

  it("drops a second run before busy re-renders (double click)", async () => {
    const { result } = renderHook(() => useSingleFlight());
    const task = deferred<number>();
    const second = vi.fn().mockResolvedValue(99);

    let firstPromise!: Promise<number | undefined>;
    let secondPromise!: Promise<number | undefined>;
    act(() => {
      firstPromise = result.current.run(() => task.promise);
      secondPromise = result.current.run(second);
    });

    expect(second).not.toHaveBeenCalled();
    expect(await secondPromise).toBeUndefined();

    act(() => {
      task.resolve(1);
    });
    expect(await firstPromise).toBe(1);
  });

  it("guards the whole async span, not just the synchronous start", async () => {
    const { result } = renderHook(() => useSingleFlight());
    const stepA = deferred<void>();
    const stepB = deferred<void>();
    const second = vi.fn().mockResolvedValue(2);

    let firstPromise!: Promise<number | undefined>;
    act(() => {
      firstPromise = result.current.run(async () => {
        await stepA.promise;
        await stepB.promise;
        return 1;
      });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    let secondPromise!: Promise<number | undefined>;
    await act(async () => {
      stepA.resolve();
      secondPromise = result.current.run(second);
      await Promise.resolve();
    });

    expect(second).not.toHaveBeenCalled();
    expect(await secondPromise).toBeUndefined();
    expect(result.current.busy).toBe(true);

    act(() => {
      stepB.resolve();
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(await firstPromise).toBe(1);

    const third = vi.fn().mockResolvedValue(3);
    let thirdPromise!: Promise<number | undefined>;
    act(() => {
      thirdPromise = result.current.run(third);
    });
    expect(third).toHaveBeenCalledTimes(1);
    expect(await thirdPromise).toBe(3);
  });

  it("propagates a rejection and clears busy so the next run executes", async () => {
    const { result } = renderHook(() => useSingleFlight());
    const failing = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      act(async () => {
        await result.current.run(failing);
      }),
    ).rejects.toThrow("boom");
    await waitFor(() => expect(result.current.busy).toBe(false));

    const next = vi.fn().mockResolvedValue("ok");
    let nextPromise!: Promise<string | undefined>;
    act(() => {
      nextPromise = result.current.run(next);
    });
    expect(await nextPromise).toBe("ok");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the task resolves after unmount", async () => {
    const { result, unmount } = renderHook(() => useSingleFlight());
    const task = deferred<number>();
    let runPromise!: Promise<number | undefined>;
    act(() => {
      runPromise = result.current.run(() => task.promise);
    });

    unmount();

    expect(() => task.resolve(7)).not.toThrow();
    await expect(runPromise).resolves.toBe(7);
  });
});
