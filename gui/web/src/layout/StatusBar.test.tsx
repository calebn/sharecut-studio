import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { StatusBar } from "./StatusBar";

describe("StatusBar live region", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setPipelineJob(null);
    useDawStore.getState().setActivityJob(null);
    useDawStore.getState().setActivityRunningCount(0);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("uses presence display names in the roster title", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <StatusBar />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        sessionClients: [
          {
            client_id: "x",
            role: "viewer",
            label: "old",
            meta: { display_name: "Ada" },
          },
        ],
      });
    });
    expect(screen.getByTitle("Ada (viewer)")).toBeTruthy();
  });
});
