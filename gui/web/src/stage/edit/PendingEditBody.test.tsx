import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PendingCutProposal,
  pendingEditBaseline,
} from "../../api/documentEdits";
import { hostFetch } from "../../api/documentTransport";
import { registerDawCommands } from "../../commands/register";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  COMMENTER_CAPABILITIES,
  minimalProject,
  sampleComment,
  sampleTrack,
  wavResponse,
} from "../../test/fixtures";
import { decide } from "../../test/pendingDecision";
import type { PendingEditView } from "../../types/project";
import {
  ApiError,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "../../utils/apiError";
import { pendingEditTimingFieldId } from "../../utils/pendingEditTimingField";
import { PendingEditBody } from "./PendingEditBody";

const createComment = vi.fn();
const patchComment = vi.fn();
const refreshProject = vi.fn();
const approveEdits = vi.fn();
const waiveTranscriptRefine = vi.fn();
const updatePendingEdit = vi.fn();
const loadPendingCutSuggestion = vi.fn();

const { loadHostCommandCount } = vi.hoisted(() => ({
  loadHostCommandCount: vi.fn(async () => 1),
}));

vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandCount,
}));

vi.mock("../../api/documentTransport", () => ({ hostFetch: vi.fn() }));
vi.mock("../../audio/pendingPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../audio/pendingPreview")>()),
  warmPendingPreview: vi.fn(),
}));

vi.mock("../../api", () => ({
  createComment: (...args: unknown[]) => createComment(...args),
  patchComment: (...args: unknown[]) => patchComment(...args),
  refreshProject: (...args: unknown[]) => refreshProject(...args),
  approveEdits: (...args: unknown[]) => approveEdits(...args),
  waiveTranscriptRefine: (...args: unknown[]) => waiveTranscriptRefine(...args),
  rejectEdits: vi.fn(async () => ({
    queued: false,
    count: 1,
    historyHead: null,
  })),
  updatePendingEdit: (...args: unknown[]) => updatePendingEdit(...args),
  loadPendingCutSuggestion: (...args: unknown[]) =>
    loadPendingCutSuggestion(...args),
}));

const sessionCut: PendingEditView = {
  id: "ed1",
  track_id: "host",
  track_ids: ["host"],
  type: "remove",
  reason: "tangent",
  source_start: 10,
  source_end: 12,
  source_start_timeline: 10,
  source_end_timeline: 12,
  timeline_start: 10,
  timeline_end: 12,
  timeline_spans: [{ start: 10, end: 12 }],
  mappable: true,
  crossfade_ms: null,
  boundary_mode: null,
  cut_confidence: null,
  review_required: true,
  kind: "other",
  harsh: false,
  applied: false,
  suggest_reason: null,
  timebase: "source",
  scope: "session",
};

function replaceStoredEdit(edit: PendingEditView) {
  useDawStore
    .getState()
    .hydrate("/tmp/p.json", minimalProject({ pending_edits: [edit] }));
  useDawStore
    .getState()
    .setSelection({ kind: "pending", id: edit.id, trackId: edit.track_id });
}

function expectedBaseline(edit = sessionCut) {
  return pendingEditBaseline(edit);
}

async function commitField(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  text: string,
) {
  const box = screen.getByRole("spinbutton", { name: label });
  await waitFor(() => expect(box).not.toHaveAttribute("aria-readonly"));
  box.focus();
  await user.keyboard("{Enter}");
  const input = screen.getByRole("textbox", { name: label });
  await user.clear(input);
  await user.type(input, `${text}{Enter}`);
}

