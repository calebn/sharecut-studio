import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: async () => [],
  loadHostAttention: async () => ({ pending: 0, conflicts: [] }),
}));

const loadTunnelStatus = vi.fn();
vi.mock("../../api/tunnelStatus", () => ({
  loadTunnelStatus: (...args: unknown[]) => loadTunnelStatus(...args),
}));

const refreshMix = vi.fn();
vi.mock("../../commands/execute", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../commands/execute")>();
  return {
    ...actual,
    execute: (...args: Parameters<typeof actual.execute>) =>
      args[0] === "render.refreshMix"
        ? refreshMix(...args)
        : actual.execute(...args),
  };
});

import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { FeaturesContext } from "../../extensions/FeaturesContext";
import {
  FEATURE_SHARE_UI_MENU,
  FEATURE_TUNNEL_STATUS,
} from "../../extensions/features";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { fakeExportServer } from "../../test/fakeExportServer";
import { hostShareRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { BounceFlowProvider } from "./bounceFlow";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { StageHost } from "./StageHost";
import { ShareFlowProvider } from "./shareFlow";

const PATH = "/tmp/ep/episode.project.json";
const OTHER = "/tmp/other/episode.project.json";

let server: ReturnType<typeof fakeExportServer>;

function Stages() {
  const stage = useDawStore((s) => s.stage);
  return stage === "deliver" ? <DeliverStage /> : <p>another stage</p>;
}

function Host({
  features = [FEATURE_SHARE_UI_MENU],
  ready = true,
  children = <Stages />,
}: {
  features?: string[];
  ready?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <FeaturesContext.Provider
      value={{ ready, manifest: { api_version: 1, features } }}
    >
      <ExportFlowProvider>
        <BounceFlowProvider>
          <ShareFlowProvider>{children}</ShareFlowProvider>
        </BounceFlowProvider>
      </ExportFlowProvider>
    </FeaturesContext.Provider>
  );
}

const section = () => within(screen.getByRole("region", { name: "Share" }));
const button = (name: string | RegExp) =>
  section().getByRole("button", { name });

function asHost(path = PATH) {
  useDawStore
    .getState()
    .hydrate(path, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({ stage: "deliver", guestMode: null });
}

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

beforeEach(() => {
  server = fakeExportServer();
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  loadTunnelStatus.mockReset();
  refreshMix.mockReset().mockResolvedValue({ status: "ok" });
  useDawStore.setState({ statusAnnouncement: "", bounceRangeTarget: null });
  asHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Share on the Deliver stage", () => {
  it("lists the project's links when Deliver shows and has no Listen link beside it", async () => {
    server.shares = [
      hostShareRow({ created_at: "2026-09-01T10:00:00Z" }),
      hostShareRow({ token: "gone", usable: false, revoked: true }),
    ];
    const { container } = render(<Host />);
    expect(screen.getByRole("heading", { name: "Share" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Listen link" })).toBeNull();
    expect(await screen.findByText("sample-review-link")).toBeVisible();
    expect(screen.queryByText("gone")).toBeNull();
    expect(server.shareListRequests).toBe(1);
    await expectNoA11yViolations(container);
  });

  it("lists again each time Deliver is shown, and for a reopened project", async () => {
    render(<Host />);
    await screen.findByText("No review links yet.");
    expect(server.shareListRequests).toBe(1);
    act(() => useDawStore.setState({ stage: "edit" }));
    server.shares = [hostShareRow({ token: "added-meanwhile" })];
    act(() => useDawStore.setState({ stage: "deliver" }));
    expect(await screen.findByText("added-meanwhile")).toBeVisible();
    expect(server.shareListRequests).toBe(2);
    server.shares = [hostShareRow({ token: "other-project-link" })];
    act(() => asHost(OTHER));
    expect(await screen.findByText("other-project-link")).toBeVisible();
    expect(screen.queryByText("added-meanwhile")).toBeNull();
  });

  it("is absent when the share feature is off, and lists nothing", async () => {
    render(<Host features={[]} />);
    expect(screen.queryByRole("heading", { name: "Share" })).toBeNull();
    await act(async () => {});
    expect(server.shareListRequests).toBe(0);
  });

  it("is absent for a guest", () => {
    useDawStore.getState().hydrate("share:abc", minimalProject());
    useDawStore.setState({ stage: "deliver", guestMode: "view" });
    render(
      <Host>
        <StageHost guestShare />
      </Host>,
    );
    expect(screen.queryByRole("heading", { name: "Share" })).toBeNull();
    expect(server.shareListRequests).toBe(0);
  });

  it("makes the link the choices say from the Create click, then copies it", async () => {
    const writeText = installClipboard();
    render(<Host />);
    await screen.findByText("No review links yet.");
    await userEvent.click(button("Editor"));
    await userEvent.click(button("Allow AI assistants (MCP)"));
    await userEvent.click(button("Freeze on the current version"));
    await userEvent.click(button("Create review link"));
    await waitFor(() => expect(server.shareRequests).toHaveLength(1));
    expect(server.shareRequests[0]).toEqual({
      path: PATH,
      role: "editor",
      with_mcp: true,
      freeze: true,
    });
    expect(await screen.findByText("made-link-1")).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/r/made-link-1",
    );
    expect(
      await screen.findByRole("button", { name: "Copied Editor link" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Frozen on Share mix · AI assistants allowed/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy MCP URL" })).toBeVisible();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Review link created and copied",
    );
  });

  it("starts as a Commenter that follows the latest, and copies a listed link on its own Copy click", async () => {
    server.shares = [hostShareRow()];
    const writeText = installClipboard();
    render(<Host />);
    expect(button("Commenter").getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(
      await screen.findByRole("button", { name: "Copy Commenter link" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/r/sample-review-link",
    );
    expect(
      await screen.findByRole("button", { name: "Copied Commenter link" }),
    ).toBeVisible();
    expect(screen.getByText(/Follows latest: Share mix/)).toBeVisible();
    await userEvent.click(button("Create review link"));
    await waitFor(() => expect(server.shareRequests).toHaveLength(1));
    expect(server.shareRequests[0]).toEqual({
      path: PATH,
      role: "commenter",
      with_mcp: false,
    });
  });

  it("stops sharing only after the in-place confirm", async () => {
    server.shares = [hostShareRow()];
    render(<Host />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop sharing" }),
    );
    expect(server.revokeRequests).toEqual([]);
    const group = screen.getByRole("group", {
      name: "Stop sharing this Commenter link? Anyone using it loses access.",
    });
    await userEvent.click(
      within(group).getByRole("button", { name: "Stop sharing" }),
    );
    await waitFor(() =>
      expect(server.revokeRequests).toEqual(["sample-review-link"]),
    );
    expect(await screen.findByText("No review links yet.")).toBeVisible();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Stopped sharing the Commenter link",
    );
  });

  it("offers Refresh mix after a stale mix, then makes the link once the mix is back", async () => {
    server.shareAnswer = {
      status: 409,
      code: "stale_mix",
      body: "premix.wav is stale",
    };
    render(<Host />);
    await screen.findByText("No review links yet.");
    await userEvent.click(button("Create review link"));
    expect(
      await screen.findByText(
        "The mix preview is out of date. Refresh it before creating a review link.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/premix\.wav/)).toBeNull();
    server.shareAnswer = null;
    await userEvent.click(button("Refresh mix"));
    expect(refreshMix).toHaveBeenCalledWith("render.refreshMix");
    expect(await screen.findByText("made-link-2")).toBeVisible();
    expect(server.shareRequests).toHaveLength(2);
    expect(section().queryByRole("button", { name: "Refresh mix" })).toBeNull();
  });

  it("offers Refresh mix for a project with no mix, and keeps it when the refresh fails", async () => {
    server.shareAnswer = { status: 409, code: "no_mix", body: "no mix yet" };
    refreshMix.mockResolvedValue({
      status: "disabled",
      reason: "Render failed",
    });
    render(<Host />);
    await screen.findByText("No review links yet.");
    await userEvent.click(button("Create review link"));
    expect(
      await screen.findByText(
        "This project has no mix yet. Refresh the mix to create the link.",
      ),
    ).toBeVisible();
    await userEvent.click(button("Refresh mix"));
    expect(
      await screen.findByText("Refresh failed: Render failed"),
    ).toBeVisible();
    expect(button("Refresh mix")).toBeEnabled();
    expect(server.shareRequests).toHaveLength(1);
  });

  it("says a stale master needs an export, without Refresh mix", async () => {
    server.shareAnswer = { status: 409, code: "stale_master", body: "stale" };
    render(<Host />);
    await screen.findByText("No review links yet.");
    await userEvent.click(button("Create review link"));
    expect(
      await screen.findByText(
        "The mastered mix is out of date. Export a new master before creating a review link.",
      ),
    ).toBeVisible();
    expect(section().queryByRole("button", { name: "Refresh mix" })).toBeNull();
  });

  it("forgets the choices and a pending refresh when Deliver is left", async () => {
    server.shareAnswer = { status: 409, code: "stale_mix", body: "stale" };
    render(<Host />);
    await screen.findByText("No review links yet.");
    await userEvent.click(button("Editor"));
    await userEvent.click(button("Create review link"));
    await section().findByRole("button", { name: "Refresh mix" });
    act(() => useDawStore.setState({ stage: "edit" }));
    act(() => useDawStore.setState({ stage: "deliver" }));
    await screen.findByText("No review links yet.");
    expect(section().queryByRole("button", { name: "Refresh mix" })).toBeNull();
    expect(button("Commenter").getAttribute("aria-pressed")).toBe("true");
  });

  it("lists a record room and opens the Record stage from it", async () => {
    server.shares = [
      hostShareRow({
        token: "g1",
        kind: "record",
        docs_role: null,
        record_role: "guest",
        session_id: "room-1",
      }),
    ];
    render(<Host />);
    expect(await screen.findByText("Record room")).toBeVisible();
    expect(button("Open Record stage")).toBeEnabled();
    await userEvent.click(button("Open Record stage"));
    expect(useDawStore.getState().stage).toBe("record");
  });
});

describe("Share entry button", () => {
  it("brings Share into focus", async () => {
    render(<Host />);
    await screen.findByText("No review links yet.");
    await userEvent.click(
      screen.getByRole("button", { name: "Share a listen link" }),
    );
    await waitFor(() => expect(button("Create review link")).toHaveFocus());
    expect(useDawStore.getState().chrome.shareRequested).toBe(false);
  });

  it("focuses Share when a share request is waiting, then clears it", async () => {
    useDawStore.getState().setShareRequested(true);
    render(<Host />);
    await waitFor(() => expect(button("Create review link")).toHaveFocus());
    expect(useDawStore.getState().chrome.shareRequested).toBe(false);
  });

  it("keeps a share request until the features have loaded", async () => {
    useDawStore.getState().setShareRequested(true);
    const view = render(<Host features={[]} ready={false} />);
    await screen.findByText("Episode file");
    expect(useDawStore.getState().chrome.shareRequested).toBe(true);
    view.rerender(<Host ready />);
    await waitFor(() => expect(button("Create review link")).toHaveFocus());
    expect(useDawStore.getState().chrome.shareRequested).toBe(false);
  });

  it("drops a share request when the feature is off", async () => {
    useDawStore.getState().setShareRequested(true);
    render(<Host features={[]} />);
    await waitFor(() =>
      expect(useDawStore.getState().chrome.shareRequested).toBe(false),
    );
    expect(
      screen.queryByRole("button", { name: "Create review link" }),
    ).toBeNull();
  });

  it("stays out of the way when the share feature is off", () => {
    render(<Host features={[]} />);
    expect(
      screen.queryByRole("button", { name: "Share a listen link" }),
    ).toBeNull();
  });
});

describe("online sharing on Deliver", () => {
  const status = (state: string) => ({
    state,
    reason: null,
    reason_kind: null,
    relay_host: "relay.example.test",
    public_base_url: "https://share.example.test",
    share_count: 1,
    retry_at: null,
  });

  it("shows the state only when the tunnel.status feature is present", async () => {
    loadTunnelStatus.mockResolvedValue(status("online"));
    const { unmount } = render(<Host />);
    await screen.findByText("No review links yet.");
    expect(loadTunnelStatus).not.toHaveBeenCalled();
    unmount();
    render(<Host features={[FEATURE_SHARE_UI_MENU, FEATURE_TUNNEL_STATUS]} />);
    expect(await screen.findByText("Guests can open your links")).toBeVisible();
  });

  it.each([
    ["reconnecting", /^Reconnecting…/],
    ["offline", /^Not reachable online/],
    ["off", "Online sharing is off"],
  ] as const)("shows %s", async (state, headline) => {
    loadTunnelStatus.mockResolvedValue(status(state));
    render(<Host features={[FEATURE_SHARE_UI_MENU, FEATURE_TUNNEL_STATUS]} />);
    expect(await screen.findByText(headline)).toBeVisible();
  });

  it("tells a link that only this network reaches, and not when online sharing is on", async () => {
    server.shares = [hostShareRow()];
    loadTunnelStatus.mockResolvedValue(status("off"));
    const { unmount } = render(
      <Host features={[FEATURE_SHARE_UI_MENU, FEATURE_TUNNEL_STATUS]} />,
    );
    expect(
      await screen.findByText(/Only people on this network can listen/),
    ).toBeVisible();
    unmount();
    loadTunnelStatus.mockResolvedValue(status("online"));
    render(<Host features={[FEATURE_SHARE_UI_MENU, FEATURE_TUNNEL_STATUS]} />);
    await screen.findByText("Guests can open your links");
    expect(screen.queryByText(/Only people on this network/)).toBeNull();
  });

  it("stops polling when Deliver is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      loadTunnelStatus.mockResolvedValue(status("online"));
      render(
        <Host features={[FEATURE_SHARE_UI_MENU, FEATURE_TUNNEL_STATUS]} />,
      );
      await screen.findByText("Guests can open your links");
      const polled = loadTunnelStatus.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(loadTunnelStatus.mock.calls.length).toBeGreaterThan(polled);
      act(() => useDawStore.setState({ stage: "edit" }));
      const left = loadTunnelStatus.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(loadTunnelStatus.mock.calls.length).toBe(left);
    } finally {
      vi.useRealTimers();
    }
  });
});
