import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { clipRow, minimalProject } from "../../test/fixtures";
import { usePlayerProps } from "./usePlayerProps";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate(
      "/tmp/player-props/episode.sharecut",
      minimalProject({ timeline_duration_sec: 100 }),
    );
  useDawStore.setState({ playheadSec: 0, guestMode: null });
});

describe("usePlayerProps onSeek", () => {
  it.each([null, "comment"] as const)(
    "moves the playhead to the fraction of the episode for guestMode %s",
    async (guestMode) => {
      useDawStore.setState({ guestMode });
      const { result } = renderHook(() =>
        usePlayerProps("expanded", () => undefined),
      );
      result.current.onSeek?.(0.4);
      await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(40));
      expect(result.current.duration).toBe(100);
    },
  );

  it("holds a fraction outside the episode to its ends", async () => {
    const { result } = renderHook(() =>
      usePlayerProps("expanded", () => undefined),
    );
    result.current.onSeek?.(1.5);
    await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(100));
  });

  it("reuses the episode end across playhead ticks and updates it when its inputs change", () => {
    const clipCount = 6_000;
    let endReads = 0;
    const clips = Array.from({ length: clipCount }, (_, index) => ({
      ...clipRow({
        id: `clip-${index}`,
        timeline_start: index,
      }),
      get timeline_end() {
        endReads += 1;
        return index + 1;
      },
    }));
    const project = minimalProject({
      timeline_duration_sec: 60,
      clips: { tracks: { "mira-voice": clips }, clip_count: clipCount },
      chapters: [{ title: "Middle", time: 3_000 }],
    });
    useDawStore.setState({ project });
    const { result } = renderHook(() =>
      usePlayerProps("expanded", () => undefined),
    );
    expect(result.current.duration).toBe(clipCount);
    expect(result.current.chapters?.[0]?.at).toBe(0.5);
    endReads = 0;

    for (const playheadSec of [1, 30, 90, 300, 800, 1_000])
      act(() => useDawStore.setState({ playheadSec }));
    expect(result.current.duration).toBe(clipCount);
    expect(endReads).toBe(0);

    act(() =>
      useDawStore.setState({
        project: { ...project, timeline_duration_sec: 7_500 },
      }),
    );
    expect(result.current.duration).toBe(7_500);
    expect(result.current.chapters?.[0]?.at).toBe(0.4);

    act(() =>
      useDawStore.setState({
        project: {
          ...project,
          clips: {
            tracks: { "mira-voice": [clipRow({ timeline_end: 4_000 })] },
            clip_count: 1,
          },
        },
      }),
    );
    expect(result.current.duration).toBe(4_000);
    expect(result.current.chapters?.[0]?.at).toBe(0.75);
  });

  describe("when a clip outlasts the stored duration", () => {
    beforeEach(() => {
      useDawStore.getState().hydrate(
        "/tmp/player-props/episode.sharecut",
        minimalProject({
          timeline_duration_sec: 60,
          clips: {
            tracks: { "mira-voice": [clipRow({ timeline_end: 90 })] },
            clip_count: 1,
          },
        }),
      );
    });

    it("reads, seeks and skips against the episode end", async () => {
      const { result } = renderHook(() =>
        usePlayerProps("expanded", () => undefined),
      );
      expect(result.current.duration).toBe(90);
      result.current.onSeek?.(1);
      await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(90));
      useDawStore.setState({ playheadSec: 55 });
      result.current.onSkip?.(15);
      await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(70));
    });

    it("places the chapter ticks on the same scale as the playhead", () => {
      useDawStore.getState().hydrate(
        "/tmp/player-props/episode.sharecut",
        minimalProject({
          timeline_duration_sec: 60,
          chapters: [{ title: "Outro", time: 45 }],
          clips: {
            tracks: { "mira-voice": [clipRow({ timeline_end: 90 })] },
            clip_count: 1,
          },
        }),
      );
      const { result } = renderHook(() =>
        usePlayerProps("expanded", () => undefined),
      );
      expect(result.current.chapters?.[0]?.at).toBe(0.5);
    });
  });
});
