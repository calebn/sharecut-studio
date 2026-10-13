import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDawCommands } from "../commands/register";
import { commentTimeLabel } from "../comments";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleComment } from "../test/fixtures";
import { CommentsPanel } from "./CommentsPanel";

const patchComment = vi.fn();
const createComment = vi.fn();
const addCommentReply = vi.fn();
const setCommentActionDone = vi.fn();

vi.mock("../api", () => ({
  createComment: (...args: unknown[]) => createComment(...args),
  patchComment: (...args: unknown[]) => patchComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
  setCommentActionDone: (...args: unknown[]) => setCommentActionDone(...args),
}));

describe("CommentsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    registerDawCommands();
    patchComment.mockReset().mockResolvedValue(null);
    createComment.mockReset();
    addCommentReply.mockReset();
    setCommentActionDone.mockReset();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ comments: [sampleComment()] }));
    useDawStore.setState({
      playheadSec: 0,
      selection: null,
      commentDraft: null,
      commentMode: false,
    });
    useDawStore.getState().announceStatus("");
  });

  it("shows an Undo toast after resolving and reopens on Undo", async () => {
    const user = userEvent.setup();
    render(<CommentsPanel />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(patchComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      "c1",
      expect.objectContaining({ resolved: true, by: expect.any(String) }),
    );
    await screen.findByText(/Resolved comment at/);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(patchComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      "c1",
      expect.objectContaining({ resolved: false, by: expect.any(String) }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Resolved comment at/)).not.toBeInTheDocument(),
    );
    expect(useDawStore.getState().statusAnnouncement).toBe("Comment reopened");
  });

  it("shows the error and no toast when resolving fails", async () => {
    patchComment.mockReset().mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<CommentsPanel />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText("boom");
    expect(screen.queryByText(/Resolved comment at/)).not.toBeInTheDocument();
  });

  it("routes swipe resolve through the command and retains the Undo toast", async () => {
    render(<CommentsPanel />);
    const card = screen.getByText("Needs a tighter open").closest("li");
    expect(card).not.toBeNull();
    fireEvent.pointerDown(card!, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerMove(card!, { pointerId: 1, clientX: 40, clientY: 20 });
    fireEvent.pointerUp(card!, { pointerId: 1, clientX: 40, clientY: 20 });
    await waitFor(() => expect(patchComment).toHaveBeenCalledTimes(1));
    await screen.findByText(/Resolved comment at/);
  });

  it("Dismiss hides the toast", async () => {
    const user = userEvent.setup();
    render(<CommentsPanel />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText(/Resolved comment at/);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByText(/Resolved comment at/)).not.toBeInTheDocument(),
    );
  });

  it("hides Resolve and the status toast for a guest share", () => {
    render(<CommentsPanel guestShare />);
    expect(
      screen.queryByRole("button", { name: "Resolve" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("comments as Host by default", () => {
    render(<CommentsPanel />);
    expect(screen.getByText(/Commenting as/)).toBeInTheDocument();
    expect(screen.getByText("Host")).toBeInTheDocument();
  });

  it("shows a saved comment name", () => {
    localStorage.setItem("podcast-mcp-comment-author", "Caleb");
    render(<CommentsPanel />);
    expect(screen.getByText("Caleb")).toBeInTheDocument();
  });

  it("comments as Guest by default for a guest share", () => {
    render(<CommentsPanel guestShare />);
    expect(screen.getByText("Guest")).toBeInTheDocument();
  });

  it("Change then a new name saves it and is used on the next post", async () => {
    const user = userEvent.setup();
    render(<CommentsPanel />);
    await user.click(
      screen.getByRole("button", { name: "Change your comment name" }),
    );
    const input = screen.getByRole("textbox", { name: "Your name" });
    await user.clear(input);
    await user.type(input, "Ada{Enter}");
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(localStorage.getItem("podcast-mcp-comment-author")).toBe("Ada");

    act(() => {
      useDawStore.getState().setCommentMode(true);
      useDawStore.getState().setCommentDraft({ startSec: 1, endSec: null });
    });
    await user.type(
      screen.getByRole("textbox", { name: "Comment" }),
      "Feedback",
    );
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(createComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({ author: "Ada" }),
    );
  });

  it("is axe-clean with the toast visible", async () => {
    const user = userEvent.setup();
    const { container } = render(<CommentsPanel />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText(/Resolved comment at/);
    await expectNoA11yViolations(container);
  });

  it("moves focus to the panel after Undo even when the disabled Undo is blurred", async () => {
    const user = userEvent.setup();
    const { container } = render(<CommentsPanel />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText(/Resolved comment at/);
    let release: (value: null) => void = () => undefined;
    patchComment.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    await user.click(undo);
    expect(undo).toBeDisabled();
    // Chromium's focus fixup blurs the focused Undo once it is disabled;
    // jsdom's native .blur() no-ops on a disabled element, so toggle the
    // underlying DOM property off just long enough to fire a real blur with
    // relatedTarget null, then restore it to match the disabled markup React
    // rendered.
    act(() => {
      (undo as HTMLButtonElement).disabled = false;
      undo.blur();
      (undo as HTMLButtonElement).disabled = true;
    });
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      release(null);
    });
    await waitFor(() =>
      expect(screen.queryByText(/Resolved comment at/)).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(
      container.querySelector(".comments-panel"),
    );
  });

  it.each([
    ["hidden", (panel: HTMLElement) => (panel.style.display = "none")],
    ["inert", (panel: HTMLElement) => panel.setAttribute("inert", "")],
  ])(
    "does not move focus to a %s panel when Dismiss removes the toast",
    async (_, obscure) => {
      const user = userEvent.setup();
      const { container } = render(<CommentsPanel />);
      await user.click(screen.getByRole("button", { name: "Resolve" }));
      await screen.findByText(/Resolved comment at/);
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      act(() => dismiss.focus());
      const panel = container.querySelector<HTMLElement>(".comments-panel");
      if (!panel) throw new Error("missing comments panel");
      obscure(panel);
      fireEvent.click(dismiss);
      await waitFor(() =>
        expect(
          screen.queryByText(/Resolved comment at/),
        ).not.toBeInTheDocument(),
      );
      expect(panel).not.toHaveFocus();
      expect(document.activeElement).toBe(document.body);
    },
  );

  it("keeps only the latest resolve's toast (latest wins)", async () => {
    const first = sampleComment();
    const second = sampleComment({
      id: "c2",
      body: "Trim the outro",
      timeline_start: 30,
    });
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ comments: [first, second] }));
    const user = userEvent.setup();
    render(<CommentsPanel />);
    const [resolveFirst, resolveSecond] = screen.getAllByRole("button", {
      name: "Resolve",
    });
    await user.click(resolveFirst!);
    await screen.findByText(`Resolved comment at ${commentTimeLabel(first)}`);
    await user.click(resolveSecond!);
    await screen.findByText(`Resolved comment at ${commentTimeLabel(second)}`);
    expect(
      screen.queryByText(`Resolved comment at ${commentTimeLabel(first)}`),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(patchComment).toHaveBeenLastCalledWith(
      "/tmp/p.json",
      "c2",
      expect.objectContaining({ resolved: false }),
    );
    expect(patchComment).not.toHaveBeenCalledWith(
      "/tmp/p.json",
      "c1",
      expect.objectContaining({ resolved: false }),
    );
  });

  it("does not announce a reopen after unmounting mid-Undo", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CommentsPanel />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText(/Resolved comment at/);
    let release: (value: null) => void = () => undefined;
    patchComment.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    unmount();
    await act(async () => {
      release(null);
    });
    expect(useDawStore.getState().statusAnnouncement).not.toBe(
      "Comment reopened",
    );
  });
  it("posts at the playhead once the body has text, with no ruler press", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValueOnce(sampleComment({ id: "c2" }));
    act(() => useDawStore.getState().setPlayheadSec(21.4));
    render(<CommentsPanel />);
    const post = screen.getByRole("button", { name: "Post comment" });
    expect(post).toBeDisabled();
    expect(useDawStore.getState().commentMode).toBe(false);
    expect(
      screen.getByRole("button", { name: "Comment at 0:21. Change time" }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "Tight");
    await user.click(post);
    expect(createComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({
        body: "Tight",
        timelineStart: 21.4,
        timelineEnd: null,
        trackIds: [],
      }),
    );
  });

  it.each(["desktop", "tablet", "phone"] as const)(
    "after Post on %s keeps the field focused, shows the toast and selects nothing",
    async (shellBreakpoint) => {
      const user = userEvent.setup();
      createComment.mockResolvedValueOnce(
        sampleComment({ id: "c9", timeline_start: 21.4 }),
      );
      useDawStore.setState({ shellBreakpoint, playheadSec: 3 });
      render(<CommentsPanel />);
      const field = screen.getByRole("textbox", { name: "Comment" });
      await user.type(field, "Tight");
      await user.click(screen.getByRole("button", { name: "Post comment" }));
      await waitFor(() => expect(field).toHaveValue(""));
      const state = useDawStore.getState();
      expect(state.selection).toBeNull();
      expect(state.playheadSec).toBe(3);
      expect(state.feedbackToast?.message).toMatch(/^Comment posted at /);
      expect(field).toHaveFocus();
    },
  );

  it("anchors to the selected range when there is one", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValueOnce(sampleComment({ id: "c3" }));
    act(() => {
      useDawStore.getState().setPlayheadSec(2);
      useDawStore.getState().setSelection({
        kind: "range",
        target: {
          kind: "exact_range",
          intervals: [{ start: 4, end: 9.4 }],
          track_ids: ["host"],
          clips: [],
          media_seals: {},
        },
      });
    });
    render(<CommentsPanel />);
    expect(
      screen.getByRole("button", { name: "Comment at 0:04–0:09. Change time" }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "Cut");
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(createComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({
        timelineStart: 4,
        timelineEnd: 9.4,
        trackIds: ["host"],
        timelineSpans: [{ start: 4, end: 9.4 }],
      }),
    );
  });

  it("a typed time on the chip sets the anchor; one that does not parse keeps it", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValueOnce(sampleComment({ id: "c4" }));
    const { container } = render(<CommentsPanel />);
    await user.click(
      screen.getByRole("button", { name: "Comment at 0:00. Change time" }),
    );
    const field = screen.getByRole("textbox", { name: "Comment time" });
    expect(field).toHaveFocus();
    await expectNoA11yViolations(container);
    await user.clear(field);
    await user.type(field, "soon{Enter}");
    expect(
      screen.getByRole("button", { name: "Comment at 0:00. Change time" }),
    ).toHaveFocus();
    await user.click(
      screen.getByRole("button", { name: "Comment at 0:00. Change time" }),
    );
    await user.clear(screen.getByRole("textbox", { name: "Comment time" }));
    await user.type(
      screen.getByRole("textbox", { name: "Comment time" }),
      "0:42{Enter}",
    );
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "Here");
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(createComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({ timelineStart: 42, timelineEnd: null }),
    );
    expect(useDawStore.getState().commentDraft).toBeNull();
  });

  it("Escape on the chip field keeps the time it had", async () => {
    const user = userEvent.setup();
    render(<CommentsPanel />);
    await user.click(
      screen.getByRole("button", { name: "Comment at 0:00. Change time" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Comment time" }),
      "{Control>}a{/Control}0:30{Escape}",
    );
    expect(
      screen.getByRole("button", { name: "Comment at 0:00. Change time" }),
    ).toHaveFocus();
    expect(useDawStore.getState().commentDraft).toBeNull();
  });

  it("shows a Viewer link no comment field and no Comment mode", () => {
    useDawStore
      .getState()
      .hydrate("share:tok", minimalProject(), "view", ["view"]);
    render(<CommentsPanel guestShare />);
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Comment mode/ })).toBeNull();
  });

  it("opens a Commenter link on the Comments tab with its field", () => {
    useDawStore
      .getState()
      .hydrate("share:tok", minimalProject(), "comment", ["view", "comment"]);
    expect(useDawStore.getState().activeTab).toBe("comments");
    render(<CommentsPanel guestShare />);
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeVisible();
  });

  it("names action items while composing and includes them in the post", async () => {
    const user = userEvent.setup();
    act(() => {
      useDawStore.getState().setCommentMode(true);
      useDawStore.getState().setCommentDraft({ startSec: 3, endSec: null });
    });
    createComment.mockResolvedValueOnce(sampleComment());
    const { container } = render(<CommentsPanel />);
    expect(
      screen.queryByRole("textbox", {
        name: "Action items (one per line, optional)",
      }),
    ).toBeNull();
    await user.type(
      screen.getByRole("textbox", { name: "Comment" }),
      "Review the opening",
    );
    const actions = screen.getByRole("textbox", {
      name: "Action items (one per line, optional)",
    });
    await user.type(actions, "Trim pause{Enter}Check spelling");
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(createComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({
        body: "Review the opening",
        actionTexts: ["Trim pause", "Check spelling"],
      }),
    );
  });
});
