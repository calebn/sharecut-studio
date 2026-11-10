import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkeletonBlock } from "./Skeleton";

describe("SkeletonBlock", () => {
  it("is hidden from assistive technology and can be a circle", () => {
    const { container } = render(<SkeletonBlock circle />);
    const block = container.firstElementChild;
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block).toHaveClass(
      "sys-skeleton-block",
      "sys-skeleton-block--circle",
    );
  });
});
