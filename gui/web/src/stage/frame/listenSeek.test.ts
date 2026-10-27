import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { skipListen } from "./listenSeek";

const SKIP_SEC = 15;

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
});
