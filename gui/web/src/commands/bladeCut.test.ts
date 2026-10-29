import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { tracksSelection } from "../state/selection";
import { answerQuestions } from "../test/ask";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", () => ({ splitAtTime: vi.fn(async () => undefined) }));

describe("edit.bladeCut", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.splitAtTime).mockClear();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: minimalProject({
        tracks: [
          sampleTrack({ id: "host", label: "Avery" }),
          sampleTrack({ id: "guest", label: "Blair" }),
        ],
      }),
      selection: tracksSelection(["guest"]),
      shellBreakpoint: "desktop",
    });
  });

  it("cuts straight away on desktop, where Undo covers a mistake", async () => {
    const { asked } = answerQuestions(null);
    await execute("edit.bladeCut", { atTime: 12 }, { skipWhen: true });
    expect(asked).toEqual([]);
    expect(api.splitAtTime).toHaveBeenCalledWith(
      "/tmp/ep",
      12,
      ["guest"],
      null,
      [],
    );
  });

  it.each(["phone", "tablet"] as const)(
    "asks askConfirm before a cut on the %s shell and cuts on Cut",
    async (shell) => {
      useDawStore.setState({ shellBreakpoint: shell });
      const { asked } = answerQuestions(true);
      await execute("edit.bladeCut", { atTime: 83.5 }, { skipWhen: true });
      expect(asked).toEqual([
        expect.objectContaining({
          kind: "confirm",
          title: "Cut at 01:23.500?",
          message: "Cuts Blair. Undo brings the clip back.",
          keepLabel: "Don't cut",
          actionLabel: "Cut",
        }),
      ]);
      expect(api.splitAtTime).toHaveBeenCalledWith(
        "/tmp/ep",
        83.5,
        ["guest"],
        null,
        [],
      );
    },
  );

  it("changes nothing when the person keeps the episode as it is", async () => {
    useDawStore.setState({ shellBreakpoint: "phone" });
    answerQuestions(null);
    const result = await execute(
      "edit.bladeCut",
      { atTime: 5 },
      { skipWhen: true },
    );
    expect(result.status).toBe("ok");
    expect(api.splitAtTime).not.toHaveBeenCalled();
  });

  it("does not ask when structural edits are not allowed", async () => {
    useDawStore.setState({
      shellBreakpoint: "phone",
      projectPath: "share:tok",
      guestMode: "view",
      shareCapabilities: ["view"],
    });
    const { asked } = answerQuestions(true);
    const result = await execute(
      "edit.bladeCut",
      { atTime: 5 },
      { skipWhen: true },
    );
    expect(result.status).toBe("disabled");
    expect(asked).toEqual([]);
    expect(api.splitAtTime).not.toHaveBeenCalled();
  });
});
