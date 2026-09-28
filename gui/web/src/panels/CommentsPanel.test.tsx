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
});
