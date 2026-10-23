import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Button } from "./Button";
import { UNAVAILABLE_REASON, useDisabledReasonNote } from "./disabledReason";

function Gated({ reason }: { reason: string | null | undefined }) {
  const { note, describedBy } = useDisabledReasonNote(reason);
  return (
    <div>
      {note}
      <Button disabledReason={reason ?? undefined} {...describedBy}>
        Cancel
      </Button>
    </div>
  );
}

describe("useDisabledReasonNote", () => {
  it("shows the reason as text and describes the control with it", async () => {
    const { container } = render(<Gated reason="Wait for the job to start." />);
    const note = screen.getByText("Wait for the job to start.");
    expect(note).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute(
      "aria-describedby",
      note.id,
    );
    await expectNoA11yViolations(container);
  });

  it.each([null, undefined])("renders nothing for %s", (reason) => {
    const { container } = render(<Gated reason={reason} />);
    expect(container.querySelector(".export-dialog-note")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("uses the unavailable text for a blank reason, like the title does", () => {
    render(<Gated reason="  " />);
    expect(screen.getByText(UNAVAILABLE_REASON)).toBeVisible();
  });

  it("gives each note its own id", () => {
    render(
      <>
        <Gated reason="One." />
        <Gated reason="Two." />
      </>,
    );
    expect(screen.getByText("One.").id).not.toBe(screen.getByText("Two.").id);
  });
});
