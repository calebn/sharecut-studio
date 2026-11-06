import { beforeEach, describe, expect, it, vi } from "vitest";
import { rangeEditMode } from "../shareMode";
import { paletteCommands } from "../stage/dialogs/commandPaletteRows";
import { useDawStore } from "../state/dawStore";
import { playheadScrollRegistry } from "../state/playheadScrollRegistry";
import { minimalProject } from "../test/fixtures";
import { STAGE_IDS } from "../types/stage";
import { COMMANDS } from "./catalog";
import { buildCommandContext, evaluateWhen } from "./context";
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

  it("lets an Editor link open Edit, Review and Deliver but not Prepare", async () => {
    useDawStore.setState({ guestMode: "edit" });
    expect((await execute("stage.deliver")).status).toBe("ok");
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

  describe("re-selecting the active Edit stage", () => {
    const scrollers = (script: boolean, timeline: boolean) => {
      const onScript = vi.fn(() => script);
      const onTimeline = vi.fn(() => timeline);
      const offs = [
        playheadScrollRegistry.register("script", onScript),
        playheadScrollRegistry.register("timeline", onTimeline),
      ];
      return { onScript, onTimeline, off: () => offs.forEach((o) => o()) };
    };

    it("scrolls the Script and the Timeline to the playhead and says so", async () => {
      const { onScript, onTimeline, off } = scrollers(true, true);
      expect(await execute("stage.edit")).toEqual({ status: "ok" });
      expect(onScript).toHaveBeenCalledTimes(1);
      expect(onTimeline).toHaveBeenCalledTimes(1);
      expect(useDawStore.getState().feedbackToast?.message).toBe(
        "Scrolled to playhead",
      );
      off();
    });

    it("stays silent when no surface scrolled", async () => {
      const { onScript, off } = scrollers(false, false);
      useDawStore.setState({ feedbackToast: null });
      await execute("stage.edit");
      expect(onScript).toHaveBeenCalledTimes(1);
      expect(useDawStore.getState().feedbackToast).toBeNull();
      off();
    });

    it("does not scroll when switching to Edit from another stage", async () => {
      const { onScript, onTimeline, off } = scrollers(true, true);
      useDawStore.setState({ stage: "review" });
      await execute("stage.edit");
      expect(onScript).not.toHaveBeenCalled();
      expect(onTimeline).not.toHaveBeenCalled();
      off();
    });

    it("does not scroll when re-selecting another stage", async () => {
      const { onScript, onTimeline, off } = scrollers(true, true);
      useDawStore.setState({ stage: "review" });
      await execute("stage.review");
      expect(onScript).not.toHaveBeenCalled();
      expect(onTimeline).not.toHaveBeenCalled();
      off();
    });

    it.each([{ sheet: "history" }, { section: "queue" }, { surface: "text" }])(
      "does not scroll when the call carries %j",
      async (args) => {
        const { onScript, onTimeline, off } = scrollers(true, true);
        await execute("stage.edit", args);
        expect(onScript).not.toHaveBeenCalled();
        expect(onTimeline).not.toHaveBeenCalled();
        off();
      },
    );
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

  const RANGE_EDITS = [
    "range.cut",
    "range.mute",
    "range.fillRoomTone",
  ] as const;
  const OFF_EDIT = STAGE_IDS.filter((s) => s !== "edit");

  it.each(RANGE_EDITS.flatMap((id) => OFF_EDIT.map((st) => [id, st] as const)))(
    "%s is disabled on %s",
    async (id, stage) => {
      useDawStore.setState({ stage });
      expect(await execute(id)).toEqual({
        status: "disabled",
        reason: "Open Edit to change the timeline",
      });
    },
  );

  it.each(RANGE_EDITS)("%s is not stage-disabled on edit", async (id) => {
    const r = await execute(id);
    expect(
      r.status === "disabled" &&
        r.reason === "Open Edit to change the timeline",
    ).toBe(false);
  });
  const STAGE_REASON = "Open Edit to change the timeline";
  const SUGGESTABLE = ["range.cut", "range.mute"] as const;
  const ROLES = {
    commenter: [
      "comment",
      ["play", "view", "comment", "reply", "action", "suggest"],
    ],
    editor: [
      "edit",
      ["play", "view", "comment", "reply", "action", "suggest", "edit"],
    ],
    commentOnly: ["comment", ["comment", "view"]],
    viewer: ["view", ["view"]],
    noCaps: ["comment", null],
  } as const;
  function as(role: keyof typeof ROLES, stage: (typeof STAGE_IDS)[number]) {
    const [guestMode, shareCapabilities] = ROLES[role];
    useDawStore.setState({
      projectPath: "share:tok",
      guestMode,
      shareCapabilities: shareCapabilities ? [...shareCapabilities] : null,
      stage,
    });
    return buildCommandContext();
  }
  const rowReason = (id: string) =>
    paletteCommands(buildCommandContext()).find((r) => r.id === id)
      ?.disabledReason;

  it.each(SUGGESTABLE)(
    "%s is enabled for a suggest-only link on Review",
    (id) => {
      const ctx = as("commenter", "review");
      expect(evaluateWhen(COMMANDS[id].when, ctx)).toEqual({ ok: true });
      expect(rowReason(id)).toBeNull();
    },
  );

  it.each(
    RANGE_EDITS.flatMap((id) =>
      (["review", "deliver"] as const).map((st) => [id, st] as const),
    ),
  )("%s stays stage-disabled for an Editor link on %s", (id, stage) => {
    as("editor", stage);
    expect(rowReason(id)).toBe(STAGE_REASON);
  });

  it.each(RANGE_EDITS)("%s is enabled for an Editor link on Edit", (id) => {
    as("editor", "edit");
    expect(rowReason(id)).toBeNull();
  });

  it("keeps fillRoomTone on the Edit stage for a suggest-only link", () => {
    as("commenter", "review");
    expect(rowReason("range.fillRoomTone")).toBe(STAGE_REASON);
  });

  it.each(["commentOnly", "viewer", "noCaps"] as const)(
    "range.cut stays disabled for %s on Review",
    (role) => {
      as(role, "review");
      expect(rowReason("range.cut")).toBe(STAGE_REASON);
    },
  );

  it.each(
    ["range.cut", "range.mute"].flatMap((id) =>
      (Object.keys(ROLES) as (keyof typeof ROLES)[]).map(
        (role) => [id, role] as const,
      ),
    ),
  )("%s off Edit matches rangeEditMode suggest for %s", (id, role) => {
    const ctx = as(role, "review");
    const [, caps] = ROLES[role];
    expect(evaluateWhen(COMMANDS[id].when, ctx).ok).toBe(
      rangeEditMode("share:tok", caps ? [...caps] : null) === "suggest",
    );
  });
});
