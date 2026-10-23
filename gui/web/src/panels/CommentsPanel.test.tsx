import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDawCommands } from "../commands/register";
import { commentTimeLabel } from "../comments";
import { FeedbackToast } from "../feedback/FeedbackToast";
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

function renderPanel(props: { guestShare?: boolean } = {}) {
  return render(
    <>
      <CommentsPanel {...props} />
      <FeedbackToast />
    </>,
  );
}

describe("CommentsPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: (
          entries: { isIntersecting: boolean; intersectionRatio: number }[],
        ) => void;
        constructor(
          callback: (
            entries: { isIntersecting: boolean; intersectionRatio: number }[],
          ) => void,
        ) {
          this.callback = callback;
        }
        observe() {
          this.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
        }
        disconnect() {}
      },
    );
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
    renderPanel();
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
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText("boom");
    expect(screen.queryByText(/Resolved comment at/)).not.toBeInTheDocument();
  });

  it("routes swipe resolve through the command and retains the Undo toast", async () => {
    renderPanel();
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
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText(/Resolved comment at/);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByText(/Resolved comment at/)).not.toBeInTheDocument(),
    );
  });

  it("hides Resolve and the status toast for a guest share", () => {
    renderPanel({ guestShare: true });
    expect(
      screen.queryByRole("button", { name: "Resolve" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("comments as Host by default", () => {
    renderPanel();
    expect(screen.getByText(/Commenting as/)).toBeInTheDocument();
    expect(screen.getByText("Host")).toBeInTheDocument();
  });

  it("shows a saved comment name", () => {
    localStorage.setItem("podcast-mcp-comment-author", "Caleb");
    renderPanel();
    expect(screen.getByText("Caleb")).toBeInTheDocument();
  });

  it("comments as Guest by default for a guest share", () => {
    renderPanel({ guestShare: true });
    expect(screen.getByText("Guest")).toBeInTheDocument();
  });

  it("asks a guest for a name on the first post, once, in the panel too", async () => {
    const user = userEvent.setup();
    localStorage.clear();
    createComment.mockResolvedValue(sampleComment());
    renderPanel({ guestShare: true });
    await user.type(
      screen.getByRole("textbox", { name: "Comment" }),
      "From landscape",
    );
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(createComment).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole("textbox", { name: "Your name" }),
      "Dana{Enter}",
    );
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ author: "Dana" }),
    );
    expect(screen.queryByRole("textbox", { name: "Your name" })).toBeNull();
  });

  it("Change then a new name saves it and is used on the next post", async () => {
    const user = userEvent.setup();
    renderPanel();
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
    const { container } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText(/Resolved comment at/);
    await expectNoA11yViolations(container);
  });

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
    renderPanel();
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

  it("finishes a reopen the panel unmounts during, and says so", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPanel();
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
    expect(useDawStore.getState().statusAnnouncement).toBe("Comment reopened");
  });

  it("does not reopen a comment in another project", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText(/Resolved comment at/);
    patchComment.mockClear();
    useDawStore.setState({ projectPath: "/tmp/other.json" });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(patchComment).not.toHaveBeenCalled();
  });

  it("an empty filter offers the way back to the other comments", async () => {
    const user = userEvent.setup();
    useDawStore
      .getState()
      .hydrate(
        "/tmp/p.json",
        minimalProject({ comments: [sampleComment({ resolved: true })] }),
      );
    const { container } = renderPanel();
    expect(screen.getByText("No comments in this filter.")).toBeVisible();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Show all comments" }));
    expect(screen.getByText("Needs a tighter open")).toBeVisible();
  });

  it("with no comments at all, the empty state sends the person to the composer", async () => {
    const user = userEvent.setup();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ comments: [] }));
    renderPanel();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("No comments yet.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add a comment" }));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveFocus();
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

  it("keeps a range comment's range when the time chip is edited", async () => {
    const user = userEvent.setup();
    act(() => {
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
    const chip = () =>
      screen.getByRole("button", { name: /^Comment at .* Change time$/ });
    const edit = async (text: string) => {
      await user.click(chip());
      const field = screen.getByRole("textbox", { name: "Comment time" });
      await user.clear(field);
      await user.type(field, `${text}{Enter}`);
    };
    await user.click(chip());
    expect(screen.getByRole("textbox", { name: "Comment time" })).toHaveValue(
      "0:04–0:09",
    );
    await user.keyboard("{Escape}");
    expect(useDawStore.getState().commentDraft).toBeNull();

    expect(screen.queryByText(/^Selection is/)).toBeNull();
    await edit("0:20");
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 20,
      endSec: 25.4,
      trackIds: ["host"],
      intervals: [{ start: 20, end: 25.4 }],
    });
    expect(screen.getByText("Selection is 0:04–0:09")).toBeInTheDocument();
    await edit("0:30–0:25");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "End must be after start",
    );
    expect(useDawStore.getState().commentDraft).toMatchObject({
      startSec: 20,
    });
    await user.click(chip());
    expect(screen.queryByRole("alert")).toBeNull();
    await user.keyboard("{Escape}");
    await edit("0:21–0:30");
    expect(useDawStore.getState().commentDraft).toMatchObject({
      startSec: 21,
      endSec: 30,
      trackIds: ["host"],
      intervals: [{ start: 21, end: 30 }],
    });
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
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Try 0:42 or 0:20–0:30",
    );
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
