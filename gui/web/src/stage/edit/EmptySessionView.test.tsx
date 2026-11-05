import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { EmptySessionView } from "./EmptySessionView";

function setup(over = false, fileCount = 1) {
  const props = {
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onImport: vi.fn(),
    onRecord: vi.fn(),
  };
  const view = render(
    <EmptySessionView over={over} fileCount={fileCount} {...props} />,
  );
  return { ...props, ...view };
}

describe("EmptySessionView", () => {
  it("offers Import audio and Record and no coach text", async () => {
    const { onImport, onRecord } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Import audio/ }));
    await user.click(screen.getByRole("button", { name: /^Record/ }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onRecord).toHaveBeenCalledOnce();
    expect(screen.queryByText(/one file per speaker/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();
  });

  it("takes dropped audio on the tiles' area and words the drop", () => {
    const { onDrop, onDragOver } = setup(true, 3);
    const area = screen.getByRole("region", { name: "Start" }).parentElement;
    if (!area) throw new Error("no drop area");
    fireEvent.dragOver(area);
    fireEvent.drop(area);
    expect(onDragOver).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: /Drop to add 3 files/ }),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
