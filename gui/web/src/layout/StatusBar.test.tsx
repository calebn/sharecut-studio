import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject, sampleTrack, sessionRoster } from "../test/fixtures";
import { StatusBar } from "./StatusBar";

// Delegates to the real hook; its call count is how many times StatusBar's
// own function body ran (it is called unconditionally at the top).
const breakdownCalls = vi.hoisted(() => vi.fn());
vi.mock("../hooks/useStaleRenderBreakdown", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../hooks/useStaleRenderBreakdown")>();
  return {
    ...mod,
    useStaleRenderBreakdown: (
      ...args: Parameters<typeof mod.useStaleRenderBreakdown>
    ) => {
      breakdownCalls();
      return mod.useStaleRenderBreakdown(...args);
    },
  };
});

describe("StatusBar chips", () => {
  it("reveal their tab, restoring any layout that does not show it", async () => {
    const user = userEvent.setup();
    const project = minimalProject();
    useDawStore.getState().hydrate("/tmp/p.json", project, null);
    useDawStore.setState({ layoutMode: "timeline" });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <StatusBar />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /^Pending:/ }));
    expect(useDawStore.getState().layoutMode).toBe("default");
    expect(useDawStore.getState().activeTab).toBe("impact");
    act(() => useDawStore.getState().setLayoutMode("text"));
    await user.click(screen.getByRole("button", { name: /^Pending:/ }));
    expect(useDawStore.getState().layoutMode).toBe("default");
    expect(useDawStore.getState().activeTab).toBe("impact");
    act(() => useDawStore.getState().setLayoutMode("review"));
    await user.click(screen.getByRole("button", { name: "Open comments" }));
    expect(useDawStore.getState().layoutMode).toBe("review");
    expect(useDawStore.getState().activeTab).toBe("comments");
    act(() => useDawStore.setState({ layoutMode: "timeline" }));
    await user.click(screen.getByRole("button", { name: "Open comments" }));
    expect(useDawStore.getState().layoutMode).toBe("default");
    expect(useDawStore.getState().activeTab).toBe("comments");
    useDawStore.setState({ layoutMode: "default" });
  });
});

