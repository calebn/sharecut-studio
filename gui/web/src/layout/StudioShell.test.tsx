import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { StudioShell } from "./StudioShell";

vi.mock("../hooks/useViewportClass", () => ({
  useViewportClass: () => "tablet" as const,
  PHONE_MAX_PX: 767,
  TABLET_MAX_PX: 1100,
  shellBreakpointFromWidth: () => "tablet" as const,
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
});
