import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { MobileShell } from "./MobileShell";

const offlineStore = vi.hoisted(() => ({
  clearConflicts: vi.fn(),
  clearHostConflicts: vi.fn(),
  loadConflicts: vi.fn(),
  loadHostCommandCount: vi.fn(),
  loadHostConflicts: vi.fn(),
}));

vi.mock("../state/offlineStore", () => offlineStore);

// Full-shell render; not exercising waveform fetching.
// No waveform status polls: shell tests do not fetch.
vi.mock("../waveform/statusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../waveform/statusStore")>()),
  useWaveformStatus: () => null,
  useLaneWaveformStatus: () => "idle",
}));

describe("MobileShell Mix", () => {
  beforeEach(() => {
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject(), null);
    useDawStore.getState().setSelection(null);
    useDawStore.getState().setPipelineJob(null);
    useDawStore.getState().setActivityJob(null);
    useDawStore.getState().setShellBreakpoint("phone");
    useDawStore.getState().setMobileMode("listen");
    useDawStore.getState().setGesturesSheetOpen(false);
    useDawStore.getState().setCommandPaletteOpen(false);
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().setCaptureHealth(null);
    useRecordHostStore.getState().setConnected(true);
    useDawStore.setState({ pendingJobResults: {}, spokenJobResultIds: [] });
  });

  afterEach(() => {
    useRecordHostStore.getState().resetConnection();
    clearRegisteredCommands();
  });

  it.each([null, "edit", "view", "suggest"])(
    "offers Mix for %s with one full sheet and Close/Escape restoration",
    async (guestMode) => {
      const user = userEvent.setup();
      render(
        <DawProvider
          projectPath={guestMode ? "share:mix" : "/tmp/p.json"}
          guestMode={guestMode}
          shareCapabilities={guestMode === "edit" ? ["view", "edit"] : ["view"]}
          initialProject={minimalProject({ tracks: [sampleTrack()] })}
        >
          <MobileShell guestShare={guestMode != null} />
        </DawProvider>,
      );
      await user.click(screen.getByRole("button", { name: "More" }));
      const trigger = screen.getByRole("button", { name: "Mix" });
      await user.click(trigger);
      const mix = screen.getByRole("dialog", { name: "Mix" });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(mix).toHaveClass("bottom-sheet--full");
      expect(mix).toHaveAttribute("aria-modal", "false");
      expect(
        within(mix).getByRole("slider", { name: "Volume host" }),
      ).toHaveValue("0");
      await expectNoA11yViolations(document.body);
      await user.click(within(mix).getByRole("button", { name: "Close" }));
      expect(trigger).toHaveFocus();
      await user.click(trigger);
      await user.keyboard("{Escape}");
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(trigger);
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("clears inspector intent before Mix and permanently invalidates stale requests", async () => {
    const user = userEvent.setup();
    const project = minimalProject({ tracks: [sampleTrack()] });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <MobileShell />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    act(() => {
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" });
      useDawStore.getState().setRangeArmed(true);
    });
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Mix" }));
    expect(useDawStore.getState().rangeArmed).toBe(false);
    expect(useDawStore.getState().selection).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Mix" })).toBeVisible();
    act(() =>
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useDawStore.getState().setSelection(null));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mix" }));
    act(() => useDawStore.getState().setRangeArmed(true));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "Inspector" })).getByRole(
          "button",
          { name: "Close" },
        ),
      ).toHaveFocus(),
    );
    act(() => useDawStore.getState().setRangeArmed(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["mode", "destination", "project", "follow", "gestures"] as const)(
    "invalidates Mix across %s changes without reopening",
    async (change) => {
      const user = userEvent.setup();
      const project = minimalProject({ tracks: [sampleTrack()] });
      render(
        <DawProvider projectPath="/tmp/p.json" initialProject={project}>
          <MobileShell />
        </DawProvider>,
      );
      await user.click(screen.getByRole("button", { name: "More" }));
      await user.click(screen.getByRole("button", { name: "Mix" }));
      act(() => {
        if (change === "mode") useDawStore.getState().setMobileMode("text");
        if (change === "destination")
          useDawStore.getState().setMoreDestination("comments");
        if (change === "project")
          useDawStore.setState({ projectPath: "/tmp/other.json" });
        if (change === "follow")
          useDawStore.setState({ followingClientId: "peer" });
        if (change === "gestures")
          useDawStore.getState().setGesturesSheetOpen(true);
      });
      expect(screen.queryByRole("dialog", { name: "Mix" })).toBeNull();
      act(() => {
        useDawStore.getState().setMobileMode("more");
        useDawStore.getState().setMoreDestination("hub");
        useDawStore.setState({
          projectPath: "/tmp/p.json",
          followingClientId: null,
        });
        useDawStore.getState().setGesturesSheetOpen(false);
      });
      expect(screen.queryByRole("dialog", { name: "Mix" })).toBeNull();
    },
  );

  it("preserves navigation focus and does not reopen Mix after returning", async () => {
    const user = userEvent.setup();
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ tracks: [sampleTrack()] })}
      >
        <MobileShell />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Mix" }));
    const moreNav = within(
      screen.getByRole("navigation", { name: "Primary" }),
    ).getByRole("button", { name: "More" });
    await user.click(moreNav);
    expect(moreNav).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mix" }));
    await user.click(screen.getByRole("button", { name: "Text" }));
    expect(screen.getByRole("button", { name: "Text" })).toHaveFocus();
    await user.click(moreNav);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
