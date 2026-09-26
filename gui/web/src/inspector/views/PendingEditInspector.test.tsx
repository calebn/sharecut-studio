import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDawCommands } from "../../commands/register";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleComment } from "../../test/fixtures";
import type { PendingEditView } from "../../types/project";
import {
  ApiError,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "../../utils/apiError";
import { PendingEditInspector } from "./PendingEditInspector";

const createComment = vi.fn();
const patchComment = vi.fn();
const refreshProject = vi.fn();
const approveEdits = vi.fn();
const waiveTranscriptRefine = vi.fn();
const updatePendingEdit = vi.fn();

vi.mock("../../api", () => ({
  createComment: (...args: unknown[]) => createComment(...args),
  patchComment: (...args: unknown[]) => patchComment(...args),
  refreshProject: (...args: unknown[]) => refreshProject(...args),
  approveEdits: (...args: unknown[]) => approveEdits(...args),
  waiveTranscriptRefine: (...args: unknown[]) => waiveTranscriptRefine(...args),
  rejectEdits: vi.fn(),
  updatePendingEdit: (...args: unknown[]) => updatePendingEdit(...args),
}));

const sessionCut: PendingEditView = {
  id: "ed1",
  track_id: "host",
  track_ids: ["host"],
  type: "remove",
  reason: "tangent",
  source_start: 10,
  source_end: 12,
  timeline_start: 10,
  timeline_end: 12,
  timeline_spans: [{ start: 10, end: 12 }],
  mappable: true,
  crossfade_ms: null,
  boundary_mode: null,
  cut_confidence: null,
  review_required: true,
  applied: false,
  scope: "session",
};

describe("PendingEditInspector", () => {
  beforeEach(() => {
    registerDawCommands();
    createComment.mockReset();
    patchComment.mockReset().mockResolvedValue(null);
    refreshProject.mockReset();
    approveEdits.mockReset();
    waiveTranscriptRefine.mockReset();
    waiveTranscriptRefine.mockResolvedValue(undefined);
    refreshProject.mockResolvedValue(
      minimalProject({ pending_edits: [sessionCut] }),
    );
    useDawStore.getState().hydrate("/tmp/p.json", {
      ...minimalProject(),
      pending_edits: [sessionCut],
    });
  });

  it("defaults to Suggested preview for a session remove", async () => {
    const user = userEvent.setup();
    const { container } = render(<PendingEditInspector edit={sessionCut} />);
    expect(screen.getByRole("button", { name: "Suggested" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Play around" }));
    const s = useDawStore.getState();
    expect(s.playSkipStartSec).toBe(10);
    expect(s.playSkipEndSec).toBe(12);
    expect(screen.getByRole("heading", { name: "Ask" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("disables Suggested and A/B for a split", async () => {
    const split: PendingEditView = {
      ...sessionCut,
      id: "sp1",
      type: "split",
      source_end: 10,
      timeline_end: 10,
    };
    const { container } = render(<PendingEditInspector edit={split} />);
    expect(screen.getByRole("button", { name: "Current" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Suggested" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "A/B" })).toBeDisabled();
    await expectNoA11yViolations(container);
  });

  it("posts the first Ask as a linked comment thread", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValue(
      sampleComment({ edit_decision_id: "ed1", body: "Why this cut?" }),
    );
    render(<PendingEditInspector edit={sessionCut} />);
    await user.type(
      screen.getByPlaceholderText("Ask for more context before deciding…"),
      "Why this cut?",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(createComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({
        body: "Why this cut?",
        editDecisionId: "ed1",
        timelineStart: 10,
        timelineEnd: 12,
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
    render(<PendingEditInspector edit={sessionCut} />);

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

  it("hides Ask compose when a suggest guest lacks comment", () => {
    const key = shareProjectKey("tok");
    useDawStore
      .getState()
      .hydrate(
        key,
        { ...minimalProject(), pending_edits: [sessionCut] },
        "suggest",
        ["play", "view", "suggest"],
      );
    render(<PendingEditInspector edit={sessionCut} />);
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Ask" })).toBeTruthy();
  });

  it("keeps Ask compose and preview controls after a long approve error", async () => {
    const user = userEvent.setup();
    approveEdits.mockRejectedValue(
      new ApiError(
        "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine (whole-episode pass), then `podcast transcript refine-waive --reason ...` / transcript_refine_waive_tool.",
        TRANSCRIPT_REFINE_REQUIRED_CODE,
      ),
    );
    const { container } = render(<PendingEditInspector edit={sessionCut} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
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
    const user = userEvent.setup();
    approveEdits.mockRejectedValue(new Error("Approval failed"));
    const { rerender } = render(<PendingEditInspector edit={sessionCut} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Approval failed",
    );

    rerender(
      <PendingEditInspector
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
    const user = userEvent.setup();
    approveEdits.mockRejectedValue(new Error("Approval failed"));
    const { rerender } = render(<PendingEditInspector edit={sessionCut} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Approval failed",
    );

    rerender(
      <PendingEditInspector edit={{ ...sessionCut, id: "different-edit" }} />,
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
    render(<PendingEditInspector edit={sessionCut} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
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
    const { container } = render(<PendingEditInspector edit={sessionCut} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Waive with reason" }));
    const reason = screen.getByRole("textbox", { name: "Waiver reason" });
    const validation = screen.getByText(
      "A reason is required to waive transcript refinement.",
    );
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAttribute("aria-describedby", validation.id);
    expect(validation).toHaveAttribute("role", "alert");
    expect(waiveTranscriptRefine).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  describe("plain-language copy and m:ss.mmm times", () => {
    const guestCut: PendingEditView = {
      ...sessionCut,
      reason: "guest:suggest",
      source_start: 0,
      source_end: 1.999999,
      timeline_start: 0,
      timeline_end: 1.999999,
      timeline_spans: [{ start: 0, end: 1.999999 }],
      crossfade_ms: 10,
    };

    beforeEach(() => {
      updatePendingEdit.mockReset();
      updatePendingEdit.mockResolvedValue(undefined);
    });

    it("shows Join fade, rounded times and the reason once in words", () => {
      render(<PendingEditInspector edit={guestCut} />);
      expect(screen.getByText("Join fade")).toBeInTheDocument();
      expect(screen.queryByText("Crossfade")).toBeNull();
      expect(screen.getByLabelText("Source start")).toHaveValue("0:00.000");
      expect(screen.getByLabelText("Source end")).toHaveValue("0:02.000");
      expect(screen.getAllByText("Suggested by guest")).toHaveLength(1);
      expect(screen.queryByText("guest:suggest")).toBeNull();
      expect(screen.getByText("Cut")).toBeInTheDocument();
    });

    it("accepts m:ss.mmm in the nudge fields", async () => {
      const user = userEvent.setup();
      render(<PendingEditInspector edit={guestCut} />);
      const end = screen.getByLabelText("Source end");
      await user.clear(end);
      await user.type(end, "0:02.380");
      await user.click(screen.getByRole("button", { name: /Snap & apply/ }));
      expect(updatePendingEdit).toHaveBeenCalledTimes(1);
      const args = updatePendingEdit.mock.calls[0] as unknown[];
      expect(args.slice(0, 2)).toEqual(["/tmp/p.json", "ed1"]);
      expect(args[2]).toBe(0);
      expect(args[3] as number).toBeCloseTo(2.38, 9);
      expect(args[4]).toBe(true);
      expect(args[5]).toBeUndefined();
    });

    it("rejects a malformed time", async () => {
      const user = userEvent.setup();
      render(<PendingEditInspector edit={guestCut} />);
      const end = screen.getByLabelText("Source end");
      await user.clear(end);
      await user.type(end, "1:75");
      await user.click(screen.getByRole("button", { name: /Snap & apply/ }));
      expect(
        await screen.findByText("Times must be m:ss.mmm or seconds"),
      ).toBeInTheDocument();
      expect(updatePendingEdit).not.toHaveBeenCalled();
    });
  });
});
