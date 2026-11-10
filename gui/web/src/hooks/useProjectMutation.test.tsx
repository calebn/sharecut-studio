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
