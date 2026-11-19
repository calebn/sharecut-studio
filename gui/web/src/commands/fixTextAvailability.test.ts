import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { buildCommandContext, evaluateWhen } from "./context";
import { clearRegisteredCommands, execute } from "./execute";
import { fixTextAvailability } from "./fixTextAvailability";
import { registerDawCommands } from "./register";

const NEEDS_EDITOR = {
  ok: false,
  reason: "Fixing text needs Editor access",
} as const;

function enter(
  projectPath: string,
  guestMode: string | null,
  shareCapabilities: string[] | null,
) {
  useDawStore.getState().hydrate(projectPath, minimalProject());
  useDawStore.setState({ guestMode, shareCapabilities });
}

describe("fixTextAvailability", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/ep", null);
    useDawStore.setState({ guestMode: null, shareCapabilities: null });
  });

  it("is open to the host", () => {
    enter("/tmp/ep", null, null);
    expect(fixTextAvailability(useDawStore.getState())).toEqual({ ok: true });
  });

  it("is open to an Editor link", () => {
    enter("share:tok", "edit", ["view", "play", "comment", "edit"]);
    expect(fixTextAvailability(useDawStore.getState())).toEqual({ ok: true });
  });

  it.each([
    ["comment", ["view", "play", "comment"]],
    ["view", ["view", "play"]],
  ])("tells a %s link it needs Editor access", (guestMode, caps) => {
    enter("share:tok", guestMode, caps);
    expect(fixTextAvailability(useDawStore.getState())).toEqual(NEEDS_EDITOR);
  });

  it("says there is no project before it says anything else", () => {
    expect(fixTextAvailability(useDawStore.getState())).toEqual({
      ok: false,
      reason: "No project loaded",
    });
  });

  it("holds while the words are still loading", () => {
    useDawStore.getState().hydrate(
      "/tmp/ep",
      minimalProject({
        meta: {
          name: "x",
          workspace_dir: "/t",
          hydration: { transcript_words: false },
        } as never,
      }),
    );
    expect(fixTextAvailability(useDawStore.getState())).toEqual({
      ok: false,
      reason: "Word correction unavailable",
    });
  });

  it("gates F2 and Find and replace on the same answer", async () => {
    enter("share:tok", "comment", ["view", "play", "comment"]);
    expect(evaluateWhen("canFixText", buildCommandContext())).toEqual(
      NEEDS_EDITOR,
    );
    expect(await execute("transcript.editWordInline", {})).toMatchObject({
      status: "disabled",
      reason: "Fixing text needs Editor access",
    });
    enter("share:tok", "edit", ["view", "play", "comment", "edit"]);
    expect(evaluateWhen("canFixText", buildCommandContext())).toEqual({
      ok: true,
    });
  });
});
