import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("transport.stop", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("returns to where playback started (#533)", async () => {
    const s = () => useDawStore.getState();
    s().setPlayheadSec(10);
    await execute("transport.togglePlay");
    s().setPlayheadSec(25);
    await execute("transport.stop");
    expect(s().isPlaying).toBe(false);
    expect(s().playheadSec).toBe(10);
  });

  it("Pause keeps the position; a later Stop still returns", async () => {
    const s = () => useDawStore.getState();
    s().setPlayheadSec(10);
    await execute("transport.togglePlay");
    s().setPlayheadSec(25);
    await execute("transport.togglePlay");
    expect(s().playheadSec).toBe(25);
    await execute("transport.stop");
    expect(s().playheadSec).toBe(10);
  });

  it("keeps the playhead when nothing has played", async () => {
    useDawStore.setState({ playStartSec: null });
    useDawStore.getState().setPlayheadSec(30);
    await execute("transport.stop");
    expect(useDawStore.getState().playheadSec).toBe(30);
  });

  it("is disabled without a project", async () => {
    useDawStore.setState({ project: null });
    expect((await execute("transport.stop")).status).toBe("disabled");
  });
});
