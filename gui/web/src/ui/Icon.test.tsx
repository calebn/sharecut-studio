import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("keeps decorative a11y after rest props", () => {
    const { container } = render(
      <Icon name="select" aria-hidden={false} role="presentation" />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
  });

  it("exposes title as an img when provided", () => {
    const { container } = render(<Icon name="comment" title="Comment" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
  });

  it.each(["play", "pause", "stop"] as const)(
    "uses the shared stroke contract for %s",
    (name) => {
      const { container } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("stroke", "currentColor");
      expect(svg).toHaveAttribute("stroke-width", "1.75");
    },
  );
});
