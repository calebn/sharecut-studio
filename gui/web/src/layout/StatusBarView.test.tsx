import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  minimalProject,
  pipelineJobSnapshot,
  sampleTrack,
} from "../test/fixtures";
import { staleRenderBreakdown } from "../utils/staleRender";
import { StatusBarView } from "./StatusBarView";
import { statusBarSummary } from "./statusBarSummary";

function summaryOf(project: ReturnType<typeof minimalProject>) {
  return statusBarSummary(project, staleRenderBreakdown(project));
}

describe("StatusBarView", () => {
  it("shows the loading footer and its live region when there is no summary", async () => {
    const { container } = render(
      <StatusBarView
        summary={null}
        narrow={false}
        statusAnnouncement="Hello"
        onOpenTab={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading episode…")).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Hello");
    expect(status.getAttribute("aria-live")).toBe("polite");
    await expectNoA11yViolations(container);
  });

  it("opens impact, impact, pipeline and comments from their chips", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    const project = minimalProject({
      pending_edits: [
        {
          id: "e1",
          track_id: "host",
          type: "remove",
          reason: null,
          source_start: 0,
          source_end: 1,
          timeline_start: null,
          timeline_end: null,
          timeline_spans: [],
          mappable: false,
          crossfade_ms: null,
          boundary_mode: null,
          cut_confidence: null,
          review_required: false,
          applied: false,
        },
      ],
      social_clips: [
        {
          id: "c1",
          track_id: "host",
          start: 0,
          end: 1,
          score: 1,
          title_suggestion: null,
          approved: false,
          review_required: false,
        },
      ],
    });
    render(
      <StatusBarView
        summary={summaryOf(project)}
        narrow={false}
        statusAnnouncement=""
        onOpenTab={onOpenTab}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Pending:/ }));
    expect(onOpenTab).toHaveBeenCalledWith("impact");
    await user.click(screen.getByRole("button", { name: /^Unmapped:/ }));
    expect(onOpenTab).toHaveBeenCalledWith("impact");
    await user.click(screen.getByRole("button", { name: /^Render:/ }));
    expect(onOpenTab).toHaveBeenCalledWith("pipeline");
    await user.click(screen.getByRole("button", { name: "Open comments" }));
    expect(onOpenTab).toHaveBeenCalledWith("comments");
  });

  it("hides the unmapped, social and cut items when empty", () => {
    render(
      <StatusBarView
        summary={summaryOf(minimalProject())}
        narrow={false}
        statusAnnouncement=""
        onOpenTab={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^Unmapped:/)).toBeNull();
    expect(screen.queryByText(/^Social:/)).toBeNull();
    expect(screen.queryByText(/^Cut /)).toBeNull();
  });

  it("shows a stale render, needs-sync copy and the highlight class", () => {
    const project = minimalProject({
      tracks: [sampleTrack()],
      render_status: {
        needs_rerender: false,
        reconciliation: { stale: true },
        premix: { exists: false },
        invalidations: [],
      },
    });
    render(
      <StatusBarView
        summary={summaryOf(project)}
        narrow={false}
        reconcileHighlight
        statusAnnouncement=""
        onOpenTab={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Render: stale" })).toBeTruthy();
    const notice = screen.getByText("Transcript: needs sync");
    expect(notice.className).toContain("stale-highlight");
  });

  it("adds status-bar-secondary classes when narrow", () => {
    const project = minimalProject({
      tracks: [sampleTrack({ duration_sec: 120 })],
      timeline_duration_sec: 30,
      social_clips: [
        {
          id: "c1",
          track_id: "host",
          start: 0,
          end: 1,
          score: 1,
          title_suggestion: null,
          approved: false,
          review_required: false,
        },
      ],
    });
    render(
      <StatusBarView
        summary={summaryOf(project)}
        narrow
        statusAnnouncement=""
        onOpenTab={vi.fn()}
      />,
    );
    expect(screen.getByText(/^Social:/).className).toBe("status-bar-secondary");
    expect(
      screen.getByRole("button", { name: "Open comments" }).className,
    ).toContain("status-bar-secondary");
  });

  it("renders the job chip as a button only when onJobClick is passed", () => {
    const job = pipelineJobSnapshot();
    const { rerender } = render(
      <StatusBarView
        summary={summaryOf(minimalProject())}
        narrow={false}
        job={job}
        statusAnnouncement=""
        onOpenTab={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Pipeline:/ })).toBeNull();

    rerender(
      <StatusBarView
        summary={summaryOf(minimalProject())}
        narrow={false}
        job={job}
        onJobClick={vi.fn()}
        statusAnnouncement=""
        onOpenTab={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Pipeline:/ })).toBeTruthy();
  });

  it("renders a PresenceStatusView block via the presence slot", () => {
    render(
      <StatusBarView
        summary={summaryOf(minimalProject())}
        narrow
        presence={<span title="Ada (viewer)">Presence: You + 1 guest</span>}
        statusAnnouncement=""
        onOpenTab={vi.fn()}
      />,
    );
    expect(screen.getByText("Presence: You + 1 guest")).toBeTruthy();
    expect(screen.getByTitle("Ada (viewer)")).toBeTruthy();
  });
});
