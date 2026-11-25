import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { acceptPending } from "./pendingAccept";
import { pendingAcceptRoute } from "./pendingDecision";

vi.mock("../api", () => ({
  applySuggestedActions: vi.fn(),
  approveEdits: vi.fn(),
}));

const edits = (["remove", "split"] as const).flatMap((type) =>
  [undefined, { intervals: [] } as never].flatMap((exact_range) =>
    [undefined, null, "cut", "shorten", "lower", "leave"].map(
      (suggested_action) => ({
        id: "e1",
        type,
        exact_range,
        suggested_action,
      }),
    ),
  ),
);

describe("acceptPending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.applySuggestedActions).mockResolvedValue({
      queued: false,
      summary: "Done",
      historyHead: "h",
    } as never);
    vi.mocked(api.approveEdits).mockResolvedValue({
      queued: false,
      count: 1,
      historyHead: "h",
    } as never);
  });

  it.each(edits)("sends %o down its route only", async (edit) => {
    await acceptPending("/tmp/p", edit as never);
    const own = pendingAcceptRoute(edit as never) === "own";
    expect(api.applySuggestedActions).toHaveBeenCalledTimes(own ? 1 : 0);
    expect(api.approveEdits).toHaveBeenCalledTimes(own ? 0 : 1);
  });
});
