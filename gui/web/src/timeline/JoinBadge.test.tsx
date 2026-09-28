import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { JoinBadge } from "./JoinBadge";

describe("JoinBadge", () => {
  it("renders a named, display-only fade badge at the seam", async () => {
    const { container } = render(
      <JoinBadge glyph="fade" blocked={false} seamSec={2} zoomPxPerSec={50} />,
    );
    const badge = screen.getByRole("img", { name: "Fade join at 0:02.0" });
    expect(badge.className).toContain("join-badge");
    expect(badge.className).toContain("join-badge--fade");
    expect(badge.className).not.toContain("join-badge--blocked");
    expect(badge.style.left).toBe("100px");
    const path = container.querySelector("svg path");
    expect(path?.getAttribute("d")).toBe("M1 2L6 10L11 2");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    await expectNoA11yViolations(container);
  });

  it.each([
    ["cut", "M6 1V11", "Cut"],
    ["fade", "M1 2L6 10L11 2", "Fade"],
    ["crossfade", "M1 1L11 11M11 1L1 11", "Crossfade"],
  ] as const)("draws the %s glyph", async (glyph, path, word) => {
    const { container } = render(
      <JoinBadge glyph={glyph} blocked={false} seamSec={2} zoomPxPerSec={50} />,
    );
    expect(
      screen.getByRole("img", { name: `${word} join at 0:02.0` }),
    ).toHaveClass(`join-badge--${glyph}`);
    expect(container.querySelector("svg path")?.getAttribute("d")).toBe(path);
    await expectNoA11yViolations(container);
  });

  it("marks a blocked crossfade in its class and name", async () => {
    const { container } = render(
      <JoinBadge glyph="crossfade" blocked seamSec={2} zoomPxPerSec={50} />,
    );
    const badge = screen.getByRole("img", {
      name: "Crossfade join at 0:02.0, will not blend",
    });
    expect(badge).toHaveClass("join-badge--blocked");
    await expectNoA11yViolations(container);
  });

  it("is not interactive", () => {
    render(
      <JoinBadge glyph="fade" blocked={false} seamSec={2} zoomPxPerSec={50} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img").hasAttribute("tabindex")).toBe(false);
  });

  it("rounds the label and positions in px", () => {
    render(
      <JoinBadge
        glyph="fade"
        blocked={false}
        seamSec={65.25}
        zoomPxPerSec={10}
      />,
    );
    const badge = screen.getByRole("img", { name: "Fade join at 1:05.3" });
    expect(badge.style.left).toBe("652.5px");
  });
});
