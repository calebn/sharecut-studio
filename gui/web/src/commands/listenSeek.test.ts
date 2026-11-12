import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindPlaybackClock } from "../audio/playbackClock";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { SKIP_SEC } from "../utils/time";
import { clearRegisteredCommands } from "./execute";
import { skipListen } from "./listenSeek";
import { registerDawCommands } from "./register";

describe("skipListen", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({
      project: minimalProject({ timeline_duration_sec: 60 }),
    });
  });

  afterEach(() => {
    clearRegisteredCommands();
    useDawStore.setState({ playheadSec: 0 });
  });

  it.each([
    [10, -SKIP_SEC, 0],
    [40, -SKIP_SEC, 25],
    [50, SKIP_SEC, 60],
    [20, SKIP_SEC, 35],
  ])("from %s s by %s s seeks to %s s", (from, delta, to) => {
    useDawStore.setState({ playheadSec: from });
    skipListen(delta, 60);
    expect(useDawStore.getState().playheadSec).toBe(to);
  });

  it("skips from the audio clock when the store playhead is stale", () => {
    useDawStore.setState({
      project: minimalProject({ timeline_duration_sec: 200 }),
      playheadSec: 40,
    });
    const unbind = bindPlaybackClock(() => 100);
    skipListen(SKIP_SEC, 200);
    unbind();
    expect(useDawStore.getState().playheadSec).toBe(115);
  });
});
