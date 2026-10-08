import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveEdits, rejectEdits } from "../api";
import { hostFetch } from "../api/documentTransport";
import type { Answer, Question } from "../feedback/ask";
import { useDawStore } from "../state/dawStore";
import { answerQuestions } from "../test/ask";
import { minimalProject, wavResponse } from "../test/fixtures";
import type { PendingEditView } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import { _resetSingleFlightsForTests, registerDawCommands } from "./register";

const confirmReply = vi.fn<(question: Question) => Answer>();

vi.mock("../api/documentTransport", () => ({ hostFetch: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    approveEdits: vi.fn(async () => ({
      queued: false,
      asked: false,
      historyHead: null,
    })),
    rejectEdits: vi.fn(async () => ({ queued: false, historyHead: null })),
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
    harsh: false,
    listen_one_by_one: false,
    applied: false,
    suggest_reason: null,
    ...overrides,
    source_start_timeline:
      overrides.source_start_timeline === undefined
        ? overrides.timeline_start === undefined
          ? 1
          : overrides.timeline_start
        : overrides.source_start_timeline,
    source_end_timeline:
      overrides.source_end_timeline === undefined
        ? overrides.timeline_end === undefined
          ? 1.2
          : overrides.timeline_end
        : overrides.source_end_timeline,
  };
}

describe("tighten commands", () => {
  beforeEach(() => {
    _resetSingleFlightsForTests();
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(approveEdits).mockClear();
    vi.mocked(rejectEdits).mockClear();
    answerQuestions(confirmReply.mockReturnValue(true));
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
            harsh: true,
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
    confirmReply.mockReset();
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

  it("shares the busy guard across approve and reject before permission checks", async () => {
    type Approved = Awaited<ReturnType<typeof approveEdits>>;
    let release!: (value: Approved) => void;
    const gate = new Promise<Approved>((resolve) => {
      release = resolve;
    });
    vi.mocked(approveEdits).mockImplementationOnce(() => gate);

    const first = execute("tighten.applyHit", { id: "e1" });
    await vi.waitFor(() => expect(approveEdits).toHaveBeenCalledTimes(1));
    useDawStore.setState({ projectPath: "share:token", shareCapabilities: [] });

    expect(await execute("tighten.skipHit", { id: "e2" })).toEqual({
      status: "disabled",
      reason: "Tighten action in progress",
    });
    release({ queued: false, asked: false, historyHead: null });
    expect(await first).toEqual({ status: "ok" });
  });

  it("applyHit keeps the selection and says Still sending when the approval is queued", async () => {
    vi.mocked(approveEdits).mockResolvedValueOnce({
      queued: true,
      asked: false,
      historyHead: null,
    });
    useDawStore
      .getState()
      .setSelection({ kind: "pending", id: "e1", trackId: "host" });
    expect(await execute("tighten.applyHit", { id: "e1" })).toEqual({
      status: "ok",
    });
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "pending",
      id: "e1",
    });
    const said = useDawStore.getState().statusAnnouncement;
    expect(said).toMatch(/Still sending/);
    expect(said).not.toMatch(/Applied/);
  });

  it("skipHit keeps the selection and says Still sending when the rejection is queued", async () => {
    vi.mocked(rejectEdits).mockResolvedValueOnce({
      queued: true,
      historyHead: null,
    });
    useDawStore
      .getState()
      .setSelection({ kind: "pending", id: "e2", trackId: "host" });
    expect(await execute("tighten.skipHit", { id: "e2" })).toEqual({
      status: "ok",
    });
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "pending",
      id: "e2",
    });
    const said = useDawStore.getState().statusAnnouncement;
    expect(said).toMatch(/Still sending/);
    expect(said).not.toContain("Skipped");
  });

  it("applies and skips review-required repetition and restart hits", async () => {
    useDawStore.setState({
      project: minimalProject({
        pending_edits: [
          pending({
            id: "repeat",
            reason: "repetition:word:the",
            review_required: true,
            harsh: true,
          }),
          pending({
            id: "restart",
            reason: "restart:phrase:i went",
            review_required: true,
            harsh: true,
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
    expect(confirmReply).toHaveBeenCalledWith({
      kind: "confirm",
      title: "Apply 1 tighten hit?",
      message: "Their cuts go into the timeline. 1 harsh hit stays pending.",
      keepLabel: "Keep reviewing",
      actionLabel: "Apply 1",
      danger: false,
    });
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

  it("apply-all never batches a row the server did not classify", async () => {
    const unclassified = pending({ id: "unclassified" });
    delete (unclassified as { listen_one_by_one?: boolean }).listen_one_by_one;
    useDawStore.setState({
      project: minimalProject({ pending_edits: [unclassified] }),
    });
    const result = await execute("tighten.applyAllSafe", {
      avoidHarsh: true,
      ids: ["unclassified"],
    });
    expect(result).toEqual({
      status: "disabled",
      reason: "Nothing is eligible to apply",
    });
    expect(approveEdits).not.toHaveBeenCalled();
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

  it("previewHit plays the server's Suggested render of the hit", async () => {
    vi.mocked(hostFetch).mockResolvedValueOnce(wavResponse(1.2));
    URL.createObjectURL = vi.fn(() => "blob:hit");
    expect(await execute("tighten.previewHit", { id: "e1" })).toEqual({
      status: "ok",
    });
    expect(hostFetch).toHaveBeenCalledWith(
      `/api/pending-preview?edit_id=e1&mode=suggested&path=${encodeURIComponent("/tmp/p.json")}`,
      expect.anything(),
    );
    expect(useDawStore.getState().sourcePreview).toMatchObject({
      ownerId: "pending:e1",
      media: { kind: "rendered", url: "blob:hit" },
      startSec: 0,
      endSec: 1.2,
    });
    expect(useDawStore.getState().isPlaying).toBe(false);
  });

  it("previewHit plays Current when the server refuses Suggested", async () => {
    vi.mocked(hostFetch).mockResolvedValueOnce(wavResponse(0.5));
    useDawStore.setState({
      project: minimalProject({
        pending_edits: [pending({ suggest_reason: "No Suggested here." })],
      }),
    });
    expect(await execute("tighten.previewHit", { id: "e1" })).toEqual({
      status: "ok",
    });
    expect(hostFetch).toHaveBeenCalledWith(
      expect.stringContaining("edit_id=e1&mode=current"),
      expect.anything(),
    );
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
