import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { FeatureProvider } from "../extensions/FeatureProvider";
import {
  FEATURE_SHARE_UI_MENU,
  resetFeaturesCache,
} from "../extensions/features";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { TransportBar } from "./TransportBar";

describe("TransportBar Share menu", () => {
  beforeEach(() => {
    resetFeaturesCache();
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ hostMcpDialogOpen: false });
  });

  it("shows Share… when share.ui.menu is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          api_version: 1,
          features: [FEATURE_SHARE_UI_MENU],
        }),
      }),
    );
    render(
      <FeatureProvider>
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject()}
        >
          <TransportBar compact />
        </DawProvider>
      </FeatureProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(
      await screen.findByRole("menuitem", { name: "Share…" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Connect agent…" }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Connect agent…" }),
    );
    expect(useDawStore.getState().hostMcpDialogOpen).toBe(true);
  });

  it("hides Share… when the feature is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ api_version: 1, features: [] }),
      }),
    );
    render(
      <FeatureProvider>
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject()}
        >
          <TransportBar compact />
        </DawProvider>
      </FeatureProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const menu = await screen.findByRole("menu");
    await vi.waitFor(() => {
      expect(
        within(menu).queryByRole("menuitem", { name: "Share…" }),
      ).toBeNull();
    });
    expect(
      within(menu).getByRole("menuitem", { name: "Connect agent…" }),
    ).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: "Record room…" }),
    ).toBeTruthy();
  });

  it("hides Share… for guest share keys even when the feature is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          api_version: 1,
          features: [FEATURE_SHARE_UI_MENU],
        }),
      }),
    );
    useDawStore
      .getState()
      .hydrate("share:fantastic-acoustic-whale", minimalProject());
    render(
      <FeatureProvider>
        <DawProvider
          projectPath="share:fantastic-acoustic-whale"
          initialProject={minimalProject()}
        >
          <TransportBar compact />
        </DawProvider>
      </FeatureProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.queryByRole("menuitem", { name: "Share…" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Connect agent…" }),
    ).toBeNull();
  });
});
