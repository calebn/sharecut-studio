import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { NotServedCover } from "./StatusCovers";

describe("NotServedCover", () => {
  it("says the episode is not open here, with the spec's two ways forward", async () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <NotServedCover
        notServed={{
          name: "Rosa and Maya",
          openHref: "/?project=%2Fep.sharecut&session_token=t",
          homeHref: "/?home=1&session_token=t",
        }}
        onNavigate={onNavigate}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: "This episode isn't open on this computer",
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Open Rosa and Maya" }),
    );
    expect(onNavigate).toHaveBeenLastCalledWith(
      "/?project=%2Fep.sharecut&session_token=t",
    );
    await userEvent.click(screen.getByRole("button", { name: "All projects" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/?home=1&session_token=t");
    await expectNoA11yViolations(container);
  });
});
