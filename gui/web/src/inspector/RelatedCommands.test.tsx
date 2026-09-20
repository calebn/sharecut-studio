import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { RelatedCommands } from "./RelatedCommands";
import { relatedCommandsFor } from "./relatedCommands";

describe("relatedCommandsFor", () => {
  it("returns commands for clip selection", () => {
    const cmds = relatedCommandsFor({ kind: "clip", id: "c1", trackId: "t1" });
    expect(cmds).toContain("edit.rippleDelete");
    expect(cmds).toContain("edit.bladeCut");
  });

  it("returns empty for null selection", () => {
    expect(relatedCommandsFor(null)).toEqual([]);
  });

  it("returns empty for unknown kind", () => {
    expect(relatedCommandsFor({ kind: "chapter", id: "ch1", time: 0 })).toEqual([]);
  });
});

describe("RelatedCommands", () => {
  it("renders related command buttons", () => {
    render(<RelatedCommands selection={{ kind: "clip", id: "c1", trackId: "t1" }} />);
    expect(screen.getByText("You might also want…")).toBeInTheDocument();
    // Should render buttons for the related commands
    expect(
      screen.getByRole("button", { name: /ripple delete/i }),
    ).toBeInTheDocument();
  });

  it("renders nothing for null selection", () => {
    const { container } = render(<RelatedCommands selection={null} />);
    expect(container.textContent).toBe("");
  });

  it("is axe-clean", async () => {
    const { container } = render(
      <RelatedCommands selection={{ kind: "clip", id: "c1", trackId: "t1" }} />,
    );
    await expectNoA11yViolations(container);
  });
});
