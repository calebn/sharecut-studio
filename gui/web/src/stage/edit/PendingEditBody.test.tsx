import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingEditBaseline } from "../../api/documentEdits";
import { hostFetch } from "../../api/documentTransport";
import {
  playPendingPreview,
  warmPendingPreview,
} from "../../audio/pendingPreview";
import { executePointerCommand } from "../../commands/pointer";
import { registerDawCommands } from "../../commands/register";
import {
  CUT_ANYWAY_REASON,
  REFINE_GATE_GUI_MESSAGE,
} from "../../inspector/TranscriptRefineRecovery";
import { QUEUED_NOTICE_POLL_MS } from "../../inspector/useQueuedReviewNotice";
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
const addCommentReply = vi.fn();
const setCommentActionDone = vi.fn();
const patchComment = vi.fn();
const refreshProject = vi.fn();
const approveEdits = vi.fn();
const waiveTranscriptRefine = vi.fn();
const updatePendingEdit = vi.fn();

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
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
  setCommentActionDone: (...args: unknown[]) => setCommentActionDone(...args),
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
  { alt = false }: { alt?: boolean } = {},
) {
  const box = screen.getByRole("spinbutton", { name: label });
  await waitFor(() => expect(box).not.toHaveAttribute("aria-readonly"));
  box.focus();
  await user.keyboard("{Enter}");
  const input = screen.getByRole("textbox", { name: label });
  await user.clear(input);
  await user.type(input, text);
  await user.keyboard(alt ? "{Alt>}{Enter}{/Alt}" : "{Enter}");
}

