import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Declined } from "./Declined";
import { FullRoom } from "./FullRoom";
import { DECLINED_COPY, FULL_ROOM_COPY } from "./types";

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

describe("FullRoom", () => {
  it("renders the shared cover shell with room-full copy, axe-clean", async () => {
    const { container } = render(<FullRoom />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Room full" }),
    ).toBeTruthy();
    expect(screen.getByText(FULL_ROOM_COPY)).toBeTruthy();
    expect(
      container.querySelector("main.record-shell .cover-center"),
    ).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
