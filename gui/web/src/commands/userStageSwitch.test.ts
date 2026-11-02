import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withProgrammaticUi } from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import { clearRegisteredCommands, execute, registerCommand } from "./execute";
import { markUserStageSwitch, takeUserStageSwitch } from "./userStageSwitch";

beforeEach(() => {
  takeUserStageSwitch();
  useDawStore.setState({
    projectPath: "/tmp/ep",
    guestMode: null,
    project: { meta: { name: "t" }, tracks: [] } as never,
  });
});
afterEach(() => clearRegisteredCommands());

describe("userStageSwitch", () => {
  it("is taken once", () => {
    markUserStageSwitch();
    expect(takeUserStageSwitch()).toBe(true);
    expect(takeUserStageSwitch()).toBe(false);
  });

  it("ignores a mark made while a Follow leader drives", () => {
    withProgrammaticUi(() => markUserStageSwitch());
    expect(takeUserStageSwitch()).toBe(false);
  });

  it("is marked by running a stage command, not by another command", async () => {
    useDawStore.setState({ stage: "edit" });
    registerCommand("stage.review", () => {
      useDawStore.getState().openStage("review");
      return { status: "ok" as const };
    });
    await execute("stage.review", {}, { skipWhen: true });
    expect(takeUserStageSwitch()).toBe(true);
    registerCommand("stage.edit", () => ({ status: "ok" as const }));
    useDawStore.setState({ stage: "edit" });
    await execute("stage.edit", { surface: "text" }, { skipWhen: true });
    expect(takeUserStageSwitch()).toBe(false);
    registerCommand("view.toggleScript", () => ({ status: "ok" as const }));
    await execute("view.toggleScript", {}, { skipWhen: true });
    expect(takeUserStageSwitch()).toBe(false);
  });
});
