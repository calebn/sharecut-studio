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

  it("a seek while paused becomes the new start", async () => {
    const s = () => useDawStore.getState();
    s().setPlayheadSec(9);
    await execute("transport.togglePlay");
    await execute("transport.togglePlay");
    s().setPlayheadSec(34.78);
    await execute("transport.stop");
    expect(s().playheadSec).toBe(34.78);
  });

  it("forgets the start after Stop", async () => {
    const s = () => useDawStore.getState();
    s().setPlayheadSec(10);
    await execute("transport.togglePlay");
    s().setPlayheadSec(25);
    await execute("transport.stop");
    expect(s().playheadSec).toBe(10);
    expect(s().playStartSec).toBeNull();
    await execute("transport.stop");
    expect(s().playheadSec).toBe(10);
  });

  it("clamps the start to a timeline that shrank", async () => {
    const s = () => useDawStore.getState();
    s().setPlayheadSec(50);
    await execute("transport.togglePlay");
    const project = s().project;
    if (!project) throw new Error("project not loaded");
    useDawStore.setState({
      project: { ...project, timeline_duration_sec: 20 },
    });
    await execute("transport.stop");
    expect(s().playheadSec).toBe(20);
  });

  it("Stop without a loaded timeline length only clamps at 0", async () => {
    const s = () => useDawStore.getState();
    s().setPlayheadSec(50);
    await execute("transport.togglePlay");
    const project = s().project;
    if (!project) throw new Error("project not loaded");
    useDawStore.setState({
      project: { ...project, timeline_duration_sec: Number.NaN },
    });
    await execute("transport.stop");
    expect(s().playheadSec).toBe(50);
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