describe("PendingEditBody", () => {
  beforeEach(() => {
    localStorage.clear();
    registerDawCommands();
    loadHostCommandCount.mockReset().mockResolvedValue(1);
    createComment.mockReset();
    updatePendingEdit.mockReset().mockResolvedValue({ queued: false });
    loadPendingCutSuggestion
      .mockReset()
      .mockImplementation(() => new Promise(() => {}));
    patchComment.mockReset().mockResolvedValue(null);
    refreshProject.mockReset();
    approveEdits.mockReset().mockResolvedValue({
      queued: false,
      count: 1,
      historyHead: null,
    });
    waiveTranscriptRefine.mockReset();
    waiveTranscriptRefine.mockResolvedValue(undefined);
    refreshProject.mockResolvedValue(
      minimalProject({ pending_edits: [sessionCut] }),
    );
    useDawStore.getState().hydrate("/tmp/p.json", {
      ...minimalProject(),
      pending_edits: [sessionCut],
    });
    useDawStore
      .getState()
      .setSelection({ kind: "pending", id: "ed1", trackId: "host" });
  });

  it.each([
    ["/tmp/p.json", null, null, true],
    [shareProjectKey("tok"), "edit", ["view", "edit"], true],
    [shareProjectKey("tok"), "comment", COMMENTER_CAPABILITIES, false],
  ] as const)(
    "shows exact timeline islands and review at %s for guest mode %s",
    async (path, guestMode, capabilities, canReview) => {
      const exact = {
        ...sessionCut,
        source_start: null,
        source_end: null,
        source_start_timeline: null,
        source_end_timeline: null,
        timebase: "timeline",
        timeline_start: 11,
        timeline_end: 14,
        exact_range: {
          kind: "exact_range" as const,
          intervals: [
            { start: 11, end: 12 },
            { start: 13, end: 14 },
          ],
          track_ids: ["host", "guest"],
          clips: [],
          media_seals: { host: "seal", guest: "seal" },
        },
      };
      useDawStore
        .getState()
        .hydrate(
          path,
          minimalProject({ pending_edits: [exact] }),
          guestMode,
          capabilities ? [...capabilities] : null,
        );
      render(<PendingEditBody edit={exact} />);
      expect(
        screen.getByText("0:11.000 – 0:12.000 · 0:13.000 – 0:14.000"),
      ).toBeVisible();
      expect(screen.getByText("host, guest")).toBeVisible();
      expect(
        screen.getByRole("heading", { name: "Pending cut" }),
      ).toBeVisible();
      expect(screen.queryByText("Type")).toBeNull();
      expect(
        screen.queryByRole("spinbutton", { name: "Source start" }),
      ).toBeNull();
      expect(
        screen.queryByRole("spinbutton", { name: "Source end" }),
      ).toBeNull();
      expect(
        screen.queryByRole("checkbox", { name: "Snap to silence" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Apply timing" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Use suggestion" }),
      ).toBeNull();
      expect(loadPendingCutSuggestion).not.toHaveBeenCalled();
      if (canReview)
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(),
        );
      else {
        expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
        expect(
          screen.getByText(
            "Only the host or an Editor can review exact range proposals.",
          ),
        ).toBeVisible();
      }
    },
  );

  it("plays the server's Suggested render for a session remove by default", async () => {
    const user = userEvent.setup();
    vi.mocked(hostFetch).mockResolvedValueOnce(wavResponse(1.5));
    URL.createObjectURL = vi.fn(() => "blob:suggested");
    const { container } = render(<PendingEditBody edit={sessionCut} />);
    expect(screen.getByRole("button", { name: "Suggested" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Play around" }));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).toMatchObject({
        ownerId: "pending:ed1",
        media: { kind: "rendered", url: "blob:suggested" },
        endSec: 1.5,
      }),
    );
    expect(hostFetch).toHaveBeenCalledWith(
      `/api/pending-preview?edit_id=ed1&mode=suggested&path=${encodeURIComponent("/tmp/p.json")}`,
      expect.anything(),
    );
    expect(screen.getByRole("heading", { name: "Ask" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("adds timing steps and disables both while a source draft is dirty", async () => {
    render(<PendingEditBody edit={sessionCut} />);
    expect(screen.queryByRole("group", { name: /Nudge source/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /ms later/ })).toBeNull();
    const start = screen.getByRole("spinbutton", { name: "Source start" });
    await waitFor(() => expect(start).not.toHaveAttribute("aria-readonly"));
    expect(start).toHaveAttribute("aria-valuenow", "10");
    expect(start).not.toHaveAttribute("aria-readonly");
    expect(
      screen.getByRole("spinbutton", { name: "Source end" }),
    ).toHaveAttribute("aria-valuenow", "12");
  });

  it("saves one existing pending command for one timing-step click", async () => {
    render(<PendingEditBody edit={sessionCut} />);
    const start = screen.getByRole("spinbutton", { name: "Source start" });
    start.focus();
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(updatePendingEdit).toHaveBeenCalledTimes(1));
    expect(updatePendingEdit).toHaveBeenCalledWith(
      "/tmp/p.json",
      "ed1",
      10.01,
      12,
      true,
      undefined,
      expectedBaseline(sessionCut),
    );
  });

  const barEdit = {
    ...sessionCut,
    kind: "filler" as const,
    suggested_action: "cut" as const,
  };

  it("shows a kind line and a Why row", () => {
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host", label: "Jon" })],
        pending_edits: [barEdit],
      }),
    );
    render(<PendingEditBody edit={barEdit} verbsOnBar />);
    expect(screen.getByText("Filler · Jon · 2.0 s")).toBeVisible();
    expect(screen.getByText("Why")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Apply timing" })).toBeNull();
  });

  it.each([
    ["Cut on the bar", barEdit, true, false],
    ["no suggested action", { ...barEdit, suggested_action: null }, true, true],
    ["leave", { ...barEdit, suggested_action: "leave" as const }, true, true],
    ["a split", { ...barEdit, type: "split" as const }, true, true],
    ["a surface with no bar", barEdit, false, true],
  ])(
    "offers Approve and Reject in the sheet for %s: %s",
    (_name, edit, verbsOnBar, shown) => {
      render(<PendingEditBody edit={edit} verbsOnBar={verbsOnBar} />);
      expect(!!screen.queryByRole("button", { name: "Approve" })).toBe(shown);
      expect(!!screen.queryByRole("button", { name: "Reject" })).toBe(shown);
    },
  );

  it("does not save when a field is opened and left unchanged, and keeps sub-ms precision", async () => {
    const user = userEvent.setup();
    const precise = {
      ...sessionCut,
      source_start: 10.1234,
      source_end: 12.3804,
    };
    replaceStoredEdit(precise);
    render(<PendingEditBody edit={precise} />);
    const end = screen.getByRole("spinbutton", { name: "Source end" });
    await waitFor(() => expect(end).not.toHaveAttribute("aria-readonly"));
    end.focus();
    await user.keyboard("{Enter}{Tab}");
    expect(updatePendingEdit).not.toHaveBeenCalled();
    await commitField(user, "Source start", "10.1236");
    const args = updatePendingEdit.mock.calls[0] as unknown[];
    expect(args[2]).toBe(10.1236);
    expect(args[3]).toBe(12.3804);
  });

  it("does not save an untouched field whose stored time has more than six decimals", async () => {
    const user = userEvent.setup();
    const sampled = {
      ...sessionCut,
      source_start: 10,
      source_end: 1234567 / 44100,
    };
    replaceStoredEdit(sampled);
    render(<PendingEditBody edit={sampled} />);
    const end = screen.getByRole("spinbutton", { name: "Source end" });
    await waitFor(() => expect(end).not.toHaveAttribute("aria-readonly"));
    end.focus();
    await user.keyboard("{Enter}{Enter}");
    end.focus();
    await user.keyboard("{Enter}{Tab}");
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("accepts m:ss.mmm in Start and End", async () => {
    const user = userEvent.setup();
    render(<PendingEditBody edit={sessionCut} />);
    await commitField(user, "Source end", "0:12.500");
    expect((updatePendingEdit.mock.calls[0] as unknown[])[3]).toBe(12.5);
  });

  it("keeps a suggestion through the sheet when Keep is chosen", async () => {
    render(<PendingEditBody edit={sessionCut} />);
    await decide("keep");
    expect(approveEdits).not.toHaveBeenCalled();
    expect(
      screen.getByRole("spinbutton", { name: "Source start" }),
    ).toBeVisible();
  });

  it("defaults a mute to Suggested", () => {
    render(<PendingEditBody edit={{ ...sessionCut, type: "mute" }} />);
    expect(screen.getByRole("button", { name: "Suggested" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("disables Suggested and A/B for a split with the server's reason", async () => {
    const reason = "A split does not change the mix until you delete a side.";
    const split: PendingEditView = {
      ...sessionCut,
      id: "sp1",
      type: "split",
      source_end: 10,
      timeline_end: 10,
      suggest_reason: reason,
    };
    const { container } = render(<PendingEditBody edit={split} />);
    expect(screen.getByRole("button", { name: "Current" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Suggested" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "A/B" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Suggested" }),
    ).toHaveAccessibleDescription(reason);
    await expectNoA11yViolations(container);
  });

  it("posts the first Ask as a linked comment thread", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValue(
      sampleComment({ edit_decision_id: "ed1", body: "Why this cut?" }),
    );
    render(<PendingEditBody edit={sessionCut} />);
    await user.type(
      screen.getByPlaceholderText("Ask for more context before deciding…"),
      "Why this cut?",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(createComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({
        body: "Why this cut?",
        author: "Host",
        editDecisionId: "ed1",
        timelineStart: 10,
        timelineEnd: 12,
      }),
    );
  });

  it("prefills a saved real name for the Ask", async () => {
    localStorage.setItem("podcast-mcp-comment-author", "Caleb");
    const user = userEvent.setup();
    createComment.mockResolvedValue(
      sampleComment({ edit_decision_id: "ed1", body: "Why this cut?" }),
    );
    render(<PendingEditBody edit={sessionCut} />);
    await user.type(
      screen.getByPlaceholderText("Ask for more context before deciding…"),
      "Why this cut?",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(createComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({
        body: "Why this cut?",
        author: "Caleb",
        editDecisionId: "ed1",
      }),
    );
  });

  it("resolves and reopens a linked Ask thread through the command", async () => {
    const user = userEvent.setup();
    const comment = sampleComment({ edit_decision_id: "ed1" });
    useDawStore
      .getState()
      .hydrate(
        "/tmp/p.json",
        minimalProject({ pending_edits: [sessionCut], comments: [comment] }),
      );
    render(<PendingEditBody edit={sessionCut} />);

    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(patchComment).toHaveBeenCalledWith("/tmp/p.json", "c1", {
        resolved: true,
        by: expect.any(String),
      }),
    );

    act(() => {
      useDawStore.setState({
        project: minimalProject({
          pending_edits: [sessionCut],
          comments: [{ ...comment, resolved: true, resolved_by: "Host" }],
        }),
      });
    });
    await user.click(screen.getByRole("button", { name: /Reopen/ }));
    await waitFor(() =>
      expect(patchComment).toHaveBeenLastCalledWith("/tmp/p.json", "c1", {
        resolved: false,
        by: expect.any(String),
      }),
    );
  });

  it("a host with a blank name resolves as Host even when Guest is saved", async () => {
    const user = userEvent.setup();
    localStorage.setItem("podcast-mcp-comment-author", "Guest");
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        pending_edits: [sessionCut],
        comments: [sampleComment({ edit_decision_id: "ed1" })],
      }),
    );
    render(<PendingEditBody edit={sessionCut} />);

    await user.clear(screen.getByRole("textbox", { name: "Your name" }));
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(patchComment).toHaveBeenCalledWith("/tmp/p.json", "c1", {
        resolved: true,
        by: "Host",
      }),
    );
  });

  it("a guest with a blank name asks as Guest even when Host is saved", async () => {
    const user = userEvent.setup();
    localStorage.setItem("podcast-mcp-comment-author", "Host");
    const key = shareProjectKey("tok");
    useDawStore
      .getState()
      .hydrate(
        key,
        { ...minimalProject(), pending_edits: [sessionCut] },
        "comment",
        ["play", "view", "comment", "reply"],
      );
    createComment.mockResolvedValue(sampleComment({ edit_decision_id: "ed1" }));
    render(<PendingEditBody edit={sessionCut} />);

    await user.clear(screen.getByRole("textbox", { name: "Your name" }));
    await user.type(
      screen.getByPlaceholderText("Ask for more context before deciding…"),
      "Why this cut?",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(createComment).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ author: "Guest" }),
    );
  });

  it("hides Ask compose from a Viewer, who cannot comment", () => {
    const key = shareProjectKey("tok");
    useDawStore
      .getState()
      .hydrate(
        key,
        { ...minimalProject(), pending_edits: [sessionCut] },
        "view",
        ["play", "view"],
      );
    render(<PendingEditBody edit={sessionCut} />);
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Ask" })).toBeTruthy();
  });

  it("keeps Ask compose and preview controls after a long approve error", async () => {
    approveEdits.mockRejectedValue(
      new ApiError(
        "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine (whole-episode pass), then `podcast transcript refine-waive --reason ...` / transcript_refine_waive_tool.",
        TRANSCRIPT_REFINE_REQUIRED_CODE,
      ),
    );
    const { container } = render(<PendingEditBody edit={sessionCut} />);
    await decide("cut");
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(/Review the transcript or waive/);
    expect(error).not.toHaveTextContent(/podcast transcript/);
    expect(
      screen.getByRole("region", { name: "Ask about this edit" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Your name")).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Preview mode" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("keeps an approval error when the same edit is refreshed", async () => {
    approveEdits.mockRejectedValue(new Error("Approval failed"));
    const { rerender } = render(<PendingEditBody edit={sessionCut} />);

    await decide("cut");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Approval failed",
    );

    rerender(
      <PendingEditBody
        edit={{
          ...sessionCut,
          source_start: 10.5,
          source_end: 12.5,
          track_ids: ["host", "guest"],
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Approval failed");
  });

  it("clears an approval error when the selected edit changes", async () => {
    approveEdits.mockRejectedValue(new Error("Approval failed"));
    const { rerender } = render(<PendingEditBody edit={sessionCut} />);

    await decide("cut");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Approval failed",
    );

    rerender(
      <PendingEditBody edit={{ ...sessionCut, id: "different-edit" }} />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers a host waiver and clears the gate error without approving", async () => {
    const user = userEvent.setup();
    approveEdits.mockRejectedValue(
      new ApiError(
        "Transcript refine is required before focus/tighten/NL edits.",
        TRANSCRIPT_REFINE_REQUIRED_CODE,
      ),
    );
    render(<PendingEditBody edit={sessionCut} />);
    await decide("cut");
    await user.type(
      screen.getByLabelText("Waiver reason"),
      "Reviewed manually",
    );
    await user.click(screen.getByRole("button", { name: "Waive with reason" }));
    expect(waiveTranscriptRefine).toHaveBeenCalledWith(
      "/tmp/p.json",
      "Reviewed manually",
    );
    expect(approveEdits).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Waive with reason" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Retry approval/);
  });

  it("associates an empty waiver reason error with the textarea", async () => {
    const user = userEvent.setup();
    approveEdits.mockRejectedValue(
      new ApiError("Refinement blocked", TRANSCRIPT_REFINE_REQUIRED_CODE),
    );
    const { container } = render(<PendingEditBody edit={sessionCut} />);
    await decide("cut");
    await user.click(screen.getByRole("button", { name: "Waive with reason" }));
    const reason = screen.getByRole("textbox", { name: "Waiver reason" });
    const validation = screen.getByText(
      "A reason is required to waive transcript refinement.",
    );
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription(
      "This reason is saved with the transcript-refine status. A reason is required to waive transcript refinement.",
    );
    expect(validation).toHaveAttribute("role", "alert");
    expect(waiveTranscriptRefine).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  describe("suggested source bounds", () => {
    function proposal(edit = sessionCut): PendingCutProposal {
      const bounds = pendingEditBaseline(edit);
      return {
        editId: edit.id,
        trackId: edit.track_id,
        original: { start: bounds.start, end: bounds.end },
        expected: expectedBaseline(edit),
        suggested: {
          start: bounds.start - 0.02475,
          end: bounds.end + 0.03525,
        },
        mode: "waveform_only",
        confidence: 0.625,
        startShiftMs: -24.75,
        endShiftMs: 35.25,
        durationDeltaMs: 60,
      };
    }

    function deferredProposal() {
      let resolve: (value: PendingCutProposal) => void = () => {};
      const promise = new Promise<PendingCutProposal>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }

    function replaceStored(edit: PendingEditView, path = "/tmp/p.json") {
      useDawStore
        .getState()
        .hydrate(path, minimalProject({ pending_edits: [edit] }));
    }

    it.each([
      [sessionCut, "0:09.97525 to 0:12.03525", "0:10.000 to 0:12.000"],
      [
        { ...sessionCut, source_start: 1100, source_end: 1102 },
        "18:19.97525 to 18:22.03525",
        "18:20.000 to 18:22.000",
      ],
    ])(
      "shows exact bounds for %j and saves them without a second snap",
      async (edit, suggested, original) => {
        replaceStored(edit);
        const preview = proposal(edit);
        loadPendingCutSuggestion.mockResolvedValue(preview);
        const user = userEvent.setup();
        const { container } = render(<PendingEditBody edit={edit} />);
        const group = within(
          screen.getByRole("region", { name: "Suggested bounds" }),
        );
        expect(await group.findByText(suggested)).toBeVisible();
        expect(group.getByText(original)).toBeVisible();
        expect(group.getByText("-24.75 ms")).toBeVisible();
        expect(group.getByText("+35.25 ms")).toBeVisible();
        expect(group.getByText("+60 ms")).toBeVisible();
        expect(updatePendingEdit).not.toHaveBeenCalled();
        await user.click(group.getByRole("button", { name: "Use suggestion" }));
        expect(updatePendingEdit).toHaveBeenCalledExactlyOnceWith(
          "/tmp/p.json",
          "ed1",
          preview.suggested.start,
          preview.suggested.end,
          false,
          undefined,
          expectedBaseline(edit),
        );
        expect(approveEdits).not.toHaveBeenCalled();
        await expectNoA11yViolations(container);
      },
    );

    it("writes nothing on mount or uncheck and re-snaps stored bounds once on recheck", async () => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={sessionCut} />);
      const snap = screen.getByRole("checkbox", { name: "Snap to silence" });
      expect(snap).toBeChecked();
      expect(updatePendingEdit).not.toHaveBeenCalled();
      await user.click(snap);
      expect(snap).not.toBeChecked();
      expect(updatePendingEdit).not.toHaveBeenCalled();
      await user.click(snap);
      expect(updatePendingEdit).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p.json",
        "ed1",
        10,
        12,
        true,
        undefined,
        expectedBaseline(),
      );
      expect(approveEdits).not.toHaveBeenCalled();
    });

    it("retains unchecked Snap after applying timing and receiving saved bounds", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<PendingEditBody edit={sessionCut} />);
      await user.click(
        screen.getByRole("checkbox", { name: "Snap to silence" }),
      );
      await commitField(user, "Source end", "12.5");
      expect(updatePendingEdit).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p.json",
        "ed1",
        10,
        12.5,
        false,
        undefined,
        expectedBaseline(),
      );
      const saved = { ...sessionCut, source_end: 12.5 };
      act(() => replaceStored(saved));
      rerender(<PendingEditBody edit={saved} />);
      expect(
        screen.getByRole("checkbox", { name: "Snap to silence" }),
      ).not.toBeChecked();
      expect(
        screen.getByRole("spinbutton", { name: "Source end" }),
      ).toHaveAttribute("aria-valuetext", "12.500000 s");
    });

    it("keeps submitted timing through an unrelated refresh while Apply is in flight", async () => {
      let finish: (value: { queued: boolean }) => void = () => {};
      updatePendingEdit.mockImplementationOnce(
        () =>
          new Promise<{ queued: boolean }>((resolve) => {
            finish = resolve;
          }),
      );
      const user = userEvent.setup();
      const { rerender } = render(<PendingEditBody edit={sessionCut} />);
      await commitField(user, "Source end", "12.5");
      rerender(
        <PendingEditBody edit={{ ...sessionCut, track_ids: ["host"] }} />,
      );
      expect(
        screen.getByRole("spinbutton", { name: "Source end" }),
      ).toHaveAttribute("aria-readonly", "true");
      expect(updatePendingEdit).toHaveBeenCalledTimes(1);
      await act(async () => finish({ queued: false }));
      const saved = { ...sessionCut, source_end: 12.5, track_ids: ["host"] };
      act(() => replaceStored(saved));
      rerender(<PendingEditBody edit={saved} />);
      expect(
        screen.getByRole("spinbutton", { name: "Source end" }),
      ).toHaveAttribute("aria-valuetext", "12.500000 s");
    });

    it.each([{ snap: false }, { snap: true }])(
      "normalizes acknowledged unchanged bounds with $snap Snap and permits suggestion acceptance",
      async ({ snap }) => {
        loadPendingCutSuggestion.mockResolvedValue(proposal());
        const user = userEvent.setup();
        render(<PendingEditBody edit={sessionCut} />);
        await waitFor(() =>
          expect(
            screen.getByRole("spinbutton", { name: "Source start" }),
          ).not.toHaveAttribute("aria-readonly"),
        );
        if (!snap)
          await user.click(
            screen.getByRole("checkbox", { name: "Snap to silence" }),
          );
        await commitField(user, "Source end", "12.01");
        expect(
          screen.getByRole("spinbutton", { name: "Source start" }),
        ).toHaveAttribute("aria-valuetext", "10.000000 s");
        expect(
          screen.getByRole("spinbutton", { name: "Source end" }),
        ).toHaveAttribute("aria-valuetext", "12.000000 s");
        expect(
          screen.getByRole("button", { name: "Use suggestion" }),
        ).toBeEnabled();
        expect(updatePendingEdit).toHaveBeenCalledExactlyOnceWith(
          "/tmp/p.json",
          "ed1",
          10,
          12.01,
          snap,
          undefined,
          expectedBaseline(),
        );
      },
    );

    it.each(["typing", "project", "epoch", "edit"])(
      "ignores an old acknowledgment after %s changes",
      async (change) => {
        let finish: (value: { queued: boolean }) => void = () => {};
        updatePendingEdit.mockReturnValueOnce(
          new Promise<{ queued: boolean }>((resolve) => {
            finish = resolve;
          }),
        );
        const user = userEvent.setup();
        const { rerender } = render(<PendingEditBody edit={sessionCut} />);
        await commitField(user, "Source start", "10.5");
        const next =
          change === "edit" ? { ...sessionCut, id: "ed2" } : sessionCut;
        act(() => {
          if (change === "project") replaceStored(next, "/tmp/other.json");
          if (change === "epoch")
            useDawStore.setState({
              projectEpoch: useDawStore.getState().projectEpoch + 1,
            });
          if (change === "edit") replaceStored(next);
        });
        rerender(<PendingEditBody edit={next} />);
        await act(async () => finish({ queued: change !== "typing" }));
        expect(updatePendingEdit).toHaveBeenCalledTimes(1);
        expect(
          screen.getByRole("spinbutton", { name: "Source start" }),
        ).toHaveAttribute("aria-valuetext", "10.000000 s");
        expect(screen.queryByRole("status")).toBeNull();
      },
    );

    it("keeps drafts typed during a read and requires Apply timing before accepting", async () => {
      const pending = deferredProposal();
      loadPendingCutSuggestion.mockReturnValueOnce(pending.promise);
      const user = userEvent.setup();
      render(<PendingEditBody edit={sessionCut} />);
      await waitFor(() =>
        expect(
          screen.getByRole("spinbutton", { name: "Source end" }),
        ).not.toHaveAttribute("aria-readonly"),
      );
      await commitField(user, "Source end", "12.75");
      expect(updatePendingEdit).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p.json",
        "ed1",
        10,
        12.75,
        true,
        undefined,
        expectedBaseline(),
      );
      await act(async () => pending.resolve(proposal()));
      expect(
        screen.getByRole("button", { name: "Use suggestion" }),
      ).toBeEnabled();
    });

    it("keeps dirty drafts on a remote timing change and discards the previous read", async () => {
      const first = deferredProposal();
      const second = deferredProposal();
      loadPendingCutSuggestion
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const user = userEvent.setup();
      const { rerender } = render(<PendingEditBody edit={sessionCut} />);
      await waitFor(() =>
        expect(
          screen.getByRole("spinbutton", { name: "Source start" }),
        ).not.toHaveAttribute("aria-readonly"),
      );
      const updated = { ...sessionCut, source_end: 14 };
      act(() => replaceStored(updated));
      rerender(<PendingEditBody edit={updated} />);
      expect(
        screen.getByRole("spinbutton", { name: "Source end" }),
      ).toHaveAttribute("aria-valuetext", "14.000000 s");
      await act(async () => second.resolve(proposal(updated)));
      expect(screen.getByText("0:09.97525 to 0:14.03525")).toBeVisible();
      await act(async () => first.resolve(proposal()));
      expect(screen.queryByText("0:09.97525 to 0:12.03525")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Use suggestion" }));
      expect(updatePendingEdit).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p.json",
        "ed1",
        proposal(updated).suggested.start,
        proposal(updated).suggested.end,
        false,
        undefined,
        expectedBaseline(updated),
      );
    });

    it.each(["project", "epoch", "selection", "track", "edit", "type"])(
      "discards an obsolete %s response even when it ignores abort",
      async (change) => {
        const first = deferredProposal();
        const second = deferredProposal();
        loadPendingCutSuggestion
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(second.promise);
        const { rerender } = render(<PendingEditBody edit={sessionCut} />);
        await waitFor(() =>
          expect(loadPendingCutSuggestion).toHaveBeenCalledTimes(1),
        );
        const nextEdit =
          change === "track"
            ? { ...sessionCut, track_id: "guest" }
            : change === "edit"
              ? { ...sessionCut, id: "ed2" }
              : change === "type"
                ? { ...sessionCut, type: "mute" }
                : sessionCut;
        act(() => {
          if (change === "project") replaceStored(nextEdit, "/tmp/other.json");
          else if (change === "epoch")
            useDawStore.setState({
              projectEpoch: useDawStore.getState().projectEpoch + 1,
            });
          else if (change === "selection")
            useDawStore.getState().setSelection({
              kind: "pending",
              id: sessionCut.id,
              trackId: "host",
            });
          else replaceStored(nextEdit);
        });
        rerender(<PendingEditBody edit={nextEdit} />);
        await act(async () => first.resolve(proposal()));
        expect(
          screen.getByRole("button", { name: "Use suggestion" }),
        ).toBeDisabled();
        expect(screen.queryByText("0:09.97525 to 0:12.03525")).toBeNull();
        await act(async () => second.resolve(proposal(nextEdit)));
        expect(
          screen.getByRole("button", { name: "Use suggestion" }),
        ).toBeEnabled();
        const signal: AbortSignal = loadPendingCutSuggestion.mock.calls[0]![1];
        expect(signal.aborted).toBe(true);
      },
    );

    it("lets a suggest guest retime only its own share's suggestions", () => {
      const mine = { ...sessionCut, id: "mine", author: "share:aaaaaaaaaaaa" };
      const theirs = {
        ...sessionCut,
        id: "theirs",
        author: "share:bbbbbbbbbbbb",
      };
      const edits = [sessionCut, mine, theirs];
      const retimeable = (
        path: string,
        mode: string | null,
        caps: string[] | null,
        author: string | null,
      ) => {
        useDawStore
          .getState()
          .hydrate(
            path,
            minimalProject({ pending_edits: edits }),
            mode,
            caps,
            author,
          );
        return edits.map((edit) => {
          const { unmount } = render(<PendingEditBody edit={edit} />);
          const shown = screen.queryByLabelText("Source start") !== null;
          unmount();
          return shown;
        });
      };
      const share = shareProjectKey("tok");
      expect(
        retimeable(share, "comment", COMMENTER_CAPABILITIES, mine.author),
      ).toEqual([false, true, false]);
      expect(
        retimeable(share, "edit", ["view", "edit"], "share:cccccccccccc"),
      ).toEqual([true, true, true]);
      expect(retimeable("/tmp/ep.project.json", null, null, null)).toEqual([
        true,
        true,
        true,
      ]);
    });

    it("hides a ready suggestion when capabilities are revoked", async () => {
      loadPendingCutSuggestion.mockResolvedValue(proposal());
      const key = shareProjectKey("tok");
      const guestCut = { ...sessionCut, author: "share:aaaaaaaaaaaa" };
      useDawStore
        .getState()
        .hydrate(
          key,
          minimalProject({ pending_edits: [guestCut] }),
          "comment",
          COMMENTER_CAPABILITIES,
          guestCut.author,
        );
      render(<PendingEditBody edit={guestCut} />);
      expect(await screen.findByText("0:09.97525 to 0:12.03525")).toBeVisible();
      act(() => useDawStore.setState({ shareCapabilities: ["view"] }));
      expect(
        screen.queryByRole("region", { name: "Suggested bounds" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Use suggestion" }),
      ).toBeNull();
    });

    it("recovers a failed read through Retry suggestion and keeps typed timing", async () => {
      loadPendingCutSuggestion
        .mockRejectedValueOnce(new Error("Temporarily unavailable"))
        .mockResolvedValueOnce(proposal());
      const user = userEvent.setup();
      render(<PendingEditBody edit={sessionCut} />);
      await screen.findByRole("button", { name: "Retry suggestion" });
      await user.click(
        screen.getByRole("button", { name: "Retry suggestion" }),
      );
      expect(await screen.findByText("0:09.97525 to 0:12.03525")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Use suggestion" }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Retry suggestion" }),
      ).toBeNull();
    });

    it.each(["Start commit", "Snap to silence", "Use suggestion"])(
      "blocks repeats while %s is queued, then reads fresh bounds",
      async (action) => {
        updatePendingEdit.mockResolvedValueOnce({ queued: true });
        loadPendingCutSuggestion.mockResolvedValue(proposal());
        const user = userEvent.setup();
        render(<PendingEditBody edit={sessionCut} />);
        await screen.findByText("0:09.97525 to 0:12.03525");
        const snap = screen.getByRole("checkbox", { name: "Snap to silence" });
        if (action === "Snap to silence") {
          await user.click(snap);
          await user.click(snap);
        } else if (action === "Start commit")
          await commitField(user, "Source start", "10.5");
        else await user.click(screen.getByRole("button", { name: action }));
        expect(await screen.findByRole("status")).toHaveTextContent(
          "Still sending.",
        );
        const use = screen.getByRole("button", { name: "Use suggestion" });
        expect(use).toBeDisabled();
        await user.click(use);
        await decide("cut");
        await decide("keep");
        expect(snap).toBeDisabled();
        await user.click(snap);
        expect(
          screen.getByRole("spinbutton", { name: "Source start" }),
        ).toHaveAttribute("aria-readonly", "true");
        expect(updatePendingEdit).toHaveBeenCalledTimes(1);
        expect(loadPendingCutSuggestion).toHaveBeenCalledTimes(1);
        expect(approveEdits).not.toHaveBeenCalled();
        loadHostCommandCount.mockResolvedValue(0);
        await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), {
          timeout: 3000,
        });
        expect(
          await screen.findByText("0:09.97525 to 0:12.03525"),
        ).toBeVisible();
        expect(loadPendingCutSuggestion).toHaveBeenCalledTimes(2);
        expect(snap).toBeEnabled();
        expect(
          screen.getByRole("button", { name: "Use suggestion" }),
        ).toBeEnabled();
      },
    );
  });

  describe("plain-language copy and m:ss.mmm times", () => {
    const guestCut: PendingEditView = {
      ...sessionCut,
      reason: "guest:suggest",
      source_start: 0,
      source_end: 1.999999,
      timeline_start: 0,
      timeline_end: 1.999999,
      source_start_timeline: 0,
      source_end_timeline: 1.999999,
      timeline_spans: [{ start: 0, end: 1.999999 }],
      crossfade_ms: 10,
    };

    beforeEach(() => {
      updatePendingEdit.mockReset();
      updatePendingEdit.mockResolvedValue({ queued: false });
      useDawStore
        .getState()
        .hydrate("/tmp/p.json", minimalProject({ pending_edits: [guestCut] }));
    });

    it("shows Join fade, rounded times and the reason once in words", () => {
      render(<PendingEditBody edit={guestCut} />);
      expect(screen.getByText("Join fade")).toBeInTheDocument();
      expect(screen.queryByText("Crossfade")).toBeNull();
      expect(screen.getByLabelText("Source start")).toHaveAttribute(
        "aria-valuetext",
        "0.000000 s",
      );
      expect(screen.getByLabelText("Source end")).toHaveAttribute(
        "aria-valuetext",
        "1.999999 s",
      );
      expect(screen.getAllByText("Suggested by guest")).toHaveLength(1);
      expect(screen.queryByText("guest:suggest")).toBeNull();
      expect(screen.getByText("Cut")).toBeInTheDocument();
    });

    it("sends an untouched field's stored time, not its rounded text", async () => {
      const user = userEvent.setup();
      const precise = { ...guestCut, source_start: 0.1234, source_end: 2.3804 };
      useDawStore
        .getState()
        .hydrate("/tmp/p.json", minimalProject({ pending_edits: [precise] }));
      render(<PendingEditBody edit={precise} />);
      const start = screen.getByLabelText("Source start");
      expect(
        document.getElementById(pendingEditTimingFieldId(guestCut.id, "start")),
      ).toContainElement(start);
      await commitField(user, "Source start", "0.2");
      const args = updatePendingEdit.mock.calls[0] as unknown[];
      expect(args[2] as number).toBeCloseTo(0.2, 9);
      expect(args[3]).toBe(2.3804);
    });

    it("describes the time format on every nudge field", async () => {
      const { container } = render(<PendingEditBody edit={guestCut} />);
      expect(screen.getByLabelText("Source start")).toHaveAttribute(
        "aria-valuetext",
        "0.000000 s",
      );
      expect(screen.getByLabelText("Source end")).toHaveAttribute(
        "aria-valuetext",
        "1.999999 s",
      );
      await expectNoA11yViolations(container);
      cleanup();
      render(
        <PendingEditBody
          edit={{
            ...sessionCut,
            id: "sp1",
            type: "split",
            source_end: 10,
            timeline_end: 10,
            timeline_spans: [{ start: 10, end: 10 }],
          }}
        />,
      );
      expect(screen.getByLabelText("Cut time")).toHaveAccessibleDescription(
        "m:ss.mmm or seconds",
      );
    });

    it("accepts m:ss.mmm in the nudge fields", async () => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={guestCut} />);
      await commitField(user, "Source end", "2.38");
      expect(updatePendingEdit).toHaveBeenCalledTimes(1);
      const args = updatePendingEdit.mock.calls[0] as unknown[];
      expect(args.slice(0, 2)).toEqual(["/tmp/p.json", "ed1"]);
      expect(args[2]).toBe(0);
      expect(args[3] as number).toBeCloseTo(2.38, 9);
      expect(args[4]).toBe(true);
      expect(args[5]).toBeUndefined();
    });

    it("keeps Snap to silence separate from review and sends the chosen value", async () => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={guestCut} />);
      const snap = screen.getByRole("checkbox", { name: "Snap to silence" });
      expect(snap).toBeChecked();
      expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
      await user.click(snap);
      await commitField(user, "Source end", "2.5");
      expect(updatePendingEdit).toHaveBeenCalledWith(
        "/tmp/p.json",
        guestCut.id,
        guestCut.source_start,
        2.5,
        false,
        undefined,
        expectedBaseline(guestCut),
      );
    });

    it("rejects a malformed time", async () => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={guestCut} />);
      await commitField(user, "Source end", "1:75");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Enter a number of at least 0 s",
      );
      expect(updatePendingEdit).not.toHaveBeenCalled();
      await user.keyboard("{Escape}");
      await commitField(user, "Source end", "0");
      expect(await screen.findByText(/end > start/)).toBeInTheDocument();
      expect(updatePendingEdit).not.toHaveBeenCalled();
    });
  });
});