describe("PendingEditBody", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    localStorage.clear();
    useDawStore.setState({ snapEnabled: true });
    registerDawCommands();
    loadHostCommandCount.mockReset().mockResolvedValue(1);
    createComment.mockReset();
    updatePendingEdit.mockReset().mockResolvedValue({ queued: false });
    patchComment.mockReset().mockResolvedValue(null);
    addCommentReply.mockReset().mockResolvedValue(null);
    setCommentActionDone.mockReset().mockResolvedValue(null);
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
      expect(
        screen.getByRole("heading", { name: "Pending cut" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("spinbutton", { name: "Source start" }),
      ).toBeNull();
      expect(
        screen.queryByRole("spinbutton", { name: "Source end" }),
      ).toBeNull();
      if (canReview)
        await waitFor(() => {
          expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
          expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
        });
      else {
        expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
        expect(
          screen.getByText(
            "Only the host or an Editor can review exact range proposals.",
          ),
        ).toBeVisible();
      }
    },
  );

  it("keeps the card title and Ask in heading order under the page heading", async () => {
    const { container } = render(
      <>
        <h1>Edit</h1>
        <PendingEditBody edit={sessionCut} />
      </>,
    );
    const results = await axe.run(container, { runOnly: ["heading-order"] });
    expect(results.violations).toEqual([]);
    expect(
      screen
        .getAllByRole("heading")
        .map((heading) => `${heading.tagName}:${heading.textContent}`),
    ).toEqual(["H1:Edit", "H2:Pending edit", "H3:Ask"]);
  });

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

  it("warms the previews with no footer where the Action bar plays them, and stops them on unmount", async () => {
    URL.createObjectURL = vi.fn(() => "blob:suggested");
    URL.revokeObjectURL = vi.fn();
    vi.mocked(hostFetch).mockResolvedValue(wavResponse(1.5));
    const { unmount } = render(
      <PendingEditBody edit={sessionCut} verbsOnBar />,
    );
    expect(screen.queryByRole("group", { name: "Preview mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Play around" })).toBeNull();
    await waitFor(
      () =>
        expect(warmPendingPreview).toHaveBeenCalledWith("/tmp/p.json", "ed1"),
      { timeout: 3000 },
    );
    await playPendingPreview("/tmp/p.json", "ed1", "suggested");
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    unmount();
    expect(useDawStore.getState().sourcePreview).toBeNull();
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

  it("shows the kind, speaker, length and reason on a compact card", () => {
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host", label: "Jon" })],
        pending_edits: [barEdit],
      }),
    );
    const { container } = render(<PendingEditBody edit={barEdit} verbsOnBar />);
    const card = container.querySelector(".sys-decision");
    expect(card).toHaveAttribute("data-layout", "compact");
    expect(card).toHaveAttribute("data-kind", "filler");
    const kind = within(card as HTMLElement).getByText("Filler");
    expect(kind.parentElement).toHaveTextContent("Filler0:10.000 · 2.0 sJon");
    expect(screen.queryByText("Why")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply timing" })).toBeNull();
  });

  it("draws the edit's confidence as a meter and none when it has none", () => {
    const rate = (confidence: number | null) => {
      const edit = { ...sessionCut, cut_confidence: confidence };
      useDawStore
        .getState()
        .hydrate("/tmp/p.json", minimalProject({ pending_edits: [edit] }));
      return render(<PendingEditBody edit={edit} />);
    };
    rate(null).unmount();
    expect(screen.queryByRole("img", { name: /Confidence/ })).toBeNull();
    rate(0.5);
    expect(
      screen.getByRole("img", { name: "Confidence 3 of 5" }),
    ).toBeVisible();
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

  it.each([480003 / 48000, 48033 / 48000])(
    "does not save an untouched field whose stored time is %s, but saves a real change",
    async (stored) => {
      const user = userEvent.setup();
      const sampled = {
        ...sessionCut,
        source_start: 0.5,
        source_end: stored + 10,
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
      await commitField(user, "Source end", "20");
      expect(updatePendingEdit).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts m:ss.mmm in Start and End", async () => {
    const user = userEvent.setup();
    render(<PendingEditBody edit={sessionCut} />);
    await commitField(user, "Source end", "0:12.500");
    expect((updatePendingEdit.mock.calls[0] as unknown[])[3]).toBe(12.5);
  });

  it("announces nothing when the selection changes during a Cut from the bar, as main's bar path did", async () => {
    let finish: (value: unknown) => void = () => {};
    approveEdits.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<PendingEditBody edit={sessionCut} />);
    await waitFor(() =>
      expect(screen.queryByText("Checking queued timing…")).toBeNull(),
    );
    const pending = executePointerCommand("edit.delete");
    await waitFor(() => expect(approveEdits).toHaveBeenCalledTimes(1));
    act(() => useDawStore.getState().setSelection(null));
    finish({ queued: false, count: 1, historyHead: "h1" });
    await act(async () => {
      await pending;
    });
    expect(useDawStore.getState().feedbackToast?.message ?? null).toBeNull();
  });

  it("announces a failed Cut from the bar in the status line and in the sheet", async () => {
    approveEdits.mockRejectedValueOnce(new Error("Approval failed"));
    render(<PendingEditBody edit={sessionCut} />);
    await decide("cut");
    expect(useDawStore.getState().statusAnnouncement).toBe("Approval failed");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Approval failed",
    );
  });

  it("announces a queued Cut from the bar in the status line and in the sheet", async () => {
    approveEdits.mockResolvedValueOnce({
      queued: true,
      count: null,
      historyHead: null,
    });
    render(<PendingEditBody edit={sessionCut} />);
    await decide("cut");
    expect(useDawStore.getState().statusAnnouncement).toMatch(/Still sending/);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Still sending.",
    );
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
    const { container } = render(<PendingEditBody edit={sessionCut} />);

    expect(
      container.querySelector('[data-presence-anchor="comment:c1"]'),
    ).not.toBeNull();
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

  it("says nothing about a footer in the empty Ask copy", () => {
    render(<PendingEditBody edit={sessionCut} verbsOnBar />);
    const region = screen.getByRole("region", { name: "Ask about this edit" });
    expect(region).toHaveTextContent(
      "Ask a question here before you approve or reject.",
    );
    expect(region).not.toHaveTextContent(/Hear Suggested/);
  });

  it("posts the first Ask with Enter and keeps Shift+Enter for a new line", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValue(sampleComment({ edit_decision_id: "ed1" }));
    render(<PendingEditBody edit={sessionCut} />);
    const field = screen.getByRole("textbox", { name: "Your question" });
    await user.type(field, "Why{Shift>}{Enter}{/Shift}this cut?");
    expect(createComment).not.toHaveBeenCalled();
    await user.type(field, "{Enter}");
    await waitFor(() =>
      expect(createComment).toHaveBeenCalledWith(
        "/tmp/p.json",
        expect.objectContaining({ body: "Why\nthis cut?" }),
      ),
    );
  });

  describe("focus after the first Ask posts", () => {
    const posted = () =>
      sampleComment({ edit_decision_id: "ed1", author: "Host", body: "Why?" });
    const answerWithThread = (path: string, ...grant: unknown[]) =>
      createComment.mockImplementation(async () => {
        useDawStore.getState().hydrate(
          path,
          minimalProject({
            pending_edits: [sessionCut],
            comments: [posted()],
          }),
          ...(grant as []),
        );
        return posted();
      });

    it("moves to the empty reply field after Ask is clicked", async () => {
      const user = userEvent.setup();
      answerWithThread("/tmp/p.json");
      render(<PendingEditBody edit={sessionCut} />);
      await user.type(
        screen.getByRole("textbox", { name: "Your question" }),
        "Why?",
      );
      await user.click(screen.getByRole("button", { name: "Ask" }));
      const reply = await screen.findByRole("textbox", {
        name: "Reply to Host",
      });
      expect(reply).toHaveFocus();
      expect(reply).toHaveValue("");
    });

    it("moves to the empty reply field after Enter posts", async () => {
      const user = userEvent.setup();
      answerWithThread("/tmp/p.json");
      render(<PendingEditBody edit={sessionCut} />);
      await user.type(
        screen.getByRole("textbox", { name: "Your question" }),
        "Why?{Enter}",
      );
      expect(
        await screen.findByRole("textbox", { name: "Reply to Host" }),
      ).toHaveFocus();
    });

    it("does the same for a Commenter link", async () => {
      const user = userEvent.setup();
      answerWithThread(
        shareProjectKey("tok"),
        "comment",
        COMMENTER_CAPABILITIES,
      );
      useDawStore
        .getState()
        .hydrate(
          shareProjectKey("tok"),
          minimalProject({ pending_edits: [sessionCut] }),
          "comment",
          COMMENTER_CAPABILITIES,
        );
      render(<PendingEditBody edit={sessionCut} />);
      await user.type(
        screen.getByRole("textbox", { name: "Your question" }),
        "Why?",
      );
      await user.click(screen.getByRole("button", { name: "Ask" }));
      expect(
        await screen.findByRole("textbox", { name: "Reply to Host" }),
      ).toHaveFocus();
    });

    it("leaves focus alone when the Ask is refused", async () => {
      const user = userEvent.setup();
      createComment.mockRejectedValueOnce(new Error("Ask failed"));
      render(<PendingEditBody edit={sessionCut} />);
      const field = screen.getByRole("textbox", { name: "Your question" });
      await user.type(field, "Why?");
      await user.click(screen.getByRole("button", { name: "Ask" }));
      await screen.findByRole("alert");
      expect(field).toHaveFocus();
      expect(field).toHaveValue("Why?");
    });
  });

  it("replies to an existing Ask thread instead of creating a second one", async () => {
    const user = userEvent.setup();
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        pending_edits: [sessionCut],
        comments: [sampleComment({ edit_decision_id: "ed1", author: "Ines" })],
      }),
    );
    render(<PendingEditBody edit={sessionCut} />);
    expect(screen.queryByRole("textbox", { name: "Your question" })).toBeNull();
    const reply = screen.getByRole("textbox", { name: "Reply to Ines" });
    await user.type(reply, "Looks fine to me");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(addCommentReply).toHaveBeenCalledWith("/tmp/p.json", "c1", {
        body: "Looks fine to me",
        author: "Host",
      }),
    );
    expect(createComment).not.toHaveBeenCalled();
    await waitFor(() => expect(reply).toHaveValue(""));
  });

  it("keeps the typed reply when the reply is refused", async () => {
    const user = userEvent.setup();
    addCommentReply.mockRejectedValueOnce(new Error("Reply failed"));
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        pending_edits: [sessionCut],
        comments: [sampleComment({ edit_decision_id: "ed1", author: "Ines" })],
      }),
    );
    render(<PendingEditBody edit={sessionCut} />);
    const reply = screen.getByRole("textbox", { name: "Reply to Ines" });
    await user.type(reply, "Looks fine to me");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reply failed");
    expect(reply).toHaveValue("Looks fine to me");
  });

  it("lets the host tick an action item and shows it read-only to a Commenter", async () => {
    const user = userEvent.setup();
    const comment = sampleComment({
      edit_decision_id: "ed1",
      action_items: [
        {
          id: "a1",
          text: "Check the room tone",
          done: false,
          completed_at: null,
          completed_by: null,
        },
      ],
    });
    useDawStore
      .getState()
      .hydrate(
        "/tmp/p.json",
        minimalProject({ pending_edits: [sessionCut], comments: [comment] }),
      );
    const { unmount } = render(<PendingEditBody edit={sessionCut} />);
    await user.click(screen.getByRole("checkbox", { name: /room tone/ }));
    await waitFor(() =>
      expect(setCommentActionDone).toHaveBeenCalledWith(
        "/tmp/p.json",
        "c1",
        "a1",
        { done: true, by: "Host" },
      ),
    );
    unmount();

    const key = shareProjectKey("tok");
    useDawStore
      .getState()
      .hydrate(
        key,
        minimalProject({ pending_edits: [sessionCut], comments: [comment] }),
        "comment",
        COMMENTER_CAPABILITIES,
      );
    render(<PendingEditBody edit={sessionCut} />);
    expect(screen.getByText("Check the room tone")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("shows a Viewer the thread without a reply field", () => {
    const key = shareProjectKey("tok");
    useDawStore.getState().hydrate(
      key,
      minimalProject({
        pending_edits: [sessionCut],
        comments: [sampleComment({ edit_decision_id: "ed1", author: "Ines" })],
      }),
      "view",
      ["play", "view"],
    );
    render(<PendingEditBody edit={sessionCut} />);
    expect(screen.getByText("Needs a tighter open")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
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
    expect(error).toHaveTextContent(REFINE_GATE_GUI_MESSAGE);
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
    await user.click(await screen.findByRole("button", { name: "Cut anyway" }));
    expect(waiveTranscriptRefine).toHaveBeenCalledWith(
      "/tmp/p.json",
      CUT_ANYWAY_REASON,
    );
    expect(approveEdits).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Retry approval/);
  });

  it("asks to cut anyway with no waiver text box", async () => {
    approveEdits.mockRejectedValue(
      new ApiError("Refinement blocked", TRANSCRIPT_REFINE_REQUIRED_CODE),
    );
    const { container } = render(<PendingEditBody edit={sessionCut} />);
    await decide("cut");
    await screen.findByRole("button", { name: "Cut anyway" });
    expect(screen.queryByRole("textbox", { name: "Waiver reason" })).toBeNull();
    expect(waiveTranscriptRefine).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  describe("timing", () => {
    function replaceStored(edit: PendingEditView, path = "/tmp/p.json") {
      useDawStore
        .getState()
        .hydrate(path, minimalProject({ pending_edits: [edit] }));
    }

    it("has no Snap checkbox, Suggested bounds group or Use suggestion button", () => {
      render(<PendingEditBody edit={sessionCut} />);
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(
        screen.queryByRole("region", { name: "Suggested bounds" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Use suggestion" }),
      ).toBeNull();
    });

    it("writes nothing on mount", () => {
      render(<PendingEditBody edit={sessionCut} />);
      expect(updatePendingEdit).not.toHaveBeenCalled();
      expect(approveEdits).not.toHaveBeenCalled();
    });

    it("snaps to silence by default and not while Alt is held", async () => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={sessionCut} />);
      await commitField(user, "Source end", "12.5");
      expect(updatePendingEdit).toHaveBeenLastCalledWith(
        "/tmp/p.json",
        "ed1",
        10,
        12.5,
        true,
        undefined,
        expectedBaseline(),
      );
      await commitField(user, "Source start", "10.25", { alt: true });
      expect(updatePendingEdit).toHaveBeenLastCalledWith(
        "/tmp/p.json",
        "ed1",
        10.25,
        12,
        false,
        undefined,
        expectedBaseline(),
      );
      await commitField(user, "Source end", "12.75");
      expect(updatePendingEdit).toHaveBeenLastCalledWith(
        "/tmp/p.json",
        "ed1",
        10,
        12.75,
        true,
        undefined,
        expectedBaseline(),
      );
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

    it("normalizes acknowledged unchanged bounds", async () => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={sessionCut} />);
      await waitFor(() =>
        expect(
          screen.getByRole("spinbutton", { name: "Source start" }),
        ).not.toHaveAttribute("aria-readonly"),
      );
      await commitField(user, "Source end", "12.01");
      expect(
        screen.getByRole("spinbutton", { name: "Source start" }),
      ).toHaveAttribute("aria-valuetext", "10.000000 s");
      expect(
        screen.getByRole("spinbutton", { name: "Source end" }),
      ).toHaveAttribute("aria-valuetext", "12.000000 s");
      expect(updatePendingEdit).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p.json",
        "ed1",
        10,
        12.01,
        true,
        undefined,
        expectedBaseline(),
      );
    });

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

    it("shows a remote timing change", () => {
      const { rerender } = render(<PendingEditBody edit={sessionCut} />);
      const updated = { ...sessionCut, source_end: 14 };
      act(() => replaceStored(updated));
      rerender(<PendingEditBody edit={updated} />);
      expect(
        screen.getByRole("spinbutton", { name: "Source end" }),
      ).toHaveAttribute("aria-valuetext", "14.000000 s");
    });

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

    it("blocks repeats while a Start commit is queued, then frees the fields", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      updatePendingEdit.mockResolvedValueOnce({ queued: true });
      const user = userEvent.setup({
        advanceTimers: (ms) => vi.advanceTimersByTime(ms),
      });
      render(<PendingEditBody edit={sessionCut} />);
      await commitField(user, "Source start", "10.5");
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Still sending.",
      );
      await decide("cut");
      await decide("keep");
      expect(
        screen.getByRole("spinbutton", { name: "Source start" }),
      ).toHaveAttribute("aria-readonly", "true");
      expect(updatePendingEdit).toHaveBeenCalledTimes(1);
      expect(approveEdits).not.toHaveBeenCalled();
      loadHostCommandCount.mockResolvedValue(0);
      await act(() => vi.advanceTimersByTimeAsync(QUEUED_NOTICE_POLL_MS));
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
      expect(
        screen.getByRole("spinbutton", { name: "Source start" }),
      ).not.toHaveAttribute("aria-readonly");
    });
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
      expect(screen.queryByText("Join fade")).toBeNull();
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

    it("gives every timing field a Scrub value and a split no text input", async () => {
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
      expect(screen.getByLabelText("Cut time")).toHaveAttribute(
        "aria-valuetext",
        "10.000000 s",
      );
      expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
      expect(screen.queryByRole("textbox", { name: "Track ids" })).toBeNull();
    });

    it("saves a split's cut time and tracks as they are set, with no Apply", async () => {
      const user = userEvent.setup();
      const split = {
        ...sessionCut,
        id: "sp1",
        type: "split" as const,
        source_start: 10,
        source_end: 10,
        timeline_end: 10,
        timeline_spans: [{ start: 10, end: 10 }],
      };
      useDawStore
        .getState()
        .hydrate("/tmp/p.json", minimalProject({ pending_edits: [split] }));
      render(<PendingEditBody edit={split} />);
      await commitField(user, "Cut time", "10.5");
      expect(updatePendingEdit).toHaveBeenCalledTimes(1);
      const args = updatePendingEdit.mock.calls[0] as unknown[];
      expect(args[2]).toBe(10.5);
      expect(args[3]).toBe(10.5);
      expect(args[4]).toBe(false);
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

    it.each([
      ["the window loses focus", () => fireEvent.blur(window)],
      [
        "Alt is released outside the field",
        () => fireEvent.keyUp(document.body, { key: "Alt", altKey: false }),
      ],
    ])("snaps again when %s while Alt was held", async (_name, release) => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={guestCut} />);
      const box = screen.getByRole("spinbutton", { name: "Source end" });
      await waitFor(() => expect(box).not.toHaveAttribute("aria-readonly"));
      box.focus();
      await user.keyboard("{Enter}");
      const input = screen.getByRole("textbox", { name: "Source end" });
      fireEvent.change(input, { target: { value: "2.5" } });
      fireEvent.keyDown(input, { key: "Alt", altKey: true });
      act(() => {
        release();
      });
      fireEvent.blur(input);
      await waitFor(() => expect(updatePendingEdit).toHaveBeenCalledTimes(1));
      expect((updatePendingEdit.mock.calls[0] as unknown[])[4]).toBe(true);
    });

    it("does not carry Alt from a rejected commit into the next one", async () => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={guestCut} />);
      await commitField(user, "Source end", "0", { alt: true });
      expect(await screen.findByText(/end > start/)).toBeInTheDocument();
      expect(updatePendingEdit).not.toHaveBeenCalled();
      const box = screen.getByRole("spinbutton", { name: "Source end" });
      box.focus();
      await user.keyboard("{Enter}");
      const input = screen.getByRole("textbox", { name: "Source end" });
      fireEvent.change(input, { target: { value: "2.5" } });
      fireEvent.blur(input);
      await waitFor(() => expect(updatePendingEdit).toHaveBeenCalledTimes(1));
      expect((updatePendingEdit.mock.calls[0] as unknown[])[4]).toBe(true);
    });

    it("sends snap off for a commit made with Alt held, with Approve unchanged", async () => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={guestCut} />);
      expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
      await commitField(user, "Source end", "2.5", { alt: true });
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

    it.each([
      [true, false, true],
      [true, true, false],
      [false, false, false],
      [false, true, true],
    ])(
      "with Snap %s and Alt %s sends snap %s",
      async (snapEnabled, alt, expected) => {
        useDawStore.setState({ snapEnabled });
        const user = userEvent.setup();
        render(<PendingEditBody edit={guestCut} />);
        await commitField(user, "Source end", "2.5", { alt });
        expect((updatePendingEdit.mock.calls[0] as unknown[])[4]).toBe(
          expected,
        );
      },
    );

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
