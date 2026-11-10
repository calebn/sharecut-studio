import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { NO_PREVIEW_ERROR } from "../../utils/audioErrorLabel";
import { usePlayerProps } from "./usePlayerProps";

const STALE = {
  needs_rerender: true,
  reconciliation: { stale: false },
  premix: { exists: true },
} as const;

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
});

function join(guestMode: "view" | "comment" | "edit" | null, tracks = true) {
  useDawStore.getState().hydrate(
    guestMode ? "share:tok" : "/tmp/player-props/episode.sharecut",
    minimalProject({
      tracks: tracks ? [sampleTrack({ stem_is_fresh: true })] : [],
      render_status: STALE,
      timeline_duration_sec: 100,
    }),
    guestMode ?? undefined,
  );
  useDawStore.setState({ guestMode, audioError: null });
}

const props = () =>
  renderHook(() => usePlayerProps("bar", () => undefined)).result.current;

describe("usePlayerProps status for a guest", () => {
  it.each(["view", "comment", "edit"] as const)(
    "passes no mix status to a %s guest whose frozen mix the host has since edited",
    (mode) => {
      join(mode);
      expect(props().status).toBeUndefined();
    },
  );

  it("keeps No mix yet for a guest when Play found nothing to preview", () => {
    join("comment");
    useDawStore.setState({ audioError: NO_PREVIEW_ERROR });
    expect(props().status).toBe("No mix yet");
  });

  it("keeps the play-unavailable reason for a guest", () => {
    join("comment", false);
    const p = props();
    expect(p.status).toBe("Import audio to play.");
    expect(p.playUnavailable).toBe(true);
  });

  it("keeps the mix status for the host", () => {
    join(null);
    expect(props().status).toBe("Mix out of date");
    useDawStore.setState({ audioError: NO_PREVIEW_ERROR });
    expect(props().status).toBe("No mix yet");
  });
});
