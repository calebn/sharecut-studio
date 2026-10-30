import { act, render, screen, waitFor } from "@testing-library/react";
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

const postGuest = vi.hoisted(() => vi.fn());
vi.mock("../../api/documentTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/documentTransport")>()),
  postGuestDocumentCommand: postGuest,
}));

const createComment = vi.fn();
const addCommentReply = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  createComment: (...args: unknown[]) => createComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
}));

const PENDING_LABEL = "Trim the long pause";
const NAME_KEY = "podcast-mcp-guest-comment-name";

const CAPS = {
  view: ["view"],
  comment: ["view", "comment"],
  edit: ["view", "comment", "edit"],
};

function join(
  mode: "view" | "comment" | "edit",
  comments = [sampleComment()],
  pending = [pendingEditView({ label: PENDING_LABEL })],
) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      comments,
      pending_edits: pending,
      timeline_duration_sec: 600,
    }),
    mode,
    CAPS[mode],
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
    postGuest.mockReset().mockResolvedValue({ ok: true, data: {} });
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

  it("says so when a guest has no comments, not that there is nothing to decide", () => {
    join("view", []);
    render(<ReviewHost guestShare />);
    expect(screen.getAllByText("No comments yet").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing to decide")).toBeNull();
  });

  it.each(["view", "comment"] as const)(
    "keeps the host's suggested cuts out of a %s guest's queue",
    (mode) => {
      join(mode);
      render(<ReviewHost guestShare />);
      expect(screen.queryByText(PENDING_LABEL)).toBeNull();
      expect(
        [...document.querySelectorAll(".rv-group")].map((g) =>
          g.getAttribute("aria-label"),
        ),
      ).toEqual(["Comments"]);
      expect(screen.getByText(/of 1 resolved/)).toBeVisible();
      expect(screen.queryByText(/saves/)).toBeNull();
      expect(screen.queryByRole("button", { name: /^Suggestions/ })).toBeNull();
    },
  );

  it("gives an Editor the suggested cuts to Cut or Keep, without Find more, Deliver or Resolve", () => {
    join("edit", []);
    render(<ReviewHost guestShare />);
    expect(screen.getAllByText(PENDING_LABEL).length).toBeGreaterThan(0);
    expect(screen.getByText(/of 1 decided/)).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /^Cut/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: /^Keep/ }).length,
    ).toBeGreaterThan(0);
    for (const label of [/Find more/, /Deliver/, /Fix/, /Looks right/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("holds an unsure-flagged cut for an Editor with no unsure-word row, Fix or enabled Cut", () => {
    join(
      "edit",
      [],
      [
        pendingEditView({
          label: PENDING_LABEL,
          unsure_words: [
            {
              track_id: "mira-voice",
              source_id: null,
              word_index: 3,
              text: "maybe",
              confidence: 0.4,
            },
          ],
        }),
      ],
    );
    render(<ReviewHost guestShare />);
    expect(
      [...document.querySelectorAll(".rv-group")].map((g) =>
        g.getAttribute("aria-label"),
      ),
    ).not.toContain("Unsure words");
    expect(
      screen.getByText("The host checks the unsure word first."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    expect(screen.queryByText(/to decide one by one/)).toBeNull();
    for (const label of [/Fix/, /Looks right/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("gives an Editor link whose capabilities have not arrived comments only, with no suggested cuts", () => {
    useDawStore.getState().hydrate(
      "share:tok",
      minimalProject({
        comments: [sampleComment({ body: "Cut the intro" })],
        pending_edits: [pendingEditView({ label: PENDING_LABEL })],
        timeline_duration_sec: 600,
      }),
      "edit",
      null,
    );
    useDawStore.setState({ stage: "review", commentDraft: null });
    render(<ReviewHost guestShare />);
    expect(screen.queryByText(PENDING_LABEL)).toBeNull();
    expect(
      [...document.querySelectorAll(".rv-group")].map((g) =>
        g.getAttribute("aria-label"),
      ),
    ).toEqual(["Comments"]);
    for (const label of [/^Cut/, /^Keep/, /Find more/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("sends an Editor's Cut as ApproveEdits", async () => {
    const user = userEvent.setup();
    join("edit", []);
    render(<ReviewHost guestShare />);
    await user.click(screen.getAllByRole("button", { name: /^Cut/ })[0]);
    await waitFor(() =>
      expect(postGuest).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({ type: "ApproveEdits" }),
      ),
    );
  });

  it("shows the same pending edit to the host, so the guest test can tell", () => {
    useDawStore.getState().hydrate(
      "/tmp/host/episode.sharecut",
      minimalProject({
        pending_edits: [pendingEditView({ label: PENDING_LABEL })],
      }),
    );
    useDawStore.setState({ stage: "review", guestMode: null });
    render(<ReviewHost />);
    expect(screen.getAllByText(PENDING_LABEL).length).toBeGreaterThan(0);
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

  it("leaves a blank name blank after a failed post, and never saves it", async () => {
    const user = userEvent.setup();
    createComment.mockRejectedValueOnce(new Error("Server said no"));
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "Try");
    await user.click(post());
    await screen.findByRole("alert");
    expect(name()).toHaveValue("");
    await user.click(post());
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(2));
    expect(name()).toHaveValue("");
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
