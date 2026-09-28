import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { TransportBar } from "./TransportBar";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

import { execute } from "../commands/execute";

function staleProject() {
  return minimalProject({
    tracks: [sampleTrack({ stem_is_fresh: false })],
    render_status: {
      needs_rerender: true,
      reconciliation: { stale: false },
      premix: { exists: true, stale_vs_stems: true },
    },
  });
}

describe("TransportBar stale refresh", () => {
  beforeEach(() => {
    vi.mocked(execute).mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", staleProject());
    // jsdom clientWidth is 0; treat the bar as wide so collapsed is only via `compact`.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1000,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  it("highlights timeline on hover and refreshes on click for host", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={staleProject()}>
        <TransportBar />
      </DawProvider>,
    );
    const pill = screen.getByRole("button", { name: /Mix out of date/i });
    expect(pill.getAttribute("aria-disabled")).toBeNull();
    // Short wide-bar text so the transport fits at 1280px; the refresh verb
    // is in the accessible name, title, Mod+B and the collapsed Menu item.
    expect(pill).toHaveTextContent(/^Mix out of date$/);
    expect(pill.getAttribute("aria-label")).toMatch(
      /^Mix out of date\. .*\. Refresh mix\.$/,
    );
    await userEvent.hover(pill);
    expect(useDawStore.getState().highlightStaleRender).toBe(true);
    await userEvent.unhover(pill);
    expect(useDawStore.getState().highlightStaleRender).toBe(false);
    await userEvent.click(pill);
    expect(execute).toHaveBeenCalledWith(
      "render.refreshMix",
      {},
      { skipWhen: true },
    );
  });

  it("does not refresh for view-only share guests", async () => {
    const key = shareProjectKey("tok");
    useDawStore
      .getState()
      .hydrate(key, staleProject(), "view", ["play", "view"]);
    render(
      <DawProvider
        projectPath={key}
        initialProject={staleProject()}
        guestMode="view"
        shareCapabilities={["play", "view"]}
      >
        <TransportBar />
      </DawProvider>,
    );
    const pill = screen.getByRole("button", { name: /Mix out of date/i });
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    expect(pill).toHaveTextContent(/^Mix out of date$/);
    expect(pill.textContent).not.toContain("Refresh");
    expect(pill.getAttribute("aria-label")).toMatch(/^Mix out of date\. /);
    expect(pill.getAttribute("aria-label")).not.toContain("Refresh");
    await userEvent.hover(pill);
    expect(useDawStore.getState().highlightStaleRender).toBe(true);
    await userEvent.click(pill);
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows refresh for Docs Editor share", async () => {
    const key = shareProjectKey("editTok");
    useDawStore.getState().hydrate(key, staleProject(), "edit", ["edit"]);
    render(
      <DawProvider
        projectPath={key}
        initialProject={staleProject()}
        guestMode="edit"
        shareCapabilities={["edit"]}
      >
        <TransportBar />
      </DawProvider>,
    );
    const pill = screen.getByRole("button", {
      name: /^Mix out of date\. .*\. Refresh mix\.$/,
    });
    expect(pill.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(pill);
    expect(execute).toHaveBeenCalledWith(
      "render.refreshMix",
      {},
      { skipWhen: true },
    );
  });

  it("keeps Mix out of date off the bar when collapsed and refreshes from Menu", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={staleProject()}>
        <TransportBar compact />
      </DawProvider>,
    );
    expect(
      screen.queryByRole("button", { name: /Mix out of date/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stale$/i })).toBeNull();
    expect(document.querySelector(".timecode")).toBeTruthy();
    expect(document.querySelector(".transport--collapsed")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const refresh = screen.getByRole("menuitem", {
      name: /Mix out of date · Refresh/i,
    });
    await userEvent.hover(refresh);
    expect(useDawStore.getState().highlightStaleRender).toBe(true);
    await userEvent.click(refresh);
    expect(useDawStore.getState().highlightStaleRender).toBe(false);
    expect(execute).toHaveBeenCalledWith(
      "render.refreshMix",
      {},
      { skipWhen: false },
    );
  });

  it("clears stale highlight when the collapsed menu closes via Escape", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={staleProject()}>
        <TransportBar compact />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.hover(
      screen.getByRole("menuitem", { name: /Mix out of date · Refresh/i }),
    );
    expect(useDawStore.getState().highlightStaleRender).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(useDawStore.getState().highlightStaleRender).toBe(false);
  });

  it("lights Mix when a volume or mute change left the premix behind", async () => {
    const project = minimalProject({
      tracks: [sampleTrack({ fader_db: -3 })],
      render_status: {
        needs_rerender: true,
        reconciliation: { stale: false },
        premix: { exists: true, stale_vs_mix: true },
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", project);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TransportBar />
      </DawProvider>,
    );
    const mix = screen.getByRole("button", { name: "Full mix" });
    expect(mix).not.toHaveClass("stale-highlight");
    await userEvent.hover(
      screen.getByRole("button", { name: /Mix out of date/i }),
    );
    expect(mix).toHaveClass("stale-highlight");
  });

  it("clears stale highlight when collapsed refresh fails", async () => {
    vi.mocked(execute).mockResolvedValueOnce({
      status: "disabled",
      reason: "Render preview failed",
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={staleProject()}>
        <TransportBar compact />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const refresh = screen.getByRole("menuitem", {
      name: /Mix out of date · Refresh/i,
    });
    await userEvent.hover(refresh);
    expect(useDawStore.getState().highlightStaleRender).toBe(true);
    await userEvent.click(refresh);
    expect(useDawStore.getState().highlightStaleRender).toBe(false);
  });
});
