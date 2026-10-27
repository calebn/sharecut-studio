import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySuggestedActions, approveEdits, rejectEdits } from "../api";
import { hostFetch } from "../api/documentTransport";
import { resetDocumentAuthority } from "../document/authorityState";
import type { Answer, Question } from "../feedback/ask";
import { useDawStore } from "../state/dawStore";
import { answerQuestions } from "../test/ask";
import {
  COMMENTER_CAPABILITIES,
  minimalProject,
  wavResponse,
} from "../test/fixtures";
import { HISTORY_ROOT_ID, type PendingEditView } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import { _resetSingleFlightsForTests, registerDawCommands } from "./register";

const confirmReply = vi.fn<(question: Question) => Answer>();

vi.mock("../api/documentTransport", () => ({ hostFetch: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    applySuggestedActions: vi.fn(async () => ({
      queued: false,
      summary: "Applied 2 suggested actions",
      historyHead: "h1",
    })),
    approveEdits: vi.fn(async () => ({
      queued: false,
      count: 1,
      historyHead: null,
    })),
    rejectEdits: vi.fn(async () => ({
      queued: false,
      count: 1,
      historyHead: null,
    })),
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
    kind: "filler",
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
    vi.mocked(applySuggestedActions).mockClear();
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
            kind: "filler",
            harsh: true,
          }),
        ],
      }),
    );
    useDawStore.setState({
      stage: "review",
      reviewSection: "tighten",
      guestMode: null,
      shareCapabilities: [],
    });
  });

  afterEach(() => {
    confirmReply.mockReset();
  });

  it("does not retarget a confirmed batch after switching away and back", async () => {
    confirmReply.mockImplementationOnce(() => {
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      useDawStore
        .getState()
        .hydrate("/tmp/p.json", minimalProject({ pending_edits: [pending()] }));
      return true;
    });
    expect(await execute("tighten.applySuggested", { ids: ["e1"] })).toEqual({
      status: "disabled",
      reason: "The project changed. Apply again.",
    });
    expect(applySuggestedActions).not.toHaveBeenCalled();
  });

  it("does not dispatch a confirmation from an earlier opening of the same path", async () => {
    confirmReply.mockImplementationOnce(() => {
      resetDocumentAuthority("/tmp/p.json");
      return true;
    });
    expect(await execute("tighten.applySuggested", { ids: ["e1"] })).toEqual({
      status: "disabled",
      reason: "The project changed. Apply again.",
    });
    expect(applySuggestedActions).not.toHaveBeenCalled();
  });

  it("still revalidates current hits after a same-path project refresh", async () => {
    confirmReply.mockImplementationOnce(() => {
      useDawStore
        .getState()
        .hydrate("/tmp/p.json", minimalProject({ pending_edits: [pending()] }));
      return true;
    });
    expect(
      await execute("tighten.applySuggested", { ids: ["e1", "e2"] }),
    ).toEqual({ status: "ok" });
    expect(applySuggestedActions).toHaveBeenCalledWith("/tmp/p.json", ["e1"]);
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

  it("applyHit and skipHit offer Undo for the entry the reply names", async () => {
    vi.mocked(approveEdits).mockResolvedValueOnce({
      queued: false,
      count: 1,
      historyHead: "h-apply" as never,
    });
    await execute("tighten.applyHit", { id: "e1" });
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Applied tighten hit",
      undo: "h-apply",
    });
    vi.mocked(rejectEdits).mockResolvedValueOnce({
      queued: false,
      count: 1,
      historyHead: "h-skip" as never,
    });
    await execute("tighten.skipHit", { id: "e2" });
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Skipped tighten hit",
      undo: "h-skip",
    });
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
    release({ queued: false, count: 1, historyHead: null });
    expect(await first).toEqual({ status: "ok" });
  });

  it("applyHit keeps the selection and says Still sending when the approval is queued", async () => {
    vi.mocked(approveEdits).mockResolvedValueOnce({
      queued: true,
      count: null,
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
      count: null,
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
            kind: "filler",
            harsh: true,
          }),
          pending({
            id: "restart",
            reason: "restart:phrase:i went",
            review_required: true,
            kind: "filler",
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

  it("apply-suggested sends every listed id, harsh ones included, in one call", async () => {
    const result = await execute("tighten.applySuggested", {
      ids: ["e1", "e2"],
    });
    expect(result).toEqual({ status: "ok" });
    expect(confirmReply).toHaveBeenCalledWith({
      kind: "confirm",
      title: "Apply suggested actions to 2 sounds?",
      message:
        "Each sound gets its own action: cut, shorten, lower or leave. A cut over another speaker ripples every track. One undo puts it all back.",
      keepLabel: "Keep reviewing",
      actionLabel: "Apply 2",
      danger: false,
    });
    expect(applySuggestedActions).toHaveBeenCalledTimes(1);
    expect(applySuggestedActions).toHaveBeenCalledWith("/tmp/p.json", [
      "e1",
      "e2",
    ]);
    expect(approveEdits).not.toHaveBeenCalled();
  });

  it("apply-suggested announces the server summary with an undo", async () => {
    await execute("tighten.applySuggested", { ids: ["e1", "e2"] });
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Applied 2 suggested actions",
      undo: "h1",
    });
  });

  it("apply-suggested does nothing when the question is declined", async () => {
    confirmReply.mockReturnValue(false);
    const result = await execute("tighten.applySuggested", { ids: ["e1"] });
    expect(result).toEqual({ status: "disabled", reason: "Cancelled" });
    expect(applySuggestedActions).not.toHaveBeenCalled();
  });

  it("apply-suggested uses tightenApplyScope when ids omitted", async () => {
    useDawStore.getState().setTightenApplyScope({ ids: ["e1", "e2"] });
    const result = await execute("tighten.applySuggested", {});
    expect(result).toEqual({ status: "ok" });
    expect(applySuggestedActions).toHaveBeenCalledWith("/tmp/p.json", [
      "e1",
      "e2",
    ]);
  });

  it("apply-suggested is disabled when no listed hit exists", async () => {
    const result = await execute("tighten.applySuggested", {
      ids: ["missing"],
    });
    expect(result).toEqual({ status: "disabled", reason: "Nothing to apply" });
    expect(applySuggestedActions).not.toHaveBeenCalled();
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

  describe("reviseSuggested", () => {
    function withBatch(cursor = 1) {
      useDawStore.getState().hydrate(
        "/tmp/p.json",
        minimalProject({
          history: {
            cursor,
            head_id: HISTORY_ROOT_ID,
            can_undo: true,
            can_redo: false,
            groups: [
              {
                kind: "mutation",
                before_index: 0,
                after_index: 1,
                operation: "apply_suggested_actions",
                params: {
                  sounds: [
                    {
                      id: "um",
                      label: "Filler word",
                      track_id: "host",
                      timeline_start: 1,
                      action: "cut",
                    },
                  ],
                },
              },
            ],
          },
        }),
      );
      useDawStore.setState({ guestMode: null, shareCapabilities: [] });
    }

    it("revises the latest batch with the one changed sound and announces an undo", async () => {
      withBatch();
      expect(
        await execute("tighten.reviseSuggested", { id: "um", action: "leave" }),
      ).toEqual({ status: "ok" });
      expect(applySuggestedActions).toHaveBeenCalledWith(
        "/tmp/p.json",
        null,
        { um: "leave" },
        true,
      );
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        message: "Changed the sound. Undo puts back the whole batch.",
        undo: "h1",
      });
    });

    it("refuses a sound that is not in the latest batch", async () => {
      withBatch();
      const result = await execute("tighten.reviseSuggested", {
        id: "nope",
        action: "leave",
      });
      expect(result).toEqual({
        status: "disabled",
        reason: "Only the latest applied batch can be changed",
      });
      expect(applySuggestedActions).not.toHaveBeenCalled();
    });

    it("refuses once the batch is no longer the latest edit", async () => {
      withBatch(0);
      const result = await execute("tighten.reviseSuggested", {
        id: "um",
        action: "leave",
      });
      expect(result.status).toBe("disabled");
      expect(applySuggestedActions).not.toHaveBeenCalled();
    });

    it("refuses an action the server does not know", async () => {
      withBatch();
      const result = await execute("tighten.reviseSuggested", {
        id: "um",
        action: "mute",
      });
      expect(result).toEqual({
        status: "disabled",
        reason: "Pick a sound and an action",
      });
      expect(applySuggestedActions).not.toHaveBeenCalled();
    });

    it("is not allowed for a viewer who cannot apply edits", async () => {
      withBatch();
      useDawStore.setState({
        projectPath: "share:test",
        guestMode: "edit",
        shareCapabilities: COMMENTER_CAPABILITIES,
      });
      const result = await execute("tighten.reviseSuggested", {
        id: "um",
        action: "leave",
      });
      expect(result.status).toBe("disabled");
      expect(applySuggestedActions).not.toHaveBeenCalled();
    });

    it("says what failed when the server refuses", async () => {
      withBatch();
      vi.mocked(applySuggestedActions).mockRejectedValueOnce(
        new Error("Nothing to revise"),
      );
      const result = await execute("tighten.reviseSuggested", {
        id: "um",
        action: "leave",
      });
      expect(result).toEqual({
        status: "disabled",
        reason: "Nothing to revise",
      });
      expect(useDawStore.getState().feedbackToast?.message).toBe(
        "Change failed: Nothing to revise",
      );
    });
  });
});
