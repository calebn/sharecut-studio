import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BUSY_REASON } from "../ui/disabledReason";
import { NudgeButtons, UNAPPLIED_VALUE_REASON } from "./NudgeButtons";

function setup(unavailable?: string, saving = false) {
  const onCapture = vi.fn();
  const onClick = vi.fn();
  const onPointerDown = vi.fn();
  const view = render(
    <NudgeButtons
      groupLabel="Nudge start"
      deltas={[-1, 1]}
      unavailable={unavailable}
      saving={saving}
      onPointerDownCapture={onCapture}
      label={(delta) =>
        `${Math.abs(delta)} s ${delta < 0 ? "earlier" : "later"}`
      }
      text={(delta) => `${delta < 0 ? "−" : "+"}${Math.abs(delta)}`}
      propsFor={() => ({ onClick, onPointerDown })}
    />,
  );
  return { ...view, onClick, onPointerDown, onCapture };
}

describe("NudgeButtons", () => {
  it("runs the gesture handlers when nothing is missing", async () => {
    const { onClick, container } = setup();
    const later = screen.getByRole("button", { name: "1 s later" });
    expect(later).not.toHaveAttribute("aria-disabled");
    expect(later).not.toHaveAttribute("aria-describedby");
    await userEvent.click(later);
    expect(onClick).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it.each([BUSY_REASON, UNAPPLIED_VALUE_REASON])(
    "shows %s, stays focusable and refuses to nudge",
    async (reason) => {
      const { onClick, onPointerDown, container } = setup(reason);
      const note = screen.getByText(reason);
      expect(note).toBeVisible();
      for (const name of ["1 s earlier", "1 s later"]) {
        const button = screen.getByRole("button", { name });
        expect(button).toHaveAttribute("aria-disabled", "true");
        expect(button).toHaveAttribute("aria-describedby", note.id);
        expect(button).toBeEnabled();
        button.focus();
        expect(button).toHaveFocus();
        fireEvent.pointerDown(button);
        await userEvent.click(button);
        await userEvent.keyboard("{Enter}");
      }
      expect(onClick).not.toHaveBeenCalled();
      expect(onPointerDown).not.toHaveBeenCalled();
      await expectNoA11yViolations(container);
    },
  );

  it("lets the row react to a press only while the nudges can run", () => {
    const ready = setup();
    fireEvent.pointerDown(screen.getByRole("button", { name: "1 s later" }));
    expect(ready.onCapture).toHaveBeenCalledTimes(1);
    ready.unmount();
    const held = setup(UNAPPLIED_VALUE_REASON);
    fireEvent.pointerDown(screen.getByRole("button", { name: "1 s later" }));
    expect(held.onCapture).not.toHaveBeenCalled();
  });

  it("refuses to nudge while saving without showing a note that would move the rows below", async () => {
    const { onClick, onPointerDown, onCapture, container } = setup(
      undefined,
      true,
    );
    const button = screen.getByRole("button", { name: "1 s later" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(container.querySelector(".export-dialog-note")).toBeNull();
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.pointerDown(button);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("treats a blank reason as unavailable, not as ready", () => {
    setup("  ");
    expect(screen.getByRole("button", { name: "1 s later" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
