import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Declined } from "./Declined";
import { DECLINED_COPY } from "./types";

describe("Declined", () => {
  it("renders the declined heading and recovery copy, axe-clean", async () => {
    const { container } = render(<Declined />);
    expect(
      screen.getByRole("heading", { level: 1, name: "You declined" }),
    ).toBeTruthy();
    expect(screen.getByText(DECLINED_COPY)).toBeTruthy();
    expect(container.querySelector("main.record-shell")).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
