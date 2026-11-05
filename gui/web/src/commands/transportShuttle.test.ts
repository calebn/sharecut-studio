import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const s = () => useDawStore.getState();

describe("transport.shuttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    clearRegisteredCommands();
    registerDawCommands();
    s().hydrate("/tmp/p.json", minimalProject({ tracks: [sampleTrack()] }));
    useDawStore.setState({ isPlaying: false, playheadSec: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("L plays a paused transport at 1x, then steps 2x, 4x and stays at 4x", async () => {
    await execute("transport.shuttle", { dir: "forward" });
    expect([s().isPlaying, s().playbackRate]).toEqual([true, 1]);
    await execute("transport.shuttle", { dir: "forward" });
    expect(s().playbackRate).toBe(2);
    await execute("transport.shuttle", { dir: "forward" });
    expect(s().playbackRate).toBe(4);
    await execute("transport.shuttle", { dir: "forward" });
    expect(s().playbackRate).toBe(4);
    expect(s().statusAnnouncement).toContain("4×");
  });

  it("Space, K and the end of media put the rate back to 1x", async () => {
    for (const reset of [
      () => execute("transport.togglePlay"),
      () => execute("transport.stop"),
      async () => s().setIsPlaying(false),
    ]) {
      await execute("transport.shuttle", { dir: "forward" });
      await execute("transport.shuttle", { dir: "forward" });
      expect(s().playbackRate).toBe(2);
      await reset();
      expect(s().playbackRate).toBe(1);
    }
  });

  it("a seek keeps the rate", async () => {
    await execute("transport.shuttle", { dir: "forward" });
    await execute("transport.shuttle", { dir: "forward" });
    await execute("transport.seek", { sec: 5 });
    expect(s().playbackRate).toBe(2);
  });

  it("J jumps back 3, 6 then 12 s inside a second, and keeps the play state", async () => {
    s().setPlayheadSec(40);
    await execute("transport.shuttle", { dir: "back" });
    expect(s().playheadSec).toBe(37);
    vi.advanceTimersByTime(500);
    await execute("transport.shuttle", { dir: "back" });
    expect(s().playheadSec).toBe(31);
    vi.advanceTimersByTime(500);
    await execute("transport.shuttle", { dir: "back" });
    expect(s().playheadSec).toBe(19);
    vi.advanceTimersByTime(500);
    await execute("transport.shuttle", { dir: "back" });
    expect(s().playheadSec).toBe(7);
    expect(s().isPlaying).toBe(false);
    vi.advanceTimersByTime(1500);
    await execute("transport.shuttle", { dir: "back" });
    expect(s().playheadSec).toBe(4);
  });

  it("J while playing at 4x drops to 1x and keeps playing", async () => {
    s().setPlayheadSec(40);
    for (let i = 0; i < 3; i++) {
      await execute("transport.shuttle", { dir: "forward" });
    }
    await execute("transport.shuttle", { dir: "back" });
    expect([s().isPlaying, s().playbackRate]).toEqual([true, 1]);
  });

  it("J never seeks before 0", async () => {
    s().setPlayheadSec(1);
    await execute("transport.shuttle", { dir: "back" });
    expect(s().playheadSec).toBe(0);
  });

  it("L while following keeps 2x and ends the follow", async () => {
    useDawStore.setState({
      followingClientId: "leader",
      isPlaying: true,
      playbackRate: 1,
    });
    await execute("transport.shuttle", { dir: "forward" });
    expect(s().followingClientId).toBeNull();
    expect(s().playbackRate).toBe(2);
  });

  it("is disabled without a project and for an unknown direction", async () => {
    expect(
      (await execute("transport.shuttle", { dir: "sideways" })).status,
    ).toBe("disabled");
    useDawStore.setState({ project: null });
    expect(
      (await execute("transport.shuttle", { dir: "forward" })).status,
    ).toBe("disabled");
  });
});
