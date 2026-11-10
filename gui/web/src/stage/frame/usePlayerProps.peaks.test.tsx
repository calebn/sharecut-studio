import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { usePlayerProps } from "./usePlayerProps";

const PEAKS = [0.1, 0.8, 1, 0.4];

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate(
      "/tmp/player-props/episode.sharecut",
      minimalProject({ timeline_duration_sec: 100 }),
    );
  useDawStore.setState({ guestMode: null, reviewPeaks: PEAKS });
});

describe("usePlayerProps peaks", () => {
  it.each(["comment", "view"] as const)(
    "gives a %s guest the review peaks for the overview strip",
    (guestMode) => {
      useDawStore.setState({ guestMode });
      const { result } = renderHook(() =>
        usePlayerProps("expanded", () => undefined),
      );
      expect(result.current.peaks).toEqual(PEAKS);
    },
  );

  it("leaves a host's strip alone even when review peaks are in the store", () => {
    const { result } = renderHook(() =>
      usePlayerProps("expanded", () => undefined),
    );
    expect(result.current.peaks).toBeUndefined();
  });

  it("gives a guest no peaks until some have loaded", () => {
    useDawStore.setState({ guestMode: "comment", reviewPeaks: [] });
    const { result } = renderHook(() =>
      usePlayerProps("expanded", () => undefined),
    );
    expect(result.current.peaks ?? []).toEqual([]);
  });
});
