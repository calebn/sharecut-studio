import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { MARKER_ROW_HEIGHT, RULER_HEIGHT } from "../utils/layout";
import { StudioShell } from "./StudioShell";

const offlineStore = vi.hoisted(() => ({
  clearConflicts: vi.fn(),
  clearHostConflicts: vi.fn(),
  loadConflicts: vi.fn(),
  loadHostCommandCount: vi.fn(),
  loadHostConflicts: vi.fn(),
}));

vi.mock("../state/offlineStore", () => offlineStore);

vi.mock("../hooks/useViewportClass", () => ({
  useViewportClass: () => "tablet" as const,
  PHONE_MAX_PX: 767,
  TABLET_MAX_PX: 1100,
  shellBreakpointFromWidth: () => "tablet" as const,
}));

// Full-shell render; not exercising waveform fetching.
vi.mock("../hooks/usePeaks", () => ({
  usePeaks: () => ({ peaks: null, status: "idle" }),
}));

const tabletProject = () =>
  minimalProject({
    tracks: [
      {
        id: "guest",
        label: "Guest",
        role: "dialogue",
        speaker: null,
        gain_db: 0,
        muted: false,
        duration_sec: 60,
        fx_count: 0,
        stem_is_fresh: true,
      },
    ],
  });

describe("StudioShell tablet peek", () => {
  beforeEach(() => {
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    useDawStore.getState().setSelection(null);
    useDawStore.getState().setFocusMode("default");
    useDawStore.getState().setActiveTab("transcript");
    useDawStore.getState().setShellBreakpoint("tablet");
  });

  it("hides the peek sheet in text focus while keeping the track selection", async () => {
    const project = tabletProject();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <StudioShell />
      </DawProvider>,
    );

    act(() => {
      useDawStore.getState().setSelection({ kind: "track", trackId: "guest" });
    });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Transcript" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Transcript" })).toHaveAttribute(
      "data-presence-anchor",
      "tab:transcript",
    );

    act(() => {
      useDawStore.getState().setFocusMode("text");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().selection).toEqual({
      kind: "track",
      trackId: "guest",
    });
    expect(useDawStore.getState().activeTab).toBe("transcript");
  });

  it("clears html data-shell and data-focus on unmount", () => {
    const project = tabletProject();
    const { unmount } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <StudioShell />
      </DawProvider>,
    );
    expect(document.documentElement.dataset.shell).toBe("tablet");
    act(() => {
      useDawStore.getState().setFocusMode("timeline");
    });
    expect(document.documentElement.dataset.focus).toBe("timeline");
    unmount();
    expect(document.documentElement.dataset.shell).toBeUndefined();
    expect(document.documentElement.dataset.focus).toBeUndefined();
  });

  it("paints DAW chrome while project is null without the ingest empty-session", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <StudioShell />
      </DawProvider>,
    );
    expect(screen.getAllByText("Loading episode…").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Drop audio files/)).toBeNull();
    expect(screen.getByRole("button", { name: "Transcript" })).toBeTruthy();
    expect(screen.getByLabelText("Loading timeline")).toBeTruthy();
    const main = document.querySelector("main.daw-main");
    expect(main?.className).not.toContain("daw-main--arrange");
  });

  it("aligns the loading header chrome with the timeline skeleton", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <StudioShell />
      </DawProvider>,
    );
    const chrome = document.querySelector(
      ".track-headers-chrome",
    ) as HTMLElement;
    const skeleton = document.querySelector(
      ".timeline-skeleton-chrome",
    ) as HTMLElement;
    expect(chrome.style.height).not.toBe("");
    expect(skeleton.style.height).toBe(chrome.style.height);
  });

  it("hosts headers in the timeline for an empty session without ingest", () => {
    useDawStore.getState().hydrate("share:tok", minimalProject({ tracks: [] }));
    render(
      <DawProvider
        projectPath="share:tok"
        initialProject={minimalProject({ tracks: [] })}
      >
        <StudioShell />
      </DawProvider>,
    );
    expect(screen.queryByText(/Drop audio files/)).toBeNull();
    // Inside TimelineView's metrics provider, so the header chrome matches
    // the ruler + quiet marker row the timeline draws.
    const chrome = document.querySelector(
      ".timeline-scroll .track-headers .track-headers-chrome",
    ) as HTMLElement;
    expect(chrome.style.height).toBe(`${RULER_HEIGHT + MARKER_ROW_HEIGHT}px`);
    expect(document.querySelector("main.daw-main")?.className).toContain(
      "daw-main--arrange",
    );
  });

  it("keeps the empty timeline an accessible import target with decorative waveform", async () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ tracks: [] })}
      >
        <StudioShell />
      </DawProvider>,
    );
    const target = screen.getByRole("button", {
      name: "Drop audio files or import",
    });
    expect(target.querySelector(".empty-session-ghost")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(target).toHaveTextContent("Drop audio files here");
    await expectNoA11yViolations(target);
  });

  it("renders when localStorage.getItem throws", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    try {
      render(
        <DawProvider projectPath="/tmp/p.json" initialProject={tabletProject()}>
          <StudioShell />
        </DawProvider>,
      );
      expect(screen.getByRole("button", { name: "Transcript" })).toBeTruthy();
    } finally {
      getItem.mockRestore();
    }
  });

  it("shows queued host commands in the attention banner", async () => {
    offlineStore.loadHostCommandCount.mockResolvedValue(1);
    const project = tabletProject();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <StudioShell />
      </DawProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Needs attention");
    expect(alert).toHaveTextContent("1 pending");
    expect(container.querySelector(".daw-shell")).toHaveClass(
      "daw-shell--attention",
    );
    await expectNoA11yViolations(alert);
  });
});
