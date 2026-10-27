import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import { pipelineConfig } from "../../test/pipelineConfigFixture";
import { useCleanup } from "./useCleanup";

function workingSet(config: Record<string, unknown>) {
  const update = vi.fn(async () => true);
  const set = {
    cfg: pipelineConfig({ config }),
    update,
  } as unknown as PipelineWorkingSet;
  return { set, update };
}

describe("useCleanup", () => {
  it("shows the project's tighten and loudness choice", () => {
    const { set } = workingSet({
      tighten: { intensity: "aggressive" },
      master: { integrated_lufs: -14 },
    });
    const { result } = renderHook(() => useCleanup(set));
    expect(result.current.cleanup).toEqual({
      tight: "tight",
      loudness: "streaming",
    });
  });

  it("saves a choice into the project's pipeline settings", () => {
    const { set, update } = workingSet({ tighten: { intensity: "medium" } });
    const { result } = renderHook(() => useCleanup(set));
    result.current.onCleanup({ tight: "tight", loudness: "broadcast" });
    expect(update).toHaveBeenCalledOnce();
    const recipe = (
      update.mock.calls[0] as unknown as [
        (c: { config: Record<string, unknown> }) => unknown,
      ]
    )[0];
    expect(recipe({ config: { tighten: { intensity: "medium" } } })).toEqual({
      config: {
        tighten: { intensity: "aggressive" },
        master: { integrated_lufs: -23 },
      },
    });
  });
});
