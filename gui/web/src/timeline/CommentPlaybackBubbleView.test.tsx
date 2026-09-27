import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { sampleComment } from "../test/fixtures";
import { CommentPlaybackBubbleView } from "./CommentPlaybackBubbleView";

describe("CommentPlaybackBubbleView", () => {
  it("renders the comment, positioned by start time and zoom, and calls onSelect", async () => {
    const onSelect = vi.fn();
    const comment = sampleComment({
      id: "a",
      author: "caleb",
      body: "Tighten the open",
      timeline_start: 12,
    });
    const { container } = render(
      <CommentPlaybackBubbleView
        comment={comment}
        zoomPxPerSec={10}
        onSelect={onSelect}
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("caleb");
    expect(button).toHaveTextContent("Tighten the open");
    expect(button).toHaveAttribute("title", "caleb: Tighten the open");
    expect((button as HTMLElement).style.left).toBe("120px");
    button.click();
    expect(onSelect).toHaveBeenCalledWith(comment);
    await expectNoA11yViolations(container);
  });

  it("truncates a long body to 79 characters plus an ellipsis, keeping the full body in the title", () => {
    const body = "x".repeat(120);
    const comment = sampleComment({ id: "a", author: "caleb", body });
    render(
      <CommentPlaybackBubbleView
        comment={comment}
        zoomPxPerSec={10}
        onSelect={vi.fn()}
      />,
    );
    const button = screen.getByRole("button");
    expect(
      button.querySelector(".comment-playback-bubble-body"),
    ).toHaveTextContent(`${"x".repeat(79)}…`);
    expect(button).toHaveAttribute("title", `caleb: ${body}`);
  });

  it("renders nothing for a null comment", () => {
    const { container } = render(
      <CommentPlaybackBubbleView
        comment={null}
        zoomPxPerSec={10}
        onSelect={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
