import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleComment } from "../../test/fixtures";
import { CommentInspector } from "./CommentInspector";

const patchComment = vi.fn();
const addCommentReply = vi.fn();

vi.mock("../../api", () => ({
  patchComment: (...args: unknown[]) => patchComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
}));

describe("CommentInspector resolve command", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    patchComment.mockReset().mockResolvedValue(null);
    addCommentReply.mockReset().mockResolvedValue(null);
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ comments: [sampleComment()] }));
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("resolves through the shared command", async () => {
    const user = userEvent.setup();
    render(<CommentInspector comment={sampleComment()} onSeek={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(patchComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      "c1",
      expect.objectContaining({ resolved: true, by: expect.any(String) }),
    );
  });

  it("keeps resolve unavailable to guests", () => {
    useDawStore
      .getState()
      .hydrate(
        "/tmp/p.json",
        minimalProject({ comments: [sampleComment()] }),
        "view",
      );
    render(<CommentInspector comment={sampleComment()} onSeek={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("keeps resolve unavailable on a share project key without a guest mode", () => {
    useDawStore
      .getState()
      .hydrate("share:tok", minimalProject({ comments: [sampleComment()] }));
    render(<CommentInspector comment={sampleComment()} onSeek={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });
  it("names its reply input and posts the typed reply", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CommentInspector comment={sampleComment()} onSeek={vi.fn()} />,
    );
    const input = screen.getByRole("textbox", { name: "Reply to comment" });
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
    useDawStore
      .getState()
      .hydrate("share:token", minimalProject(), "view", ["view"]);
    render(<CommentInspector comment={sampleComment()} onSeek={vi.fn()} />);
    expect(
      screen.queryByRole("textbox", { name: "Reply to comment" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reply" }),
    ).not.toBeInTheDocument();
  });

  it("offers the named reply form when a share has comment permission", () => {
    useDawStore
      .getState()
      .hydrate("share:token", minimalProject(), "comment", ["comment"]);
    render(<CommentInspector comment={sampleComment()} onSeek={vi.fn()} />);
    expect(
      screen.getByRole("textbox", { name: "Reply to comment" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resolve" }),
    ).not.toBeInTheDocument();
  });
});
