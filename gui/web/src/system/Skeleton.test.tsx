import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton, SkeletonBlock } from "./Skeleton";

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

describe("Skeleton Retry", () => {
  it("keeps both labels in the DOM and hides the one not shown from assistive tech", () => {
    const { container } = render(
      <Skeleton elapsedMs={5_000} onRetry={() => {}} />,
    );
    const hidden = () =>
      Array.from(
        container.querySelectorAll(".sys-busy-label > [aria-hidden]"),
      ).map((el) => el.textContent);
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Trying…")).toBeInTheDocument();
    expect(hidden()).toEqual(["Trying…"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hidden()).toEqual(["Retry"]);
    expect(screen.getByRole("button", { name: "Trying…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});
