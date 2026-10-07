import { act, render, screen } from "@testing-library/react";
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

function neverRenderedProject(renderExtras: Record<string, unknown> = {}) {
  return minimalProject({
    tracks: [sampleTrack({ id: "t1", stem_is_fresh: true })],
    render_status: {
      needs_rerender: true,
      reconciliation: { stale: false },
      premix: { exists: false },
      ...renderExtras,
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
    expect(pill).toHaveTextContent(/^Mix out of date · Refresh$/);
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

  it("keeps Mix out of date when an old mix exists, and No mix yet when none does", () => {
    const withMix = staleProject();
    expect(withMix.render_status.premix.exists).toBe(true);
    const { unmount } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={withMix}>
        <TransportBar />
      </DawProvider>,
    );
    expect(
      screen.getByRole("button", { name: /Mix out of date/i }),
    ).toHaveTextContent(/^Mix out of date · Refresh$/);
    expect(screen.queryByText(/No mix yet/)).toBeNull();
    unmount();

    const never = neverRenderedProject();
    useDawStore.getState().hydrate("/tmp/p.json", never);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={never}>
        <TransportBar />
      </DawProvider>,
    );
    expect(
      screen.getByRole("button", { name: /No mix yet/i }),
    ).toHaveTextContent(/^No mix yet · Refresh$/);
    expect(screen.queryByText(/Mix out of date/)).toBeNull();
  });

  it("keeps No mix yet and the Refresh action after a failed render", async () => {
    vi.mocked(execute).mockResolvedValueOnce({
      status: "disabled",
      reason: "Render preview failed",
    });
    const project = neverRenderedProject();
    useDawStore.getState().hydrate("/tmp/p.json", project);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TransportBar />
      </DawProvider>,
    );
    const pill = () =>
      screen.getByRole("button", { name: /No mix yet|Refreshing/ });
    await userEvent.click(pill());
    expect(execute).toHaveBeenCalledTimes(1);
    act(() => useDawStore.getState().setRenderPreviewBusy(true));
    expect(pill()).toHaveTextContent(/^Refreshing…$/);
    act(() => useDawStore.getState().setRenderPreviewBusy(false));
    expect(pill()).toHaveTextContent(/^No mix yet · Refresh$/);
    expect(pill().getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(pill());
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("names the other causes once when the mix is missing and cut", () => {
    const project = neverRenderedProject({
      invalidations: [
        {
          id: "i1",
          track_ids: ["t1"],
          timeline_start: null,
          timeline_end: null,
          reason: "cut",
          at: "2026-10-06T00:00:00Z",
        },
      ],
    });
    useDawStore.getState().hydrate("/tmp/p.json", project);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TransportBar />
      </DawProvider>,
    );
    expect(
      screen
        .getByRole("button", { name: /No mix yet/i })
        .getAttribute("aria-label"),
    ).toBe("No mix yet. Cut. Refresh mix.");
  });

  it("never repeats a clause when the mix is stale for no named cause", () => {
    const project = minimalProject({
      tracks: [sampleTrack({ stem_is_fresh: true })],
      render_status: {
        needs_rerender: true,
        reconciliation: { stale: false },
        premix: { exists: true },
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", project);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TransportBar />
      </DawProvider>,
    );
    const pill = screen.getByRole("button", { name: /Mix out of date/i });
    expect(pill).toHaveAttribute("aria-label", "Mix out of date. Refresh mix.");
    expect(pill.getAttribute("title")).toMatch(
      /^Mix out of date\. Click or .* to refresh mix\.$/,
    );
  });
});
