import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS } from "../hooks/touchGestureTiming";
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

  it("long-press selects without also resolving", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const onResolve = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          onSelect={onSelect}
          onResolve={onResolve}
          showReply={false}
        />
      </ul>,
    );
    const main = screen.getByRole("button", { name: /Needs a tighter open/ });
    fireEvent.pointerDown(main, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    vi.advanceTimersByTime(550);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.pointerUp(main, {
      pointerType: "touch",
      pointerId: 1,
      clientX: 40,
      clientY: 20,
    });
    vi.runOnlyPendingTimers();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onResolve).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("swipe left resolves an open host comment but vertical movement does not", () => {
    const onResolve = vi.fn();
    const onSelect = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          onResolve={onResolve}
          onSelect={onSelect}
          showReply={false}
          swipeToResolve
        />
      </ul>,
    );
    const card = screen.getByText("Needs a tighter open").closest("li");
    expect(card).not.toBeNull();
    fireEvent.pointerDown(card!, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerMove(card!, {
      pointerId: 1,
      clientX: 40,
      clientY: 50,
    });
    fireEvent.pointerUp(card!, {
      pointerId: 1,
      clientX: 40,
      clientY: 50,
    });
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.pointerDown(card!, {
      pointerType: "touch",
      pointerId: 2,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerUp(card!, {
      pointerId: 2,
      clientX: 40,
      clientY: 20,
    });
    expect(onResolve).toHaveBeenCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: /Needs a tighter open/ }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("drag feedback follows the finger and arms past the threshold", () => {
    const onResolve = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          onResolve={onResolve}
          showReply={false}
          swipeToResolve
        />
      </ul>,
    );
    const li = screen.getByText("Needs a tighter open").closest("li");
    expect(li).not.toBeNull();
    fireEvent.pointerDown(li!, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerMove(li!, { pointerId: 1, clientX: 80, clientY: 20 });
    expect(li).toHaveClass("swiping");
    expect(li!.style.getPropertyValue("--swipe-dx")).toBe("-20px");
    const reveal = li!.querySelector(".comment-card-swipe-reveal");
    expect(reveal).not.toBeNull();
    expect(reveal).toHaveAttribute("aria-hidden", "true");
    expect(reveal).not.toHaveClass("armed");

    fireEvent.pointerMove(li!, { pointerId: 1, clientX: 40, clientY: 20 });
    expect(li!.querySelector(".comment-card-swipe-reveal")).toHaveClass(
      "armed",
    );

    fireEvent.pointerMove(li!, { pointerId: 1, clientX: -200, clientY: 20 });
    expect(li!.style.getPropertyValue("--swipe-dx")).toBe("-96px");

    fireEvent.pointerUp(li!, { pointerId: 1, clientX: -200, clientY: 20 });
    expect(li).not.toHaveClass("swiping");
    expect(li!.querySelector(".comment-card-swipe-reveal")).toBeNull();
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it("rightward drag and vertical travel show no feedback", () => {
    const onResolve = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          onResolve={onResolve}
          showReply={false}
          swipeToResolve
        />
      </ul>,
    );
    const li = screen.getByText("Needs a tighter open").closest("li");
    expect(li).not.toBeNull();
    fireEvent.pointerDown(li!, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerMove(li!, { pointerId: 1, clientX: 160, clientY: 20 });
    expect(li).not.toHaveClass("swiping");
    fireEvent.pointerUp(li!, { pointerId: 1, clientX: 160, clientY: 20 });

    fireEvent.pointerDown(li!, {
      pointerType: "touch",
      pointerId: 2,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerMove(li!, { pointerId: 2, clientX: 40, clientY: 50 });
    expect(li).not.toHaveClass("swiping");
    fireEvent.pointerMove(li!, { pointerId: 2, clientX: 40, clientY: 20 });
    expect(li).not.toHaveClass("swiping");
  });

  it("a hold past long-press does not show a cue", () => {
    vi.useFakeTimers();
    const onResolve = vi.fn();
    render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          onResolve={onResolve}
          showReply={false}
          swipeToResolve
        />
      </ul>,
    );
    const li = screen.getByText("Needs a tighter open").closest("li");
    expect(li).not.toBeNull();
    fireEvent.pointerDown(li!, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerMove(li!, { pointerId: 1, clientX: 40, clientY: 20 });
    expect(li).not.toHaveClass("swiping");
    vi.useRealTimers();
  });

  it.each([
    ["swipe is not opted in", { swipeToResolve: false }],
    ["resolve actions are hidden", { showResolve: false }],
    ["the viewer is a guest", { guestShare: true }],
    ["a request is in flight", { busy: true }],
    [
      "the comment is already resolved",
      { comment: sampleComment({ resolved: true, resolved_by: "alex" }) },
    ],
  ])("does not resolve by swipe when %s", (_name, overrides) => {
    const onResolve = vi.fn();
    const { container } = render(
      <ul>
        <CommentCard
          comment={sampleComment()}
          onResolve={onResolve}
          swipeToResolve
          {...overrides}
        />
      </ul>,
    );
    const card = container.querySelector(".comment-card");
    expect(card).not.toBeNull();
    fireEvent.pointerDown(card!, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerMove(card!, { pointerId: 1, clientX: 40, clientY: 20 });
    expect(card).not.toHaveClass("swiping");
    fireEvent.pointerUp(card!, {
      pointerId: 1,
      clientX: 40,
      clientY: 20,
    });
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("holding an action item label toggles it instead of arming long-press", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
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
          onSelect={onSelect}
          onToggleAction={onToggleAction}
          showReply={false}
        />
      </ul>,
    );
    const label = screen.getByText("Trim intro");
    fireEvent.pointerDown(label, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
    });
    vi.advanceTimersByTime(600);
    fireEvent.pointerUp(label, { pointerType: "touch", pointerId: 1 });
    fireEvent.click(label);
    vi.runOnlyPendingTimers();
    expect(onToggleAction).toHaveBeenCalledWith("a1", true);
    expect(onSelect).not.toHaveBeenCalled();
    vi.useRealTimers();
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