describe("StatusBar render state", () => {
  afterEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("agrees with the transport for a new empty project", () => {
    // needs_rerender is true for a project that has never had media; the
    // transport treats that as fresh, and the status bar must match.
    const project = minimalProject({
      render_status: {
        needs_rerender: true,
        reconciliation: { stale: true },
        premix: { exists: false },
        invalidations: [],
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", project, null);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <StatusBar />
      </DawProvider>,
    );
    expect(screen.getByRole("button", { name: "Mix up to date" })).toBeTruthy();
    expect(screen.queryByText(/Rerender|Reconcile|Premix/)).toBeNull();
    expect(screen.queryByText("Transcript: needs sync")).toBeNull();
  });

  it("reports a stale render and transcript sync once media exists", () => {
    const project = minimalProject({
      tracks: [
        {
          id: "host",
          label: "Host",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 60,
          fx_count: 0,
          stem_is_fresh: true,
          media_path: "/tmp/host.wav",
        },
      ],
      render_status: {
        needs_rerender: false,
        reconciliation: { stale: true },
        premix: { exists: false },
        invalidations: [],
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", project, null);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <StatusBar />
      </DawProvider>,
    );
    const chip = screen.getByRole("button", { name: "Mix out of date" });
    expect(chip.getAttribute("title")).toContain("No mix preview");
    expect(screen.getByText("Transcript: needs sync")).toBeTruthy();
  });
});

describe("StatusBar live region", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setPipelineJob(null);
    useDawStore.getState().setActivityJob(null);
    useDawStore.getState().setActivityRunningCount(0);
    useDawStore.setState({ jobResultAnnouncement: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts only share guests in presence (#533)", () => {
    useDawStore.setState({
      localClientId: "h1",
      sessionClients: sessionRoster([{ client_id: "h1", role: "viewer" }]),
    } as never);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    expect(screen.getByText("Presence: You")).toBeTruthy();
    expect(screen.queryByText(/guest/)).toBeNull();
    act(() => {
      useDawStore.setState({
        sessionClients: sessionRoster([
          { client_id: "h1", role: "viewer" },
          { client_id: "guest-abcd1234-g1", role: "viewer" },
          { client_id: "a1", role: "agent" },
        ]),
      } as never);
    });
    expect(screen.getByText("Presence: You + 1 guest · 1 agent")).toBeTruthy();
    act(() => {
      useDawStore.setState({
        localClientId: null,
        sessionClients: sessionRoster([]),
      });
    });
  });

  it("exposes polite status announcements for assistive tech", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().announceStatus("Mix preview refreshed");
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Mix preview refreshed");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("shows the live pipeline phase headline from the job message", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setPipelineJob({
        id: "j1",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        status: "running",
        message: "Aligning conversation",
        current: 1,
        total: 2,
        error: null,
        elapsed_sec: 12,
        steps: [],
      });
    });
    expect(
      screen.getByRole("button", {
        name: /Pipeline: running · Aligning conversation · 1\/2 steps/,
      }),
    ).toBeTruthy();
  });

  it("omits units for indeterminate jobs and marks the chip busy", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setPipelineJob({
        id: "j2",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        status: "running",
        message: "Whisper encode",
        current: null,
        total: null,
        error: null,
        elapsed_sec: 3,
        steps: [],
      });
    });
    const chip = screen.getByRole("button", {
      name: /Pipeline: running · Whisper encode/,
    });
    expect(chip.getAttribute("aria-busy")).toBe("true");
    expect(chip.querySelector(".pipeline-pulse")).toBeTruthy();
    expect(chip.textContent).not.toMatch(/\d+\/\?/);
  });

  it("labels cancelled distinctly from failed", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setPipelineJob({
        id: "j3",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        status: "cancelled",
        message: "Stopped by user",
        current: 1,
        total: 4,
        error: null,
        elapsed_sec: 8,
        steps: [],
      });
    });
    expect(
      screen.getByRole("button", {
        name: /Pipeline: cancelled · Stopped by user/,
      }),
    ).toBeTruthy();
  });

  it("labels error jobs as failed", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setPipelineJob({
        id: "j4",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        status: "error",
        message: "Step exploded",
        current: 1,
        total: 4,
        error: "boom",
        elapsed_sec: 8,
        steps: [],
      });
    });
    expect(
      screen.getByRole("button", {
        name: /Pipeline: failed · Step exploded/,
      }),
    ).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Pipeline: failed: Step exploded");
    expect(status.textContent).not.toMatch(/\d+:\d+/);
  });

  it("renders an agent job headline and a count badge at two activities", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setActivityJob({
        id: "a1",
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
    const chip = screen
      .getByText(/Activity: running · Scoring bleed windows/)
      .closest(".status-pipeline");
    expect(chip).toBeTruthy();
    expect(chip?.querySelector(".activity-count-badge")?.textContent).toContain(
      "2 activities",
    );
    expect(chip?.tagName).toBe("SPAN");
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("2 activities");
    expect(status.textContent).toContain("Activity: running");
  });

  it("announces a job's own result once its chip reaches a terminal status (#704)", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore
        .getState()
        .announceJobResult("b1", "Bounced 1 file(s) to export/bounces/");
      useDawStore.getState().setActivityJob({
        id: "b1",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        kind: "bounce",
        label: "Bounce",
        status: "ok",
        message: "Bounce complete",
        current: 2,
        total: 2,
        error: null,
        elapsed_sec: 3,
        steps: [],
      });
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Bounced 1 file(s) to export/bounces/");
    expect(status.textContent).not.toContain("Activity: ok");
  });

  it("stays quiet for a matching job result while its chip is still running", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    const before = screen.getByRole("status").textContent;
    act(() => {
      useDawStore
        .getState()
        .announceJobResult("b1", "Bounced 1 file(s) to export/bounces/");
      useDawStore.getState().setActivityJob({
        id: "b1",
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
        elapsed_sec: 1,
        steps: [],
      });
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(before);
  });

  it("falls back to the generic headline when the stored result is for a different job", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore
        .getState()
        .announceJobResult("b0", "Bounced 1 file(s) to export/bounces/");
      useDawStore.getState().setActivityJob({
        id: "b1",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        kind: "bounce",
        label: "Bounce",
        status: "ok",
        message: "Bounce complete",
        current: 2,
        total: 2,
        error: null,
        elapsed_sec: 3,
        steps: [],
      });
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Activity: ok: Bounce complete");
  });

  it("opens Pipeline from a bounce chip and leaves agent chips inert", async () => {
    const user = userEvent.setup();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setActivityJob({
        id: "b1",
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
        elapsed_sec: 1,
        steps: [],
      });
    });
    const bounceChip = screen.getByRole("button", {
      name: /Activity: running · Mixing bounce/,
    });
    await user.click(bounceChip);
    expect(useDawStore.getState().activeTab).toBe("pipeline");

    act(() => {
      useDawStore.getState().setActiveTab("impact");
      useDawStore.getState().setActivityJob({
        id: "a1",
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
    expect(useDawStore.getState().activeTab).toBe("impact");
  });

  it("renders a non-interactive activity chip for guests", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar guestShare />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setActivityJob({
        id: "a1",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        kind: "agent",
        label: "Render preview",
        status: "running",
        message: "Mixing stems",
        current: null,
        total: null,
        error: null,
        elapsed_sec: 4,
        steps: [],
      });
    });
    expect(
      screen.queryByRole("button", { name: /Activity: running/ }),
    ).toBeNull();
    expect(screen.getByText(/Activity: running · Mixing stems/)).toBeTruthy();
  });

  it("shows last-update copy once lag exceeds 15s without dropping the pulse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const t0 = Date.now() / 1000;
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.getState().setPipelineJob({
        id: "j-stale",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        status: "running",
        message: "Aligning conversation",
        current: null,
        total: null,
        error: null,
        elapsed_sec: 12,
        last_progress_at: t0,
        steps: [],
      });
    });
    const chip = screen.getByRole("button", {
      name: /Pipeline: running · Aligning conversation/,
    });
    expect(chip.textContent).not.toContain("last update");
    expect(chip.querySelector(".pipeline-pulse")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(chip.textContent).not.toContain("last update");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(chip.textContent).toContain("last update 16s ago");
    expect(chip.querySelector(".pipeline-stale")).toBeTruthy();
    expect(chip.querySelector(".pipeline-pulse")).toBeTruthy();

    act(() => {
      useDawStore.getState().setPipelineJob({
        id: "j-stale",
        project_path: "/tmp/p.json",
        from_step: null,
        only_step: null,
        status: "running",
        message: "Aligning conversation",
        current: null,
        total: null,
        error: null,
        elapsed_sec: 12,
        last_progress_at: Date.now() / 1000,
        steps: [],
      });
    });
    expect(chip.textContent).not.toContain("last update");
    expect(chip.querySelector(".pipeline-pulse")).toBeTruthy();
  });

  it("does not re-render on a presence frame; the presence chip still updates", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    breakdownCalls.mockClear();
    act(() => {
      useDawStore.setState({
        localClientId: "h1",
        sessionClients: sessionRoster([
          { client_id: "h1", role: "viewer" },
        ]) as never,
      });
    });
    act(() => {
      useDawStore.setState({
        sessionClients: sessionRoster([
          { client_id: "h1", role: "viewer" },
          { client_id: "guest-abcd1234-g1", role: "viewer" },
        ]) as never,
      });
    });
    expect(breakdownCalls).not.toHaveBeenCalled();
    expect(screen.getByText("Presence: You + 1 guest")).toBeTruthy();
  });

  it("uses presence display names in the roster title", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        sessionClients: sessionRoster([
          {
            client_id: "x",
            role: "viewer",
            label: "old",
            meta: { display_name: "Ada" },
          },
        ]),
      });
    });
    expect(screen.getByTitle("Ada (viewer)")).toBeTruthy();
  });
});

describe("StatusBar cut chip", () => {
  function renderWith(project: ReturnType<typeof minimalProject>) {
    useDawStore.getState().hydrate("/tmp/p.json", project, null);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <StatusBar />
      </DawProvider>,
    );
  }

  afterEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("reports source vs timeline length, not remove decisions (#533)", () => {
    renderWith(
      minimalProject({
        tracks: [sampleTrack({ duration_sec: 1689.4 })],
        timeline_duration_sec: 221.3,
        edit_impact: {
          pending_review_count: 0,
          total_removed_sec: 0,
          by_track_sec: {},
        },
      }),
    );
    expect(screen.getByText("Cut 24:28 of 28:09")).toBeTruthy();
    expect(screen.queryByText(/Removed:/)).toBeNull();
  });

  it("is hidden without source media", () => {
    renderWith(minimalProject());
    expect(screen.queryByText(/^Cut /)).toBeNull();
  });
});
