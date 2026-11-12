import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useProjectMutation } from "./useProjectMutation";

function gate() {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("useProjectMutation", () => {
  it("stays busy until every overlapping run settles", async () => {
    const { result } = renderHook(() => useProjectMutation());
    const first = gate();
    const second = gate();
    let runs: Promise<unknown>[] = [];
    act(() => {
      runs = [
        result.current.run(() => first.wait),
        result.current.run(() => second.wait),
      ];
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      first.open();
      await runs[0];
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      second.open();
      await runs[1];
    });
    expect(result.current.busy).toBe(false);
  });
});

describe("useProjectMutation scope", () => {
  it("reports busy only under the scope that started the run", async () => {
    const { result, rerender } = renderHook(
      ({ scope }: { scope?: string }) => useProjectMutation(scope),
      { initialProps: { scope: "A" } },
    );
    const hold = gate();
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.run(() => hold.wait);
    });
    expect(result.current.busy).toBe(true);
    rerender({ scope: "B" });
    expect(result.current.busy).toBe(false);
    rerender({ scope: "A" });
    expect(result.current.busy).toBe(true);
    rerender({ scope: "B" });
    await act(async () => {
      hold.open();
      await pending;
    });
    expect(result.current.busy).toBe(false);
    rerender({ scope: "A" });
    expect(result.current.busy).toBe(false);
  });

  it("shows a failure only under the scope that started it", async () => {
    const { result, rerender } = renderHook(
      ({ scope }: { scope?: string }) => useProjectMutation(scope),
      { initialProps: { scope: "A" } },
    );
    const hold = gate();
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.run(async () => {
        await hold.wait;
        throw new Error("boom");
      });
    });
    rerender({ scope: "B" });
    await act(async () => {
      hold.open();
      await pending;
    });
    expect(result.current.error).toBeNull();
    rerender({ scope: "A" });
    expect(result.current.error).toBe("boom");
  });

  it("keeps hook-wide behaviour without a scope", async () => {
    const { result } = renderHook(() => useProjectMutation());
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("nope");
      });
    });
    expect(result.current.error).toBe("nope");
    expect(result.current.busy).toBe(false);
  });
});
