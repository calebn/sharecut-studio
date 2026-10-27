import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import type { ExactRangeTarget } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  startBounceJob: vi.fn(),
}));

const RANGE = { kind: "exact_range" } as unknown as ExactRangeTarget;

describe("export.bounce", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.startBounceJob).mockReset();
    setChrome({ bounceRequested: false });
    useDawStore.setState({
      projectPath: "/tmp/test/episode.project.json",
      project: minimalProject(),
      guestMode: null,
      stage: "edit",
      bounceRangeTarget: RANGE,
    });
  });

  it("goes to Deliver and asks for Bounce, without starting one or keeping an old range", async () => {
    expect(await execute("export.bounce", {}, { skipWhen: true })).toEqual({
      status: "ok",
    });
    expect(useDawStore.getState().chrome.bounceRequested).toBe(true);
    expect(useDawStore.getState().stage).toBe("deliver");
    expect(useDawStore.getState().bounceRangeTarget).toBeNull();
    expect(api.startBounceJob).not.toHaveBeenCalled();
  });

  it("asks for nothing without a loaded host project", async () => {
    useDawStore.setState({ project: null });
    expect(await execute("export.bounce", {}, { skipWhen: true })).toEqual({
      status: "disabled",
      reason: "No project loaded",
    });
    expect(useDawStore.getState().chrome.bounceRequested).toBe(false);
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().bounceRangeTarget).toBe(RANGE);
  });
});
