import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { MobileShell } from "./MobileShell";

const offlineStore = vi.hoisted(() => ({
  clearConflicts: vi.fn(),
  clearHostConflicts: vi.fn(),
  loadConflicts: vi.fn(),
  loadCommandQueue: vi.fn(),
  loadHostCommandCount: vi.fn(),
  loadHostConflicts: vi.fn(),
}));

vi.mock("../state/offlineStore", () => offlineStore);

vi.mock("../waveform/statusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../waveform/statusStore")>()),
  useWaveformStatus: () => null,
  useLaneWaveformStatus: () => "idle",
}));

describe("MobileShell adapter contracts", () => {
  beforeEach(() => {
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadCommandQueue.mockResolvedValue([]);
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

  it.each([
    [
      "text",
      "hub",
      {
        kind: "transcriptRange",
        trackId: "host",
        startWordIndex: 0,
        endWordIndex: 1,
      },
      true,
    ],
    ["text", "hub", { kind: "comment", id: "c1" }, false],
    ["more", "impact", { kind: "pending", id: "e1", trackId: "host" }, true],
    ["more", "comments", { kind: "pending", id: "e1", trackId: "host" }, false],
    ["more", "impact", { kind: "comment", id: "c1" }, false],
    ["more", "pipeline", { kind: "track", trackId: "host" }, false],
  ] as const)(
    "preserves sheet eligibility in %s/%s for %j as %s",
    (mode, destination, selection, open) => {
      useDawStore.getState().setMoreDestination(destination);
      useDawStore.getState().setMobileMode(mode);
      render(
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject({
            transcript: {
              utterances: [
                {
                  track_id: "host",
                  speaker: "Mira",
                  start: 0,
                  end: 2,
                  text: "Welcome back",
                  timeline_start: 0,
                  timeline_end: 2,
                  mappable: true,
                  words: [
                    {
                      text: "Welcome",
                      start: 0,
                      end: 1,
                      timeline_start: 0,
                      timeline_end: 1,
                      word_index: 0,
                    },
                    {
                      text: "back",
                      start: 1,
                      end: 2,
                      timeline_start: 1,
                      timeline_end: 2,
                      word_index: 1,
                    },
                  ],
                },
              ],
            },
          })}
        >
          <MobileShell />
        </DawProvider>,
      );
      if (selection.kind === "transcriptRange") {
        fireEvent.click(screen.getByRole("button", { name: /^Select:/ }));
      }
      act(() => useDawStore.getState().setSelection(selection));
      expect(
        screen.getByRole("button", { name: mode === "text" ? "Text" : "More" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("dialog", { name: "Inspector" }) !== null).toBe(
        open,
      );
      expect(useDawStore.getState().selection).toEqual(selection);
    },
  );

  it("closes an armed range sheet by disarming, clearing selection, and collapsing", async () => {
    useDawStore.getState().setMobileMode("more");
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setRangeArmed(true);
      useDawStore.getState().setSheetExpanded(true);
    });
    expect(screen.getByRole("dialog", { name: "Inspector" })).toHaveClass(
      "bottom-sheet--full",
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useDawStore.getState().rangeArmed).toBe(false);
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().sheetExpanded).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it.each(["history", "impact", "tighten", "pipeline"] as const)(
    "hides stale host-only %s content and back button for guests",
    (destination) => {
      useDawStore.getState().setMobileMode("more");
      useDawStore.getState().setMoreDestination(destination);
      const { container } = render(
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject()}
        >
          <MobileShell guestShare />
        </DawProvider>,
      );
      expect(
        container.querySelector(".mobile-more-mode"),
      ).toBeEmptyDOMElement();
      expect(screen.getByRole("button", { name: "More" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.queryByRole("button", { name: "← More" })).toBeNull();
    },
  );

  it("returns to More hub and retains transport, text, and More focus targets", async () => {
    useDawStore.getState().setMobileMode("more");
    useDawStore.getState().setMoreDestination("comments");
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    fireEvent.mouseDown(container.querySelector(".mobile-more-mode")!);
    expect(useDawStore.getState().timelineFocused).toBe(false);
    fireEvent.mouseDown(container.querySelector(".daw-shell-transport")!);
    expect(useDawStore.getState().timelineFocused).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "← More" }));
    expect(useDawStore.getState().moreDestination).toBe("hub");
    expect(
      screen.getByRole("button", { name: "Gestures" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Text" }));
    fireEvent.mouseDown(container.querySelector(".mobile-text-mode")!);
    expect(useDawStore.getState().timelineFocused).toBe(false);
  });
  it("collapses the sheet after selection is cleared outside the sheet", () => {
    useDawStore.getState().setMobileMode("timeline");
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" });
      useDawStore.getState().setSheetExpanded(true);
    });
    expect(screen.getByRole("dialog", { name: "Inspector" })).toHaveClass(
      "bottom-sheet--full",
    );
    act(() => useDawStore.getState().setSelection(null));
    expect(useDawStore.getState().sheetExpanded).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(screen.getByRole("button", { name: "Timeline" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
