import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { FollowBannerView } from "./FollowBannerView";

describe("FollowBannerView", () => {
  it("shows who is followed, colors the presence var, and unfollows", async () => {
    const onStopFollowing = vi.fn();
    const { container } = render(
      <FollowBannerView
        name="Mira"
        colorIndex={2}
        guest={false}
        degraded={{}}
        onStopFollowing={onStopFollowing}
      />,
    );
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Following Mira");
    expect(banner.style.getPropertyValue("--presence-color")).toBe(
      "var(--presence-2)",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Stop following" }),
    );
    expect(onStopFollowing).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("shows the Mix hint for a guest audition but not a host with the same degrade", () => {
    const { rerender } = render(
      <FollowBannerView
        name="Mira"
        guest
        degraded={{ audition: "fx" }}
        onStopFollowing={vi.fn()}
      />,
    );
    let banner = screen.getByRole("status");
    expect(banner.textContent).toContain("auditioning FX");
    expect(banner.textContent).toContain("Listening in Mix");

    rerender(
      <FollowBannerView
        name="Mira"
        guest={false}
        degraded={{ audition: "fx" }}
        onStopFollowing={vi.fn()}
      />,
    );
    banner = screen.getByRole("status");
    expect(banner.textContent).not.toContain("Listening in Mix");
  });

  it("shows a host-only tab degrade", () => {
    render(
      <FollowBannerView
        name="Mira"
        guest={false}
        degraded={{ tab: "pipeline" }}
        onStopFollowing={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "in Pipeline (host-only)",
    );
  });

  it("renders an avatar icon for an agent role and initials otherwise", () => {
    const { rerender, container } = render(
      <FollowBannerView
        name="Mira"
        sessionRole="agent"
        guest={false}
        degraded={{}}
        onStopFollowing={vi.fn()}
      />,
    );
    expect(container.querySelector(".ui-avatar svg")).toBeTruthy();

    rerender(
      <FollowBannerView
        name="Mira"
        sessionRole="viewer"
        guest={false}
        degraded={{}}
        onStopFollowing={vi.fn()}
      />,
    );
    expect(container.querySelector(".ui-avatar svg")).toBeNull();
    expect(container.querySelector(".ui-avatar")?.textContent).toBe("M");
  });
});
