import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    patchComment.mockReset().mockResolvedValue(null);
    createComment.mockReset();
    addCommentReply.mockReset();
    setCommentActionDone.mockReset();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ comments: [sampleComment()] }));
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

  it("is axe-clean with the toast visible", async () => {
    const user = userEvent.setup();
    const { container } = render(<CommentsPanel />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByText(/Resolved comment at/);
    await expectNoA11yViolations(container);
  });
});
