import { composeStories } from "@storybook/react-vite";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ConsentGate } from "./ConsentGate";
import * as stories from "./ConsentGate.stories";
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

  it("labels each instance by its own heading", () => {
    render(
      <>
        <ConsentGate onAccept={() => undefined} onDecline={() => undefined} />
        <ConsentGate onAccept={() => undefined} onDecline={() => undefined} />
      </>,
    );
    const regions = screen.getAllByRole("region", {
      name: "Recording consent",
    });
    expect(regions).toHaveLength(2);
    const [first, second] = regions.map((region) =>
      region.getAttribute("aria-labelledby"),
    );
    expect(first).not.toBe(second);
    for (const region of regions) {
      const heading = region.querySelector("h2");
      expect(heading?.id).toBe(region.getAttribute("aria-labelledby"));
    }
  });

  it.each(Object.entries(composeStories(stories)))(
    "story %s renders and passes its play checks",
    async (_name, Story) => {
      // run() mounts the composed story (decorators + render) and its play.
      const canvasElement = document.body.appendChild(
        document.createElement("div"),
      );
      try {
        await Story.run({ canvasElement });
        expect(
          screen.getByRole("region", { name: "Recording consent" }),
        ).toBeInTheDocument();
        await expectNoA11yViolations(canvasElement);
      } finally {
        canvasElement.remove();
      }
    },
  );
});
