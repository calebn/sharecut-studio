import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ConsentGate } from "./ConsentGate";
import { CONSENT_COPY } from "./types";

describe("ConsentGate", () => {
  it("uses the locked consent copy", async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const { container } = render(
      <ConsentGate onAccept={onAccept} onDecline={onDecline} />,
    );
    expect(screen.getByText(CONSENT_COPY)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("disables Accept until the lobby is ready and points at the grant hint", () => {
    render(
      <ConsentGate
        onAccept={() => undefined}
        onDecline={() => undefined}
        canAccept={false}
        acceptDescribedBy="grant-hint"
      />,
    );
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute("aria-describedby", "grant-hint");
  });
});
