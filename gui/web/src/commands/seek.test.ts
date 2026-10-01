import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, registerCommand } from "./execute";
import { registerDawCommands } from "./register";
import { seekTransport } from "./seek";

describe("seekTransport", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({
      playheadSec: 25,
      followingClientId: "remote-editor",
      project: minimalProject({ timeline_duration_sec: 100 }),
    });
  });

  afterEach(() => {
    clearRegisteredCommands();
    useDawStore.setState({ playheadSec: 0, followingClientId: null });
  });

  it.each([
    [-5, 0],
    [140, 100],
  ])("clamps %s seconds to %s", async (sec, expected) => {
    expect(await seekTransport(sec)).toEqual({ status: "ok" });
    expect(useDawStore.getState().playheadSec).toBe(expected);
  });

  it("leaves the playhead unchanged for invalid seconds", async () => {
    expect(await seekTransport(Number.NaN)).toEqual({
      status: "disabled",
      reason: "sec must be a number",
    });
    expect(useDawStore.getState().playheadSec).toBe(25);
  });

  it("breaks follow after a successful local seek", async () => {
    await seekTransport(40);
    expect(useDawStore.getState().playheadSec).toBe(40);
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("returns the command result and preserves rejection", async () => {
    registerCommand("transport.seek", async () => {
      throw new Error("seek failed");
    });
    await expect(seekTransport(40)).rejects.toThrow("seek failed");
  });
});
