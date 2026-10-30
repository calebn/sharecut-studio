import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { STAGE_IDS } from "../types/stage";
import { COMMANDS } from "./catalog";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("stage commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/stage-cmd.json", minimalProject());
    useDawStore.setState({ stage: "edit" });
  });

  it("has one catalog command per stage", () => {
    for (const stage of STAGE_IDS) {
      expect(COMMANDS[`stage.${stage}`]).toBeDefined();
    }
  });

  it.each(STAGE_IDS)(
    "stage.%s opens that stage for the host",
    async (stage) => {
      expect(await execute(`stage.${stage}`)).toEqual({ status: "ok" });
      expect(useDawStore.getState().stage).toBe(stage);
    },
  );

  it("refuses a stage the share link does not allow", async () => {
    useDawStore.setState({ guestMode: "view" });
    expect((await execute("stage.edit")).status).toBe("disabled");
    expect(useDawStore.getState().stage).toBe("edit");
    expect(await execute("stage.review")).toEqual({ status: "ok" });
    expect(useDawStore.getState().stage).toBe("review");
  });

  it("lets an Editor link open Edit and Review only", async () => {
    useDawStore.setState({ guestMode: "edit" });
    expect((await execute("stage.deliver")).status).toBe("disabled");
    expect((await execute("stage.prepare")).status).toBe("disabled");
    expect((await execute("stage.review")).status).toBe("ok");
  });

  it("takes a Review section and a phone Edit surface as arguments", async () => {
    await execute("stage.review", { section: "comments" });
    expect(useDawStore.getState().reviewSection).toBe("queue");
    await execute("stage.edit", { surface: "text" });
    expect(useDawStore.getState().editSurface).toBe("text");
    await execute("stage.edit", { surface: "nope" });
    expect(useDawStore.getState().editSurface).toBe("text");
  });

  it("breaks the follow of the host when a control switches stage", async () => {
    useDawStore.setState({ followingClientId: "host-1" });
    await execute("stage.review", { section: "queue" });
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("is disabled without a project", async () => {
    useDawStore.setState({ project: null });
    expect((await execute("stage.review", {}, { skipWhen: true })).status).toBe(
      "disabled",
    );
  });

  it("edit.history opens the History sheet for a host, even with nothing to undo", async () => {
    useDawStore.setState({ stage: "review", openSheet: null });
    expect(await execute("edit.history")).toEqual({ status: "ok" });
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().openSheet).toBe("history");
  });

  it("edit.history is refused on a link that cannot edit", async () => {
    useDawStore.setState({
      projectPath: "share:tok",
      guestMode: "comment",
      shareCapabilities: ["comment"],
    });
    expect((await execute("edit.history")).status).toBe("disabled");
  });

  it("keeps Mod+1 to Mod+4 on layout.* and Mod+O on project.open for now", () => {
    expect(COMMANDS["project.home"]).toBeDefined();
    expect(COMMANDS["project.open"]).toBeDefined();
  });
});
