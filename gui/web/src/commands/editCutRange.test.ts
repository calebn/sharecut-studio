import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { wordSelection } from "../utils/rangeSelect";
import { clearRegisteredCommands, execute } from "./execute";
import { runRangeAction } from "./rangeActions";
import { registerDawCommands } from "./register";

vi.mock("./rangeActions", async (orig) => ({
  ...(await orig<typeof import("./rangeActions")>()),
  runRangeAction: vi.fn(async () => ({ status: "ok" as const })),
}));

beforeEach(() => {
  vi.mocked(runRangeAction).mockClear();
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({
    project: minimalProject(),
    selection: wordSelection({ trackId: "host", sourceId: null, wordIndex: 0 }),
  });
});

describe("edit.cut on a tapped word", () => {
  it("reaches the range cut in Select", async () => {
    expect((await execute("edit.cut")).status).toBe("ok");
    expect(runRangeAction).toHaveBeenCalledWith("cut");
  });
});
