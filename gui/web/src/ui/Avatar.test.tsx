import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("renders initials and is axe-clean", async () => {
    const { container } = render(
      <Avatar name="Caleb Nelson" colorIndex={3} badge={2} ring="dashed" />,
    );
    expect(container.textContent).toContain("CN");
    expect(container.querySelector(".ui-avatar-badge")?.textContent).toBe("2");
    await expectNoA11yViolations(container);
  });

  it("uses the agent icon for agent role", async () => {
    const { container } = render(
      <Avatar name="Agent" sessionRole="agent" colorIndex={1} />,
    );
    expect(container.querySelector(".ui-icon")).toBeTruthy();
    expect(container.querySelector("svg title")?.textContent).toBe("Agent");
    await expectNoA11yViolations(container);
  });
});
