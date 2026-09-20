import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { sampleComment } from "../test/fixtures";
import { CommentCard } from "./CommentCard";

describe("CommentCard", () => {
  it("calls onResolve(true) for open comments", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          onResolve={onResolve}
          showReply={false}
        />
      </ul>,
    );
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it("calls onResolve(false) to reopen", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment({
            resolved: true,
            resolved_by: "alex",
            resolved_at: "2026-01-02T00:00:00Z",
          })}
          onResolve={onResolve}
          showReply={false}
        />
      </ul>,
    );
    await user.click(screen.getByRole("button", { name: /Reopen/ }));
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it("replies via draft + Reply button", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn();
    const onReplyDraftChange = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          replyDraft="Looks good"
          onReplyDraftChange={onReplyDraftChange}
          onReply={onReply}
          showResolve={false}
        />
      </ul>,
    );
    const input = screen.getByPlaceholderText("Reply…");
    await user.clear(input);
    await user.type(input, "x");
    expect(onReplyDraftChange).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledOnce();
  });

  it("selects the card when onSelect is provided", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          onSelect={onSelect}
          showResolve={false}
          showReply={false}
        />
      </ul>,
    );
    await user.click(
      screen.getByRole("button", { name: /Needs a tighter open/ }),
    );
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("keeps action checkboxes enabled on a guest share when onToggleAction is set", async () => {
    const user = userEvent.setup();
    const onToggleAction = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment({
            action_items: [
              {
                id: "a1",
                text: "Trim intro",
                done: false,
                completed_at: null,
                completed_by: null,
              },
            ],
          })}
          guestShare
          showResolve
          showReply={false}
          onToggleAction={onToggleAction}
        />
      </ul>,
    );
    expect(
      screen.queryByRole("button", { name: "Resolve" }),
    ).not.toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /Trim intro/ });
    expect(box).toBeEnabled();
    await user.click(box);
    expect(onToggleAction).toHaveBeenCalledWith("a1", true);
  });

  it("shows action items as read-only when they cannot be toggled", () => {
    render(
      <ul>
        <CommentCard
          comment={sampleComment({
            action_items: [
              {
                id: "a1",
                text: "Trim intro",
                done: false,
                completed_at: null,
                completed_by: null,
              },
            ],
          })}
          guestShare
          showResolve={false}
          showReply={false}
        />
      </ul>,
    );
    expect(screen.getByRole("checkbox", { name: /Trim intro/ })).toBeDisabled();
  });

  it("is axe-clean with resolve and reply controls", async () => {
    const { container } = render(
      <ul>
        <CommentCard
          comment={sampleComment({
            action_items: [
              {
                id: "a1",
                text: "Trim intro",
                done: false,
                completed_at: null,
                completed_by: null,
              },
            ],
            replies: [
              {
                id: "r1",
                body: "Agreed",
                author: "guest",
                created_at: "2026-01-01T01:00:00Z",
              },
            ],
          })}
          replyDraft=""
          onReplyDraftChange={() => {}}
          onReply={() => {}}
          onResolve={() => {}}
          onToggleAction={() => {}}
        />
      </ul>,
    );
    const card = within(container)
      .getByText("Needs a tighter open")
      .closest("li");
    expect(card).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
