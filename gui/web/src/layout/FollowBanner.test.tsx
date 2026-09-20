import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { FollowBanner } from "./FollowBanner";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

describe("FollowBanner", () => {
  beforeEach(() => {
    vi.mocked(execute).mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("shows who is followed and unfollows", async () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <FollowBanner />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        followingClientId: "a",
        sessionClients: [
          {
            client_id: "a",
            role: "viewer",
            meta: { display_name: "Ada", color_index: 2 },
          },
        ],
      });
    });
    expect(screen.getByRole("status").textContent).toContain("Following Ada");
    await userEvent.click(
      screen.getByRole("button", { name: "Stop following" }),
    );
    expect(execute).toHaveBeenCalledWith("presence.unfollow");
    await expectNoA11yViolations(container);
  });

  it("omits the Mix hint unless Mix is forced", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <FollowBanner />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        followingClientId: "a",
        guestMode: "view",
        sessionClients: [
          {
            client_id: "a",
            role: "viewer",
            meta: {
              display_name: "Ada Lovelace Very Long Name",
              color_index: 2,
            },
          },
        ],
      });
    });
    const banner = screen.getByRole("status");
    expect(banner.textContent).not.toContain("Listening in Mix");
    expect(banner.querySelector(".follow-banner-text")?.className).toContain(
      "follow-banner-text",
    );
    expect(banner.querySelector(".follow-banner-stop")).toBeTruthy();
  });

  it("shows host-only tab and audition degrade details", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <FollowBanner />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        followingClientId: "a",
        guestMode: "view",
        followDegraded: { tab: "pipeline", audition: "fx" },
        sessionClients: [
          {
            client_id: "a",
            role: "viewer",
            meta: { display_name: "Ada", color_index: 2 },
          },
        ],
      });
    });
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("in Pipeline (host-only)");
    expect(text).toContain("auditioning FX");
    expect(text).toContain("Listening in Mix");
  });
});
