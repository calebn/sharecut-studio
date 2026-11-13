import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { sortChapters } from "./playerModel";
import { usePlayerChapters } from "./usePlayerChapters";

vi.mock("./playerModel", async (importOriginal) => {
  const model = await importOriginal<typeof import("./playerModel")>();
  return { ...model, sortChapters: vi.fn(model.sortChapters) };
});

describe("usePlayerChapters", () => {
  beforeEach(() => {
    vi.mocked(sortChapters).mockClear();
    useDawStore.getState().hydrate(
      "/tmp/test/episode.sharecut",
      minimalProject({
        chapters: [
          { title: "Guest joins", time: 30 },
          { title: "Cold open", time: 0 },
        ],
      }),
    );
  });

  it("sorts the chapters once and follows the playhead without sorting again", () => {
    const { result } = renderHook(() => usePlayerChapters());
    expect(result.current.current).toBe(0);
    for (const sec of [5, 10, 31, 40])
      act(() => useDawStore.setState({ playheadSec: sec }));
    expect(result.current.current).toBe(1);
    expect(sortChapters).toHaveBeenCalledTimes(1);
  });
});
