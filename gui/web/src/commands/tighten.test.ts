import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveEdits, rejectEdits } from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { PendingEditView } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    approveEdits: vi.fn(async () => undefined),
    rejectEdits: vi.fn(async () => undefined),
  };
});

function pending(overrides: Partial<PendingEditView> = {}): PendingEditView {
  return {
    id: "e1",
    track_id: "host",
    type: "remove",
    reason: "filler:um",
    source_start: 1,
    source_end: 1.2,
    timeline_start: 1,
    timeline_end: 1.2,
    timeline_spans: [{ start: 1, end: 1.2 }],
    mappable: true,
    crossfade_ms: 10,
    boundary_mode: null,
    cut_confidence: 0.9,
    review_required: false,
    applied: false,
    can_skip: true,
    ...overrides,
  };
}

describe("tighten commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(approveEdits).mockClear();
    vi.mocked(rejectEdits).mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        pending_edits: [
          pending(),
          pending({
            id: "e2",
            reason: "filler:uh:risky",
            review_required: true,
            join_risk: { verdict: "review", label: "risky" },
          }),
        ],
      }),
    );
    useDawStore.setState({
      activeTab: "tighten",
      guestMode: null,
      shareCapabilities: [],
    });
  });

  afterEach(() => {
    vi.mocked(window.confirm).mockRestore();
  });

  it("applyHit and skipHit call the matching document commands", async () => {
    expect(await execute("tighten.applyHit", { id: "e1" })).toEqual({
      status: "ok",
    });
    expect(approveEdits).toHaveBeenCalledWith("/tmp/p.json", ["e1"]);
    expect(await execute("tighten.skipHit", { id: "e2" })).toEqual({
      status: "ok",
    });
    expect(rejectEdits).toHaveBeenCalledWith("/tmp/p.json", ["e2"]);
  });

  it("applies and skips review-required repetition and restart hits", async () => {
    useDawStore.setState({
      project: minimalProject({
        pending_edits: [
          pending({
            id: "repeat",
            reason: "repetition:word:the",
            review_required: true,
          }),
          pending({
            id: "restart",
            reason: "restart:phrase:i went",
            review_required: true,
          }),
        ],
      }),
    });
    expect(await execute("tighten.applyHit", { id: "repeat" })).toEqual({
      status: "ok",
    });
    expect(approveEdits).toHaveBeenCalledWith("/tmp/p.json", ["repeat"]);
    expect(await execute("tighten.skipHit", { id: "restart" })).toEqual({
      status: "ok",
    });
    expect(rejectEdits).toHaveBeenCalledWith("/tmp/p.json", ["restart"]);
  });

  it("apply-all batches eligible ids into one ApproveEdits", async () => {
    const result = await execute("tighten.applyAllSafe", {
      avoidHarsh: true,
      ids: ["e1", "e2"],
    });
    expect(result).toEqual({ status: "ok" });
    expect(window.confirm).toHaveBeenCalledWith(
      "Apply 1 of 2 — 1 skipped as harsh",
    );
    expect(approveEdits).toHaveBeenCalledTimes(1);
    expect(approveEdits).toHaveBeenCalledWith("/tmp/p.json", ["e1"]);
  });

  it("disables apply-all when every listed hit is harsh", async () => {
    const result = await execute("tighten.applyAllSafe", {
      avoidHarsh: true,
      ids: ["e2"],
    });
    expect(result.status).toBe("disabled");
    expect(approveEdits).not.toHaveBeenCalled();
  });

  it("apply-all uses tightenApplyScope when ids omitted", async () => {
    useDawStore.getState().setTightenApplyScope({
      avoidHarsh: true,
      ids: ["e1", "e2"],
    });
    const result = await execute("tighten.applyAllSafe", {});
    expect(result).toEqual({ status: "ok" });
    expect(approveEdits).toHaveBeenCalledWith("/tmp/p.json", ["e1"]);
  });

  it("previewHit disables when timeline position is missing", async () => {
    useDawStore.setState({
      project: minimalProject({
        pending_edits: [pending({ timeline_start: null, timeline_end: null })],
      }),
    });
    const result = await execute("tighten.previewHit", { id: "e1" });
    expect(result.status).toBe("disabled");
  });

  it("goToHit disables when timeline position is missing", async () => {
    useDawStore.setState({
      project: minimalProject({
        pending_edits: [pending({ timeline_start: null, timeline_end: null })],
      }),
    });
    const result = await execute("tighten.goToHit", { id: "e1" });
    expect(result.status).toBe("disabled");
  });

  it("goToHit seeks and selects the pending edit", async () => {
    expect(await execute("tighten.goToHit", { id: "e1" })).toEqual({
      status: "ok",
    });
    const s = useDawStore.getState();
    expect(s.selection).toEqual({
      kind: "pending",
      id: "e1",
      trackId: "host",
    });
    expect(s.playheadSec).toBe(1);
  });
});
