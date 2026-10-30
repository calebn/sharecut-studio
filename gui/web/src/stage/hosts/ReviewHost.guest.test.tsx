import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  minimalProject,
  pendingEditView,
  sampleComment,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { ReviewHost } from "./ReviewHost";

const createComment = vi.fn();
const addCommentReply = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  createComment: (...args: unknown[]) => createComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
}));

const NAME_KEY = "podcast-mcp-guest-comment-name";

function join(mode: "view" | "comment", comments = [sampleComment()]) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      comments,
      pending_edits: [pendingEditView()],
      timeline_duration_sec: 600,
    }),
    mode,
    mode === "view" ? ["view"] : ["view", "comment"],
  );
  useDawStore.setState({
    stage: "review",
    playheadSec: 0,
    selection: null,
    commentDraft: null,
  });
}

const field = () => screen.getByRole("textbox", { name: "Comment" });
const post = () => screen.getByRole("button", { name: "Post" });
const name = () => screen.getByRole("textbox", { name: "Your name" });

describe("Review queue for a guest", () => {
  beforeEach(() => {
    localStorage.clear();
    stubViewportShell("desktop");
    createComment.mockReset().mockResolvedValue(sampleComment({ id: "new" }));
    addCommentReply.mockReset().mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it("gives a viewer the comments and no field, reply, Resolve or decision", () => {
    join("view", [sampleComment({ body: "Cut the intro" })]);
    render(<ReviewHost guestShare />);
    expect(screen.getAllByText("Cut the intro")[0]).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Comment$/ })).toBeNull();
    for (const label of [/Resolve/, /^Cut/, /^Keep/, /Find more/, /Deliver/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("keeps the host's pending edits out of a guest's queue", () => {
    join("comment");
    render(<ReviewHost guestShare />);
    const groups = screen.getAllByRole("region", { name: /./ });
    expect(
      groups.filter((g) => g.className === "rv-group").map((g) => g.ariaLabel),
    ).toEqual(["Comments"]);
  });

  it("gives a commenter the field and no Resolve or decision", () => {
    join("comment");
    render(<ReviewHost guestShare />);
    expect(field()).toBeVisible();
    for (const label of [/Resolve/, /^Cut/, /^Keep/, /Find more/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("posts a blank name as Guest and keeps no saved name", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "Hello");
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ body: "Hello", author: "Guest" }),
    );
    expect(localStorage.getItem(NAME_KEY)).toBeNull();
  });

  it("posts under the typed name and keeps it for the next comment", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(name(), "Dana");
    await user.type(field(), "One");
    await user.click(post());
    await user.type(field(), "Two");
    await user.click(post());
    for (const call of [1, 2])
      expect(createComment).toHaveBeenNthCalledWith(
        call,
        "share:tok",
        expect.objectContaining({ author: "Dana" }),
      );
    expect(localStorage.getItem(NAME_KEY)).toBe("Dana");
  });

  it("keeps the text and shows the reason when the post fails", async () => {
    const user = userEvent.setup();
    createComment.mockRejectedValueOnce(new Error("Server said no"));
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "Try");
    await user.click(post());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server said no",
    );
    expect(field()).toHaveValue("Try");
  });

  it("follows the playhead until typing, then pins where typing began", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    act(() => useDawStore.setState({ playheadSec: 65 }));
    expect(screen.getByText("1:05")).toBeVisible();
    await user.type(field(), "x");
    act(() => useDawStore.setState({ playheadSec: 130 }));
    expect(screen.getByText("1:05")).toBeVisible();
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ timelineStart: 65 }),
    );
  });

  it("replies as Guest with no extra prompt", async () => {
    const user = userEvent.setup();
    join("comment", [sampleComment({ id: "c1" })]);
    render(<ReviewHost guestShare />);
    await user.type(screen.getByRole("textbox", { name: /^Reply/ }), "thanks");
    await user.click(screen.getByRole("button", { name: /^Reply/ }));
    expect(addCommentReply).toHaveBeenCalledWith("share:tok", "c1", {
      body: "thanks",
      author: "Guest",
    });
  });

  it("is axe-clean with the field and a comment", async () => {
    join("comment");
    const { container } = render(<ReviewHost guestShare />);
    await expectNoA11yViolations(container);
  });
});
