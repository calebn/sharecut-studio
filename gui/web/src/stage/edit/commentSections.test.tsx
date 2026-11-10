import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  minimalProject,
  pendingEditView,
  sampleComment,
} from "../../test/fixtures";
import { useCommentSections } from "./commentSections";
import { SectionsBody } from "./SectionsBody";

const patchComment = vi.fn();
const addCommentReply = vi.fn();
const seekTransport = vi.fn();

vi.mock("../../api", () => ({
  patchComment: (...args: unknown[]) => patchComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
}));
vi.mock("../../commands/seek", () => ({
  seekTransport: (...args: unknown[]) => seekTransport(...args),
}));

type Hydrate = [string, ...unknown[]];

function open(
  hydrateArgs: Hydrate = ["/tmp/p.json"],
  comment = sampleComment(),
) {
  const [path, mode, caps] = hydrateArgs as [string, never, never];
  useDawStore
    .getState()
    .hydrate(path, minimalProject({ comments: [comment] }), mode, caps);
  useDawStore.getState().setSelection({ kind: "comment", id: comment.id });
  return render(<SectionsBody withRange={false} />);
}

describe("comment sheet sections", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    patchComment.mockReset().mockResolvedValue(null);
    addCommentReply.mockReset().mockResolvedValue(null);
    seekTransport.mockReset();
  });

  afterEach(() => {
    clearRegisteredCommands();
    useDawStore.getState().setSelection(null);
  });

  it("reopens through the shared command and offers no Resolve beside the bar's", async () => {
    const user = userEvent.setup();
    open(
      ["/tmp/p.json"],
      sampleComment({ resolved: true, resolved_by: "Mira" }),
    );
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(patchComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      "c1",
      expect.objectContaining({ resolved: false, by: expect.any(String) }),
    );
  });

  it("leaves Resolve to the action bar on an open comment", () => {
    open();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("offers Reopen on a resolved comment", () => {
    open(
      ["/tmp/p.json"],
      sampleComment({ resolved: true, resolved_by: "Mira" }),
    );
    expect(screen.getByRole("button", { name: "Reopen" })).toBeVisible();
    expect(screen.getByText("Resolved by Mira")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("keeps resolve unavailable to guests", () => {
    open(["/tmp/p.json", "view"]);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("keeps resolve unavailable on a share project key without a guest mode", () => {
    open(["share:tok"]);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("shows replies and keeps action items read-only for a viewer", () => {
    const item = { id: "a1", text: "Trim the open", done: false };
    const view = open(
      ["/tmp/p.json"],
      sampleComment({
        action_items: [item as never],
        replies: [{ id: "r1", author: "ana", body: "On it" } as never],
      }),
    );
    expect(screen.getByText("On it")).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Trim the open" }),
    ).toBeEnabled();
    view.unmount();
    open(
      ["share:token", "view", ["view"]],
      sampleComment({ action_items: [item as never] }),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Trim the open")).toBeVisible();
  });

  it("seeks to the comment time", async () => {
    const user = userEvent.setup();
    const comment = sampleComment();
    open(["/tmp/p.json"], comment);
    await user.click(screen.getByRole("button", { name: /\d/ }));
    expect(seekTransport).toHaveBeenCalledWith(comment.timeline_start);
  });

  it("names its reply input and posts the typed reply", async () => {
    const user = userEvent.setup();
    const { container } = open();
    const input = screen.getByRole("textbox", { name: "Reply to caleb" });
    await expectNoA11yViolations(container);
    await user.type(input, "Keep this section");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(addCommentReply).toHaveBeenCalledWith("/tmp/p.json", "c1", {
      body: "Keep this section",
      author: expect.any(String),
    });
    expect(input).toHaveValue("");
  });

  it("hides the reply form from shares without reply permission", () => {
    open(["share:token", "view", ["view"]]);
    expect(
      screen.queryByRole("textbox", { name: "Reply to caleb" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reply" }),
    ).not.toBeInTheDocument();
  });

  it("offers the named reply form when a share has comment permission", () => {
    open(["share:token", "comment", ["comment"]]);
    expect(
      screen.getByRole("textbox", { name: "Reply to caleb" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resolve" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("renders a comment whose linked decision is no longer pending", () => {
    open(["/tmp/p.json"], sampleComment({ edit_decision_id: "gone-edit" }));
    expect(screen.getByRole("button", { name: "Reply" })).toBeVisible();
    expect(screen.getByText("Needs a tighter open")).toBeVisible();
  });

  it("leaves a comment on a pending edit to the pending body", () => {
    const comment = sampleComment({ edit_decision_id: "pe1" });
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        comments: [comment],
        pending_edits: [pendingEditView({ id: "pe1" })],
      }),
    );
    const { result } = renderHook(() =>
      useCommentSections({ kind: "comment", id: comment.id }),
    );
    expect(result.current).toBeNull();
  });

  it("says so when the comment is gone", () => {
    open();
    act(() =>
      useDawStore.getState().setSelection({ kind: "comment", id: "missing" }),
    );
    expect(screen.getByText("Comment not found")).toBeVisible();
  });
});
