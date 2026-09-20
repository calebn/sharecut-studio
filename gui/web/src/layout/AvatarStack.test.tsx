import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { AvatarStack } from "./AvatarStack";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

describe("AvatarStack", () => {
  beforeEach(() => {
    vi.mocked(execute).mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("shows three others plus overflow and local badge", async () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <AvatarStack />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        localClientId: "me",
        followingClientId: null,
        serverClockOffsetMs: 0,
        sessionClients: [
          {
            client_id: "me",
            role: "viewer",
            label: "Me",
            followers: 2,
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Me", color_index: 1 },
          },
          {
            client_id: "a",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Ada", color_index: 2 },
          },
          {
            client_id: "b",
            role: "agent",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Agent", color_index: 3 },
          },
          {
            client_id: "c",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Bo", color_index: 4 },
          },
          {
            client_id: "d",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Cy", color_index: 5 },
          },
        ],
      });
    });
    expect(screen.getByRole("button", { name: "Follow Ada" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+1 more" })).toBeTruthy();
    expect(container.querySelector(".ui-avatar-badge")?.textContent).toBe("2");
    expect(screen.getByLabelText("2 following you")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Follow Ada" }));
    expect(execute).toHaveBeenCalledWith("presence.follow", { clientId: "a" });
    await expectNoA11yViolations(container);
  });

  it("renders a People menu list for collapsed chrome", async () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <div role="menu" aria-label="People">
          <AvatarStack variant="menu" />
        </div>
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        localClientId: "me",
        followingClientId: null,
        serverClockOffsetMs: 0,
        sessionClients: [
          {
            client_id: "me",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Me" },
          },
          {
            client_id: "a",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Ada", color_index: 2 },
          },
        ],
      });
    });
    expect(screen.getByRole("group", { name: "People" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Ada/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: /Ada/ }));
    expect(execute).toHaveBeenCalledWith("presence.follow", { clientId: "a" });
    await expectNoA11yViolations(container);
  });

  it("hides people until the local client id is assigned", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <AvatarStack />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        localClientId: null,
        sessionClients: [
          {
            client_id: "guest-token-me",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Me",
              cursor: { t_sec: 1, track_id: "host" },
            },
          },
        ],
      });
    });
    expect(screen.queryByRole("button", { name: /Follow/ })).toBeNull();
  });

  it("names the follow control Stop following when pressed", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <AvatarStack />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        localClientId: "me",
        followingClientId: "a",
        serverClockOffsetMs: 0,
        sessionClients: [
          {
            client_id: "me",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Me" },
          },
          {
            client_id: "a",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Ada", color_index: 2 },
          },
        ],
      });
    });
    expect(
      screen.getByRole("button", { name: "Stop following Ada" }),
    ).toBeTruthy();
  });

  it("omits the People menu when nobody is followable", () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <div role="menu" aria-label="More">
          <AvatarStack variant="menu" />
        </div>
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        localClientId: "me",
        followingClientId: null,
        serverClockOffsetMs: 0,
        sessionClients: [
          {
            client_id: "me",
            role: "viewer",
            followers: 2,
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Me" },
          },
        ],
      });
    });
    expect(screen.queryByRole("group", { name: "People" })).toBeNull();
    expect(container.querySelector(".ui-menu-section")).toBeNull();
  });
});
