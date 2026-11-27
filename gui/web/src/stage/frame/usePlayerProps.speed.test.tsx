import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberFrozenReview } from "../../api/project";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import {
  minimalProject,
  sampleTrack,
  sessionRoster,
} from "../../test/fixtures";
import { usePlayerProps } from "./usePlayerProps";

const s = () => useDawStore.getState();

function open(path: string) {
  s().hydrate(
    path,
    minimalProject({
      tracks: [sampleTrack({ stem_is_fresh: true })],
      timeline_duration_sec: 100,
    }),
  );
}

const props = (form: "bar" | "dock" | "expanded" = "bar") =>
  renderHook(() => usePlayerProps(form, () => undefined)).result.current;

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({
    chosenPlaybackRate: 1,
    followingClientId: null,
    shellBreakpoint: "desktop",
  });
  open("/tmp/player-props/speed.sharecut");
});

afterEach(() => {
  rememberFrozenReview("tok", false);
  useDawStore.setState({
    chosenPlaybackRate: 1,
    playbackRate: 1,
    shellBreakpoint: "desktop",
  });
  localStorage.clear();
});

describe("usePlayerProps speed", () => {
  it("passes the chosen speed, the next preset and no scan", () => {
    s().setPlaybackSpeed(1.5);
    expect(props().speed).toMatchObject({
      rate: 1.5,
      next: 2,
      scan: false,
      disabledReason: undefined,
    });
  });

  it("marks a shuttle scan and shows its rate", () => {
    s().setPlaybackSpeed(1.5);
    act(() => useDawStore.setState({ playbackRate: 4 }));
    expect(props().speed).toMatchObject({ rate: 4, next: 2, scan: true });
  });

  it("pressing it cycles the stored speed and announces it", () => {
    props().speed?.onCycle();
    expect(s().chosenPlaybackRate).toBe(1.25);
    expect(s().statusAnnouncement).toBe("Playback speed 1.25×");
  });

  it("is absent on the phone bar and present on the phone dock and expanded card", () => {
    useDawStore.setState({ shellBreakpoint: "phone" });
    expect(props("bar").speed).toBeUndefined();
    expect(props("dock").speed).toBeDefined();
    expect(props("expanded").speed).toBeDefined();
  });

  it("is disabled with the leader's name while following, showing their rate", () => {
    s().setPlaybackSpeed(1.5);
    useDawStore.setState({
      followingClientId: "leader",
      playbackRate: 1.02,
      sessionClients: sessionRoster([
        {
          client_id: "leader",
          role: "viewer",
          last_seen_ns: 1,
          meta: { display_name: "Maya", color_index: 2 },
        },
      ]),
    });
    expect(props().speed).toMatchObject({
      rate: 1,
      scan: false,
      disabledReason: "Following Maya. Speed follows them.",
    });
  });

  it("is disabled with its reason on a link to the live episode", () => {
    open("share:tok");
    expect(props("dock").speed).toMatchObject({
      rate: 1,
      disabledReason: "Speed isn't available on live-episode links yet.",
    });
  });

  it("is enabled on a review link that plays a published version", () => {
    rememberFrozenReview("tok", true);
    open("share:tok");
    s().setPlaybackSpeed(2);
    expect(props("dock").speed).toMatchObject({
      rate: 2,
      disabledReason: undefined,
    });
  });
});
