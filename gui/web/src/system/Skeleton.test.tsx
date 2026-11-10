import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SKELETON_RETRY_MS, SkeletonBlock } from "./Skeleton";

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

  it("retries at 4 s", () => {
    expect(SKELETON_RETRY_MS).toBe(4000);
  });
});
