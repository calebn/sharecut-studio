import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { sampleComment } from "../test/fixtures";
import { activeCommentId } from "./activeComment";
import { CommentPlaybackBubble } from "./CommentPlaybackBubble";

const a = sampleComment({
  id: "a",
  body: "First",
  timeline_start: 1,
  timeline_end: 5,
});
const b = sampleComment({
  id: "b",
  body: "Second",
  timeline_start: 3,
  timeline_end: 6,
});

describe("activeCommentId", () => {
  it("prefers the selected hit, else the nearest start", () => {
    expect(activeCommentId([a, b], 3.5, null)).toBe("b");
    expect(activeCommentId([a, b], 3.5, "a")).toBe("a");
    expect(activeCommentId([a, b], 2, "b")).toBe("a");
    expect(activeCommentId([a, b], 9, null)).toBeNull();
  });
});

describe("CommentPlaybackBubble", () => {
  afterEach(() => {
    useDawStore.setState({ playheadSec: 0 });
  });

  it("shows the comment under the store playhead", () => {
    useDawStore.setState({ playheadSec: 2 });
    render(
      <CommentPlaybackBubble
        comments={[a, b]}
        zoomPxPerSec={10}
        selectedCommentId={null}
        visible
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("First");
    act(() => useDawStore.setState({ playheadSec: 5.5 }));
    expect(screen.getByRole("button")).toHaveTextContent("Second");
    act(() => useDawStore.setState({ playheadSec: 8 }));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing while hidden", () => {
    useDawStore.setState({ playheadSec: 2 });
    render(
      <CommentPlaybackBubble
        comments={[a]}
        zoomPxPerSec={10}
        selectedCommentId={null}
        visible={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
