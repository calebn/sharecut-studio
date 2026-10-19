import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands, registerCommand } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import type { ExecuteResult } from "../commands/types";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { registerDawWebMcpTools } from "./webmcp";

type CapturedTool = {
  name: string;
  execute: (args: Record<string, unknown>) => unknown;
};

describe("DAW WebMCP tools", () => {
  let registered: CapturedTool[] = [];

  beforeEach(() => {
    registered = [];
    const registerTool = (tool: CapturedTool) => registered.push(tool);
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState(useDawStore.getInitialState(), true);
    useDawStore.setState({
      isPlaying: false,
      playStartSec: null,
      playheadSec: 0,
      timelineFocused: false,
      followingClientId: null,
      project: minimalProject({ timeline_duration_sec: 60 }),
    });
    registerDawWebMcpTools();
  });

  afterEach(() => {
    clearRegisteredCommands();
    Reflect.deleteProperty(navigator, "modelContext");
  });

  function playPause() {
    const tool = registered.find((tool) => tool.name === "play_pause");
    if (!tool) throw new Error("play_pause was not registered");
    return tool.execute({});
  }

  for (const [state, project, reason] of [
    ["loading", null, "Loading project…"],
    ["empty", minimalProject(), "Import audio to play."],
  ] as const) {
    it(`reports the ${state} refusal and leaves transport inert`, async () => {
      useDawStore.setState({ project, followingClientId: "leader" });

      await expect(playPause()).resolves.toEqual({
        status: "disabled",
        reason,
      });
      expect(useDawStore.getState().isPlaying).toBe(false);
      expect(useDawStore.getState().playStartSec).toBeNull();
      expect(useDawStore.getState().playheadSec).toBe(0);
      expect(useDawStore.getState().followingClientId).toBe("leader");
    });
  }

  it("reports successful Play and Pause for an imported track", async () => {
    useDawStore
      .getState()
      .setProject(minimalProject({ tracks: [sampleTrack()] }));
    useDawStore.getState().setPlayheadSec(8);

    await expect(playPause()).resolves.toEqual({ status: "ok" });
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().playStartSec).toBe(8);
    useDawStore.getState().setPlayheadSec(20);
    await expect(playPause()).resolves.toEqual({ status: "ok" });
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().playStartSec).toBe(8);
    expect(useDawStore.getState().playheadSec).toBe(20);
  });

  it("allows Pause after last-track removal and refuses Resume with its zero anchor intact", async () => {
    useDawStore
      .getState()
      .setProject(minimalProject({ tracks: [sampleTrack()] }));
    await expect(playPause()).resolves.toEqual({ status: "ok" });
    useDawStore.getState().setPlayheadSec(15);
    useDawStore.getState().setProject(minimalProject());

    await expect(playPause()).resolves.toEqual({ status: "ok" });
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().playStartSec).toBe(0);
    expect(useDawStore.getState().playheadSec).toBe(15);
    await expect(playPause()).resolves.toEqual({
      status: "disabled",
      reason: "Import audio to play.",
    });
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().playStartSec).toBe(0);
    expect(useDawStore.getState().playheadSec).toBe(15);
  });

  it("preserves an unknown command result", async () => {
    clearRegisteredCommands();
    await expect(playPause()).resolves.toEqual({ status: "unknown" });
  });

  for (const outcome of [
    { status: "ok" },
    { status: "disabled", reason: "Already announced.", announced: true },
  ] satisfies ExecuteResult[]) {
    it(`waits for and preserves a deferred ${outcome.status} result`, async () => {
      let release: (result: ExecuteResult) => void = () => undefined;
      const pendingCommand = new Promise<ExecuteResult>((resolve) => {
        release = resolve;
      });
      registerCommand("transport.togglePlay", () => pendingCommand);

      let settled = false;
      const reply = Promise.resolve(playPause()).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      release(outcome);
      await expect(reply).resolves.toEqual(outcome);
    });
  }

  for (const mode of ["throw", "reject"] as const) {
    it(`preserves the error identity when the command handler uses ${mode}`, async () => {
      const error = new Error("Playback failed.");
      registerCommand("transport.togglePlay", () => {
        if (mode === "throw") throw error;
        return Promise.reject(error);
      });

      await expect(playPause()).rejects.toBe(error);
    });
  }

  it("awaits the real seek command and reports the updated playhead", async () => {
    const seekTool = registered.find((tool) => tool.name === "seek_timeline");
    if (!seekTool) throw new Error("seek_timeline was not registered");

    await expect(seekTool.execute({ seconds: 35 })).resolves.toEqual({
      ok: true,
      seconds: 35,
    });
    expect(useDawStore.getState().playheadSec).toBe(35);
  });

  it("waits for the seek command before replying", async () => {
    let release: () => void = () => undefined;
    const pendingCommand = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerCommand("transport.seek", async () => {
      await pendingCommand;
      return { status: "ok" };
    });

    const seekTool = registered.find((tool) => tool.name === "seek_timeline");
    if (!seekTool) throw new Error("seek_timeline was not registered");

    let settled = false;
    const reply = Promise.resolve(seekTool.execute({ seconds: 35 })).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(reply).resolves.toEqual({ ok: true, seconds: 35 });
  });
});
