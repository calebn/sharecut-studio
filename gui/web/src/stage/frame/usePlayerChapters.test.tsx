import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { clipRow, minimalProject } from "../../test/fixtures";
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

  it("places each chapter on the episode end, not the stored duration", () => {
    useDawStore.getState().hydrate(
      "/tmp/test/episode.sharecut",
      minimalProject({
        timeline_duration_sec: 60,
        chapters: [{ title: "Outro", time: 45 }],
        clips: {
          tracks: { "mira-voice": [clipRow({ timeline_end: 90 })] },
          clip_count: 1,
        },
      }),
    );
    const { result } = renderHook(() => usePlayerChapters());
    expect(result.current.chapters[0]?.at).toBe(0.5);
  });
});
