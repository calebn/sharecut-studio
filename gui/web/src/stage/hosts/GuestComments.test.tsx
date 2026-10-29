import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleComment } from "../../test/fixtures";
import { GuestComments } from "./GuestComments";

const createComment = vi.fn();
const addCommentReply = vi.fn();
const seekTransport = vi.hoisted(() => vi.fn());

vi.mock("../../api", () => ({
  createComment: (...args: unknown[]) => createComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
  setCommentActionDone: vi.fn(),
  patchComment: vi.fn(),
}));
vi.mock("../../commands/seek", () => ({ seekTransport }));

const NAME_KEY = "podcast-mcp-guest-comment-name";

function join(mode: "view" | "comment", comments = [sampleComment()]) {
  useDawStore
    .getState()
    .hydrate(
      "share:tok",
      minimalProject({ comments, timeline_duration_sec: 600 }),
      mode,
      mode === "view" ? ["view"] : ["view", "comment"],
    );
  useDawStore.setState({ playheadSec: 0, selection: null, commentDraft: null });
}

const field = () => screen.getByRole("textbox", { name: "Comment" });
const post = () => screen.getByRole("button", { name: "Post" });

describe("GuestComments", () => {
  beforeEach(() => {
    localStorage.clear();
    createComment.mockReset().mockResolvedValue(sampleComment({ id: "new" }));
    addCommentReply.mockReset().mockResolvedValue({});
    seekTransport.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("gives a viewer the comments with no field, reply or Resolve", () => {
    join("view", [sampleComment({ body: "Cut the intro" })]);
    render(<GuestComments guestShare />);
    expect(screen.getByText("Cut the intro")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Resolve/ })).toBeNull();
  });

  it("gives a commenter the field and no Resolve", () => {
    join("comment");
    render(<GuestComments guestShare />);
    expect(field()).toBeVisible();
    expect(screen.queryByRole("button", { name: /Resolve/ })).toBeNull();
  });

  it("asks for a name with the first post and a blank name posts as Guest", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<GuestComments guestShare />);
    expect(screen.getByRole("textbox", { name: "Your name" })).toBeVisible();
    await user.type(field(), "Hello");
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ body: "Hello", author: "Guest" }),
    );
    expect(screen.queryByRole("textbox", { name: "Your name" })).toBeNull();
  });

  it("posts under the typed name, then comments as that name without asking again", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<GuestComments guestShare />);
    await user.type(screen.getByRole("textbox", { name: "Your name" }), "Dana");
    await user.type(field(), "One");
    await user.click(post());
    await user.type(field(), "Two");
    await user.click(post());
    expect(createComment).toHaveBeenNthCalledWith(
      1,
      "share:tok",
      expect.objectContaining({ author: "Dana" }),
    );
    expect(createComment).toHaveBeenNthCalledWith(
      2,
      "share:tok",
      expect.objectContaining({ author: "Dana" }),
    );
    expect(localStorage.getItem(NAME_KEY)).toBe("Dana");
    expect(screen.getByText("Dana")).toBeVisible();
  });

  it("works with storage blocked: asks once per page load and still posts", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    join("comment");
    render(<GuestComments guestShare />);
    await user.type(screen.getByRole("textbox", { name: "Your name" }), "Ola");
    await user.type(field(), "One");
    await user.click(post());
    await user.type(field(), "Two");
    await user.click(post());
    expect(createComment).toHaveBeenCalledTimes(2);
    expect(createComment).toHaveBeenLastCalledWith(
      "share:tok",
      expect.objectContaining({ author: "Ola" }),
    );
  });

  it("keeps the text and shows the reason when the post fails", async () => {
    const user = userEvent.setup();
    createComment.mockRejectedValueOnce(new Error("Server said no"));
    join("comment");
    render(<GuestComments guestShare />);
    await user.type(field(), "Try");
    await user.click(post());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server said no",
    );
    expect(field()).toHaveValue("Try");
    expect(screen.getByRole("textbox", { name: "Your name" })).toBeVisible();
    expect(localStorage.getItem(NAME_KEY)).toBeNull();
  });

  it("anchors at the playhead, follows it until typing, then pins", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<GuestComments guestShare />);
    act(() => useDawStore.setState({ playheadSec: 65 }));
    expect(
      screen.getByRole("button", { name: /^Comment at 1:05, follows/ }),
    ).toBeVisible();
    await user.type(field(), "x");
    act(() => useDawStore.setState({ playheadSec: 130 }));
    expect(
      screen.getByRole("button", { name: /^Pinned at 1:05/ }),
    ).toBeVisible();
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ timelineStart: 65, timelineEnd: null }),
    );
    expect(
      screen.getByRole("button", { name: /^Comment at 2:10, follows/ }),
    ).toBeVisible();
  });

  it("re-anchors to the playhead when the chip is tapped", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<GuestComments guestShare />);
    act(() => useDawStore.setState({ playheadSec: 10 }));
    await user.type(field(), "x");
    act(() => useDawStore.setState({ playheadSec: 90 }));
    await user.click(screen.getByRole("button", { name: /^Pinned at 0:10/ }));
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ timelineStart: 90 }),
    );
  });

  it("posts a whole-episode note and shows it with no time", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<GuestComments guestShare />);
    await user.click(
      screen.getByRole("button", { name: "Make it a whole-episode note" }),
    );
    await user.type(field(), "Overall good");
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ timelineStart: 0, timelineEnd: 600 }),
    );
    act(() =>
      useDawStore.getState().hydrate(
        "share:tok",
        minimalProject({
          timeline_duration_sec: 600,
          comments: [
            sampleComment({
              body: "Overall good",
              timeline_start: 0,
              timeline_end: 600,
            }),
          ],
        }),
        "comment",
        ["view", "comment"],
      ),
    );
    expect(screen.getByText("Overall good")).toBeVisible();
    expect(screen.queryByText(/10:00/)).toBeNull();
  });

  it("uses a range the ruler set, then drops it after the post", async () => {
    const user = userEvent.setup();
    join("comment");
    act(() =>
      useDawStore.getState().setCommentDraft({ startSec: 20, endSec: 30 }),
    );
    render(<GuestComments guestShare />);
    await user.type(field(), "This part");
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ timelineStart: 20, timelineEnd: 30 }),
    );
    expect(useDawStore.getState().commentDraft).toBeNull();
  });

  it("lets a range the ruler sets after typing replace the pin, with its own tracks", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<GuestComments guestShare />);
    act(() => useDawStore.setState({ playheadSec: 5 }));
    await user.type(field(), "x");
    act(() =>
      useDawStore.getState().setCommentDraft({
        startSec: 30,
        endSec: 40,
        trackIds: ["t1"],
        intervals: [{ start: 30, end: 40 }],
      }),
    );
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({
        timelineStart: 30,
        timelineEnd: 40,
        trackIds: ["t1"],
        timelineSpans: [{ start: 30, end: 40 }],
      }),
    );
  });

  it("replies under the chosen name, else Guest, with no extra prompt", async () => {
    const user = userEvent.setup();
    join("comment", [sampleComment({ id: "c1" })]);
    render(<GuestComments guestShare />);
    await user.type(screen.getByRole("textbox", { name: /^Reply/ }), "thanks");
    await user.click(screen.getByRole("button", { name: /^Reply/ }));
    expect(addCommentReply).toHaveBeenCalledWith("share:tok", "c1", {
      body: "thanks",
      author: "Guest",
    });
    expect(localStorage.getItem(NAME_KEY)).toBeNull();
  });

  it("jumps the playhead to a comment's time", async () => {
    const user = userEvent.setup();
    join("view", [sampleComment({ id: "c1", timeline_start: 42 })]);
    render(<GuestComments guestShare />);
    await user.click(screen.getByRole("button", { name: /0:42/ }));
    expect(seekTransport).toHaveBeenCalledWith(42);
  });

  it("is axe-clean with the field and a comment", async () => {
    join("comment");
    const { container } = render(<GuestComments guestShare />);
    await expectNoA11yViolations(container);
  });
});
