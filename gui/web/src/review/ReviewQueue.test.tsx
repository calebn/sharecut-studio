import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { reviewContent } from "../storybook/reviewContent";
import { QUEUE_WITHOUT_CHECKS } from "../storybook/reviewFixtures";
import { ReviewQueue } from "./ReviewQueue";

describe("ReviewQueue", () => {
  it("gives a blocked row no swipe verb", () => {
    const onVerb = vi.fn();
    const items = QUEUE_WITHOUT_CHECKS.map((i) =>
      i.id === "f1" ? { ...i, blocked: true } : i,
    );
    const { container } = render(
      <ReviewQueue
        items={items}
        content={reviewContent}
        selectedId={null}
        filter="all"
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={onVerb}
      />,
    );
    for (const row of container.querySelectorAll(".sys-queue-row")) {
      const at = (clientX: number) => ({ clientX, clientY: 0, pointerId: 1 });
      fireEvent.pointerDown(row, { ...at(100), isPrimary: true });
      fireEvent.pointerMove(row, at(190));
      fireEvent.pointerUp(row, at(190));
    }
    expect(onVerb).toHaveBeenCalled();
    expect(onVerb).not.toHaveBeenCalledWith("f1");
  });
});
