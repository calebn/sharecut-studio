import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleComment } from "../../test/fixtures";
import { CommentInspector } from "./CommentInspector";

const patchComment = vi.fn();

vi.mock("../../api", () => ({
  patchComment: (...args: unknown[]) => patchComment(...args),
}));

describe("CommentInspector resolve command", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    patchComment.mockReset().mockResolvedValue(null);
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
});
