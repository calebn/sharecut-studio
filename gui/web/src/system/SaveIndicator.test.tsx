import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { SaveIndicator } from "./SaveIndicator";

describe("SaveIndicator away", () => {
  it("says the host cannot be reached, in one status with one sentence", () => {
    render(<SaveIndicator state="away" cause="host" />);
    const status = screen.getByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(status).toHaveAttribute(
      "title",
      "Can't reach the host. This page keeps trying.",
    );
    expect(status).toHaveTextContent("Can't reach the host");
    expect(status.querySelector(".sr-only")).toHaveTextContent(
      /^Can't reach the host\. This page keeps trying\.$/,
    );
    expect(status.querySelector("svg")).not.toBeNull();
  });

  it("says the device is offline", () => {
    render(<SaveIndicator state="away" cause="device" waiting={0} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute(
      "title",
      "You're offline. This page keeps trying.",
    );
    expect(status.querySelector(".sr-only")).toHaveTextContent(
      "You're offline. This page keeps trying.",
    );
  });

  it("adds the waiting count to the words and keeps it out of the spoken sentence", () => {
    render(<SaveIndicator state="away" cause="host" waiting={2} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Can't reach the host · 2 waiting");
    const spoken = [...status.querySelectorAll("span[aria-hidden='true']")];
    expect(spoken.map((node) => node.textContent)).toEqual([
      "Can't reach the host · 2 waiting",
      "2",
    ]);
    expect(status.querySelector(".sr-only")).toHaveTextContent(
      /^Can't reach the host\. This page keeps trying\.$/,
    );
  });

  it("keeps the glyph, the count and the title in the compact form", () => {
    render(<SaveIndicator state="away" cause="host" waiting={3} compact />);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("sys-save--compact");
    expect(status).toHaveAttribute("title");
    expect(status.querySelector(".sys-save-count")).toHaveTextContent("3");
  });

  it.each(["host", "device"] as const)(
    "has no axe violations for %s",
    async (cause) => {
      const { container } = render(
        <SaveIndicator state="away" cause={cause} waiting={1} />,
      );
      await expectNoA11yViolations(container);
    },
  );
});
