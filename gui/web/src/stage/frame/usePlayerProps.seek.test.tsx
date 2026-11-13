import { renderHook, waitFor } from "@testing-library/react";
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
