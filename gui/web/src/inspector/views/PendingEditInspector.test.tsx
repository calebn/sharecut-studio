import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleComment } from "../../test/fixtures";
import type { PendingEditView } from "../../types/project";
import { PendingEditInspector } from "./PendingEditInspector";

const createComment = vi.fn();
const refreshProject = vi.fn();
const approveEdits = vi.fn();
const waiveTranscriptRefine = vi.fn();

vi.mock("../../api", () => ({
  createComment: (...args: unknown[]) => createComment(...args),
  refreshProject: (...args: unknown[]) => refreshProject(...args),
  approveEdits: (...args: unknown[]) => approveEdits(...args),
  waiveTranscriptRefine: (...args: unknown[]) => waiveTranscriptRefine(...args),
  rejectEdits: vi.fn(),
  updatePendingEdit: vi.fn(),
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
    createComment.mockReset();
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
      new Error(
        "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine (whole-episode pass), then `podcast transcript refine-waive --reason ...` / transcript_refine_waive_tool.",
      ),
    );
    const { container } = render(<PendingEditInspector edit={sessionCut} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(/Transcript refine is required/);
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
      new Error("Transcript refine is required before focus/tighten/NL edits."),
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
});
