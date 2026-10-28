import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextStrip } from "./ContextStrip";
import type { ReviewItem } from "./reviewQueueModel";

const item = (id: string, at: number): ReviewItem => ({
  id,
  kind: "suggestion",
  at,
  savedSeconds: 1,
});

describe("ContextStrip", () => {
  it("draws no tick for an unplaced item and does not throw", () => {
    const { container } = render(
      <ContextStrip
        items={[item("a", 30), item("u", Number.POSITIVE_INFINITY)]}
        duration={60}
        selectedId="u"
      />,
    );
    expect(container.querySelectorAll(".sys-overview-tick")).toHaveLength(1);
  });
});
