import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { StatusLiveRegion } from "./StatusLiveRegion";

describe("StatusLiveRegion", () => {
  it("speaks a repeated identical message again: each announcement is a new node", async () => {
    const { container, rerender } = render(
      <StatusLiveRegion message="Reordered track" seq={1} />,
    );
    const region = screen.getByRole("status");
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) =>
      mutations.push(...records),
    );
    observer.observe(region, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const first = region.firstElementChild;

    rerender(<StatusLiveRegion message="Reordered track" seq={2} />);
    await Promise.resolve();
    observer.disconnect();

    expect(region).toHaveTextContent("Reordered track");
    expect(region.firstElementChild).not.toBe(first);
    expect(mutations.some((m) => m.addedNodes.length > 0)).toBe(true);
    await expectNoA11yViolations(container);
  });

  it("keeps the same node while the announcement does not change", () => {
    const { rerender } = render(
      <StatusLiveRegion message="Reordered track" seq={1} />,
    );
    const first = screen.getByRole("status").firstElementChild;
    rerender(<StatusLiveRegion message="Reordered track" seq={1} />);
    expect(screen.getByRole("status").firstElementChild).toBe(first);
  });
});
