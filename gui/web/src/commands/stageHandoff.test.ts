import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchKeymapCommands } from "../keymap/registry";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";
import { offerStageHandoff } from "./stageHandoff";

describe("stage.handoff", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/handoff.json", minimalProject());
    useDawStore.setState({ stage: "prepare" });
  });

  it("is on Mod+Enter", () => {
    const keys = { code: "", altKey: false, shiftKey: false };
    const ids = (event: { key: string; metaKey: boolean; ctrlKey: boolean }) =>
      matchKeymapCommands({ ...keys, ...event }).map((cmd) => cmd.id);
    expect(ids({ key: "Enter", metaKey: true, ctrlKey: false })).toEqual([
      "stage.handoff",
    ]);
    expect(ids({ key: "Enter", metaKey: false, ctrlKey: false })).toEqual([]);
  });

  it("runs the open stage's hand-off", async () => {
    const run = vi.fn();
    const withdraw = offerStageHandoff({ run });
    expect(await execute("stage.handoff")).toEqual({ status: "ok" });
    expect(run).toHaveBeenCalledOnce();
    withdraw();
  });

  it("says why the hand-off cannot run, and runs nothing", async () => {
    const run = vi.fn();
    const withdraw = offerStageHandoff({
      run,
      disabledReason: "Still getting ready",
    });
    expect(await execute("stage.handoff")).toEqual({
      status: "disabled",
      reason: "Still getting ready",
    });
    expect(run).not.toHaveBeenCalled();
    withdraw();
  });

  it("does nothing, and announces nothing, once the stage has withdrawn its hand-off", async () => {
    const run = vi.fn();
    offerStageHandoff({ run })();
    expect(await execute("stage.handoff")).toEqual({ status: "ok" });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a newer stage's hand-off when an older one is withdrawn late", async () => {
    const older = offerStageHandoff({ run: vi.fn() });
    const run = vi.fn();
    const newer = offerStageHandoff({ run });
    older();
    expect(await execute("stage.handoff")).toEqual({ status: "ok" });
    expect(run).toHaveBeenCalledOnce();
    newer();
  });
});
