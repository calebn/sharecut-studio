import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, registerCommand } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { registerDawWebMcpTools, registerReviewWebMcpTools } from "./webmcp";

type CapturedTool = {
  name: string;
  execute: (args: Record<string, unknown>) => unknown;
};

describe("review WebMCP tools", () => {
  it("no-ops when modelContext is missing", () => {
    const cleanup = registerReviewWebMcpTools({
      playPause: vi.fn(),
      seek: vi.fn(),
      canComment: false,
      addComment: vi.fn(),
    });
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("registers tools when modelContext.registerTool exists", () => {
    const registerTool = vi.fn();
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
    registerReviewWebMcpTools({
      playPause: vi.fn(),
      seek: vi.fn(),
      canComment: true,
      addComment: vi.fn(),
    });
    expect(registerTool).toHaveBeenCalled();
    const names = registerTool.mock.calls.map((c) => c[0].name);
    expect(names).toEqual(
      expect.arrayContaining(["play_pause", "seek_timeline", "add_comment"]),
    );
    Reflect.deleteProperty(navigator, "modelContext");
  });
});

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
    useDawStore.setState({
      playheadSec: 0,
      project: minimalProject({ timeline_duration_sec: 60 }),
    });
    registerDawWebMcpTools();
  });

  afterEach(() => {
    clearRegisteredCommands();
    Reflect.deleteProperty(navigator, "modelContext");
  });

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
