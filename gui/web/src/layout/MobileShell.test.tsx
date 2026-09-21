import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { CheatsheetDialogs } from "./CheatsheetDialogs";
import { MobileShell } from "./MobileShell";

describe("MobileShell", () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("shows primary mode nav and is axe-clean", async () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("button", { name: "Listen" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Timeline" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Text" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "More" })).toBeTruthy();
    expect(
      container.querySelector('[data-presence-anchor="mobile-nav:listen"]'),
    ).toBeTruthy();
    const shell = container.querySelector(".daw-shell--phone");
    expect(shell).toHaveClass("daw-shell--listen");
    expect(container.querySelector("header.transport")).toBeNull();
    expect(container.querySelectorAll(".mobile-listen-transport")).toHaveLength(
      1,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("sr-only");
    await expectNoA11yViolations(nav);
  });

  it("provides exactly one project heading in every phone mode", async () => {
    const user = userEvent.setup();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Test Episode" })).toHaveClass(
      "sr-only",
    );

    for (const mode of ["Timeline", "Text", "More"]) {
      await user.click(screen.getByRole("button", { name: mode }));
      const headings = screen.getAllByRole("heading", { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent("Test Episode");
      expect(headings[0]).not.toHaveClass("sr-only");
    }
  });

  it("gives Listen loading state a single screen-reader heading", () => {
    useDawStore.getState().hydrate("/tmp/p.json", null);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <MobileShell />
      </DawProvider>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Loading episode" }),
    ).toHaveClass("sr-only");
  });

  it("opens Gestures from More in an app-level modal and restores focus", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <div data-daw-app-chrome>
          <MobileShell />
        </div>
        <CheatsheetDialogs />
      </DawProvider>,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    const trigger = screen.getByRole("button", { name: "Gestures" });
    await user.click(trigger);

    const gestures = screen.getByRole("dialog", { name: "Gestures" });
    expect(gestures.closest("[data-daw-app-chrome]")).toBeNull();
    expect(
      container.querySelector<HTMLElement>("[data-daw-app-chrome]")?.inert,
    ).toBe(true);
    await expectNoA11yViolations(gestures);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(trigger).toHaveFocus();
  });

  it("switches between the Gestures and keyboard cheatsheets without stacking", async () => {
    const user = userEvent.setup();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <div data-daw-app-chrome>
          <MobileShell />
        </div>
        <CheatsheetDialogs />
      </DawProvider>,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Gestures" }));
    await user.click(
      screen.getByRole("button", { name: "Keyboard shortcuts" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Gestures" })).toBeNull();

    await user.click(
      within(
        screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
      ).getByRole("button", { name: "Gestures" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Gestures" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeNull();
  });

  it("keeps cheatsheets mutually exclusive for every store entry point", () => {
    useDawStore.getState().setGesturesSheetOpen(true);
    useDawStore.getState().toggleCommandPalette();
    expect(useDawStore.getState().commandPaletteOpen).toBe(true);
    expect(useDawStore.getState().gesturesSheetOpen).toBe(false);

    useDawStore.getState().setGesturesSheetOpen(true);
    expect(useDawStore.getState().gesturesSheetOpen).toBe(true);
    expect(useDawStore.getState().commandPaletteOpen).toBe(false);

    useDawStore.getState().setCommandPaletteOpen(true);
    expect(useDawStore.getState().commandPaletteOpen).toBe(true);
    expect(useDawStore.getState().gesturesSheetOpen).toBe(false);
  });

  it("Pending chip selects the first review-required edit and opens Timeline", async () => {
    const user = userEvent.setup();
    const project = minimalProject({
      pending_edits: [
        {
          id: "ed1",
          track_id: "host",
          type: "remove",
          reason: null,
          source_start: 1,
          source_end: 2,
          timeline_start: 1,
          timeline_end: 2,
          timeline_spans: [{ start: 1, end: 2 }],
          mappable: true,
          crossfade_ms: null,
          boundary_mode: null,
          cut_confidence: null,
          review_required: true,
          applied: false,
        },
      ],
      edit_impact: {
        pending_review_count: 1,
        total_removed_sec: 0,
        by_track_sec: {},
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", project, null);
    useDawStore.getState().setShellBreakpoint("phone");
    useDawStore.getState().setMobileMode("listen");
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <MobileShell />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Pending: 1" }));
    expect(useDawStore.getState().mobileMode).toBe("timeline");
    expect(useDawStore.getState().selection).toEqual({
      kind: "pending",
      id: "ed1",
      trackId: "host",
    });
  });

  it("phone pipeline chip shows a truncated headline without fake units", async () => {
    useDawStore.getState().setPipelineJob({
      id: "j-phone",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      status: "running",
      message: "Transcribing guest track with long Whisper model",
      current: null,
      total: null,
      error: null,
      elapsed_sec: 9,
      steps: [],
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    const chip = screen.getByRole("button", {
      name: /Pipeline: running · Transcribing guest track/,
    });
    expect(chip.textContent).toContain("…");
    expect(chip.textContent).toContain("0:09");
    expect(chip.textContent).not.toContain("●");
    expect(chip.querySelector(".pipeline-pulse")).toBeTruthy();
    expect(chip.className).toContain("status-pipeline");
    expect(chip.textContent).not.toMatch(/\d+\/\?/);
    expect(chip.getAttribute("aria-busy")).toBe("true");
  });

  it("shows an activity count badge for MCP fan-in without opening Pipeline", () => {
    act(() => {
      useDawStore.getState().setActivityJob({
        id: "a-phone",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        kind: "agent",
        label: "align_tracks",
        tool_id: "align_tracks",
        status: "running",
        message: "Scoring bleed windows",
        current: null,
        total: null,
        error: null,
        elapsed_sec: 4,
        steps: [],
      });
      useDawStore.getState().setActivityRunningCount(2);
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    const chip = screen
      .getByText(/Activity: running · Scoring bleed windows/)
      .closest(".status-pipeline");
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.querySelector(".activity-count-badge")?.textContent).toContain(
      "2 activities",
    );
    expect(useDawStore.getState().mobileMode).toBe("listen");
  });

  it("phone Listen chip opens More → Pipeline for bounce but not agent", async () => {
    const user = userEvent.setup();
    useDawStore.getState().setActivityJob({
      id: "b-phone",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      kind: "bounce",
      label: "Bounce",
      status: "running",
      message: "Mixing bounce…",
      current: 1,
      total: 2,
      error: null,
      elapsed_sec: 2,
      steps: [],
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    const bounceChip = screen.getByRole("button", {
      name: /Activity: running · Mixing bounce/,
    });
    await user.click(bounceChip);
    expect(useDawStore.getState().mobileMode).toBe("more");
    expect(useDawStore.getState().moreDestination).toBe("pipeline");

    act(() => {
      useDawStore.getState().setMobileMode("listen");
      useDawStore.getState().setActivityJob({
        id: "a-phone",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        kind: "agent",
        label: "align_tracks",
        status: "running",
        message: "Scoring",
        current: null,
        total: null,
        error: null,
        elapsed_sec: 1,
        steps: [],
      });
    });
    const agentChip = screen
      .getByText(/Activity: running · Scoring/)
      .closest(".status-pipeline");
    expect(agentChip?.tagName).toBe("SPAN");
    expect(useDawStore.getState().mobileMode).toBe("listen");
  });

  it("shows a non-interactive activity chip for guests", () => {
    useDawStore.getState().setActivityJob({
      id: "g1",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      kind: "agent",
      label: "Render preview",
      tool_id: "guest_render_preview",
      status: "running",
      message: "Mixing stems",
      current: null,
      total: null,
      error: null,
      elapsed_sec: 3,
      steps: [],
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell guestShare />
      </DawProvider>,
    );
    expect(
      screen.queryByRole("button", { name: /Activity: running/ }),
    ).toBeNull();
    expect(screen.getByText(/Activity: running/)).toBeTruthy();
  });

  it("phone pipeline chip ellipsizes stale companion copy", () => {
    const t0 = Date.now() / 1000 - 22;
    useDawStore.getState().setPipelineJob({
      id: "j-phone-stale",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      status: "running",
      message: "Transcribing guest track with long Whisper model",
      current: null,
      total: null,
      error: null,
      elapsed_sec: 9,
      last_progress_at: t0,
      steps: [],
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    const chip = screen.getByRole("button", {
      name: /Pipeline: running · Transcribing guest track/,
    });
    expect(chip.textContent).toContain("last update");
    expect(chip.querySelector(".status-pipeline-copy")).toBeTruthy();
    expect(chip.querySelector(".pipeline-stale")).toBeTruthy();
  });

  it("Timeline mode uses sticky headerSlot gutter without compact strip", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Timeline" }));
    expect(container.querySelector(".mobile-track-strip")).toBeNull();
    const headers = container.querySelector(".track-headers");
    expect(headers).toBeTruthy();
    expect(headers?.closest(".timeline-scroll")).toBeTruthy();
    expect(
      container.querySelector(".timeline-lock-inner--headers"),
    ).toBeTruthy();
    expect(
      container.querySelector(".timeline-area--fixed-playhead"),
    ).toBeTruthy();
  });

  it("opens the inspector sheet when a track header row is clicked", async () => {
    const user = userEvent.setup();
    const project = minimalProject({
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
    useDawStore.getState().hydrate("/tmp/p.json", project, null);
    useDawStore.getState().setShellBreakpoint("phone");
    useDawStore.getState().setMobileMode("timeline");
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <MobileShell />
      </DawProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: /Open track details, Guest/i }),
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "track",
      trackId: "guest",
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Track mixer" })).toBeTruthy();
    expect(
      document.querySelector(".daw-shell--phone .track-header-disclose")
        ?.textContent,
    ).toContain("›");
  });

  it("switches to Text and More while a track is selected without covering them", async () => {
    const user = userEvent.setup();
    const project = minimalProject({
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
    useDawStore.getState().hydrate("/tmp/p.json", project, null);
    useDawStore.getState().setShellBreakpoint("phone");
    useDawStore.getState().setMobileMode("timeline");
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <MobileShell />
      </DawProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: /Open track details, Guest/i }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Text" }));
    expect(useDawStore.getState().mobileMode).toBe("text");
    expect(useDawStore.getState().selection).toEqual({
      kind: "track",
      trackId: "guest",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".mobile-text-mode")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(useDawStore.getState().mobileMode).toBe("more");
    expect(useDawStore.getState().selection).toEqual({
      kind: "track",
      trackId: "guest",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".mobile-more-mode")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Timeline" }));
    expect(useDawStore.getState().mobileMode).toBe("timeline");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens the phone inspector sheet when Correct selects a transcript word in Text", async () => {
    const user = userEvent.setup();
    const project = minimalProject({
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 1,
            text: "hello",
            timeline_start: 0,
            timeline_end: 1,
            mappable: true,
            words: [
              {
                text: "hello",
                start: 0,
                end: 1,
                timeline_start: 0,
                timeline_end: 1,
                word_index: 0,
                confidence: 0.9,
              },
            ],
          },
        ],
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", project, null);
    useDawStore.getState().setShellBreakpoint("phone");
    useDawStore.getState().setMobileMode("text");
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <MobileShell />
      </DawProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Correct:/ }));
    await user.click(screen.getByRole("button", { name: "hello" }));

    expect(useDawStore.getState().selection).toEqual({
      kind: "transcriptWord",
      trackId: "host",
      wordIndex: 0,
    });
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeTruthy();
  });

  it("disables labeled Play/Stop while the episode is loading", () => {
    useDawStore.getState().hydrate("/tmp/p.json", null);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <MobileShell />
      </DawProvider>,
    );
    expect(
      screen
        .getAllByRole("button", { name: "Play" })
        .every((el) => el.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: "Stop" })
        .every((el) => el.hasAttribute("disabled")),
    ).toBe(true);
    expect(document.querySelector(".mobile-play-lg")).toHaveAttribute(
      "aria-label",
      "Play",
    );
    expect(screen.getAllByText("Loading episode…").length).toBeGreaterThan(0);
  });

  it("announces follow status in a live region", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().announceStatus("Following Ada");
    });
    const live = document.querySelector(".daw-shell--phone .sr-only");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toBe("Following Ada");
  });

  it("unfollows when Listen scrub moves the playhead", async () => {
    useDawStore.setState({ followingClientId: "a" });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <MobileShell />
      </DawProvider>,
    );
    const scrub = screen.getByLabelText("Scrub timeline");
    await act(async () => {
      fireEvent.change(scrub, { target: { value: "1.5" } });
    });
    expect(useDawStore.getState().followingClientId).toBeNull();
  });
});
