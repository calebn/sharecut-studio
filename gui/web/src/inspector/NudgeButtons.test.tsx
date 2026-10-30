import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BUSY_REASON } from "../ui/disabledReason";
import { NudgeButtons, UNAPPLIED_VALUE_REASON } from "./NudgeButtons";

function setup(unavailable?: string) {
  const onClick = vi.fn();
  const onPointerDown = vi.fn();
  const view = render(
    <NudgeButtons
      groupLabel="Nudge start"
      deltas={[-1, 1]}
      unavailable={unavailable}
      label={(delta) =>
        `${Math.abs(delta)} s ${delta < 0 ? "earlier" : "later"}`
      }
      text={(delta) => `${delta < 0 ? "−" : "+"}${Math.abs(delta)}`}
      propsFor={() => ({ onClick, onPointerDown })}
    />,
  );
  return { ...view, onClick, onPointerDown };
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

  it("treats a blank reason as unavailable, not as ready", () => {
    setup("  ");
    expect(screen.getByRole("button", { name: "1 s later" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
