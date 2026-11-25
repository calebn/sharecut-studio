import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { acceptPending } from "./pendingAccept";

vi.mock("../api", () => ({
  applySuggestedActions: vi.fn(),
  approveEdits: vi.fn(),
}));

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

  it.each([
    ["leave", "remove", 1],
    ["leave", "split", 1],
    ["shorten", "remove", 1],
    ["cut", "remove", 0],
    [null, "remove", 0],
  ] as const)(
    "a %s suggestion on a %s applies it %i time(s)",
    async (suggested_action, type, applied) => {
      await acceptPending("/tmp/p", {
        id: "e1",
        type,
        suggested_action,
      } as never);
      expect(api.applySuggestedActions).toHaveBeenCalledTimes(applied);
      expect(api.approveEdits).toHaveBeenCalledTimes(1 - applied);
    },
  );
});
