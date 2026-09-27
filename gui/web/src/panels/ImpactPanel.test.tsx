import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveEdits, waiveTranscriptRefine } from "../api";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { appliedEditRecord, clipRow, minimalProject } from "../test/fixtures";
import { ApiError, TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { ImpactPanel } from "./ImpactPanel";

const { loadHostCommandCount } = vi.hoisted(() => ({
  loadHostCommandCount: vi.fn(async () => 1),
}));

vi.mock("../state/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/offlineStore")>()),
  loadHostCommandCount,
}));

vi.mock("../api", () => ({
  approveEdits: vi.fn(async () => ({ queued: false })),
  rejectEdits: vi.fn(async () => ({ queued: false })),
  waiveTranscriptRefine: vi.fn(),
}));

const blocked =
  "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine.";

function project() {
  return minimalProject({
    pending_edits: [
      {
        id: "e1",
        track_id: "host",
        type: "remove",
        reason: "filler:um",
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
      total_removed_sec: 1,
      by_track_sec: { host: 1 },
    },
  });
}

describe("ImpactPanel transcript refine recovery", () => {
  beforeEach(() => {
    loadHostCommandCount.mockReset().mockResolvedValue(1);
    vi.mocked(approveEdits).mockReset().mockResolvedValue({ queued: false });
    vi.mocked(waiveTranscriptRefine).mockReset();
    useDawStore.getState().hydrate("/tmp/p.json", project());
    useDawStore.setState({ guestMode: null, shareCapabilities: [] });
  });

  it("marks each pending edit row with its id", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <ImpactPanel />
      </DawProvider>,
    );
    expect(
      screen.getByRole("button", { name: /filler:um · host/ }),
    ).toHaveAttribute("data-pending-id", "e1");
  });

  it("says a bulk approval that is still sending is not done yet", async () => {
    const user = userEvent.setup();
    vi.mocked(approveEdits).mockResolvedValue({ queued: true });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Still sending/,
    );
  });

  it("clears Still sending once the queued approval leaves the queue", async () => {
    const user = userEvent.setup();
    vi.mocked(approveEdits).mockResolvedValue({ queued: true });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Still sending/,
    );
    loadHostCommandCount.mockResolvedValue(0);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), {
      timeout: 3000,
    });
  });

  it("offers a waiver after bulk approval is blocked without retrying approval", async () => {
    const user = userEvent.setup();
    vi.mocked(approveEdits).mockRejectedValue(
      new ApiError(blocked, TRANSCRIPT_REFINE_REQUIRED_CODE),
    );
    vi.mocked(waiveTranscriptRefine).mockResolvedValue();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(
      await screen.findByRole("button", { name: "Waive with reason" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Review the transcript or waive with a reason below/),
    ).toBeInTheDocument();
    expect(screen.queryByText(blocked)).toBeNull();
    await expectNoA11yViolations(container);
    await user.type(
      screen.getByRole("textbox", { name: "Waiver reason" }),
      "Reviewed",
    );
    await user.click(screen.getByRole("button", { name: "Waive with reason" }));
    expect(waiveTranscriptRefine).toHaveBeenCalledWith(
      "/tmp/p.json",
      "Reviewed",
    );
    expect(approveEdits).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Waive with reason" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Retry approval/);
    await expectNoA11yViolations(container);
  });

  it("does not show host waiver recovery for share guests", async () => {
    const user = userEvent.setup();
    vi.mocked(approveEdits).mockRejectedValue(new Error(blocked));
    useDawStore
      .getState()
      .hydrate(shareProjectKey("tok"), project(), "suggest", ["view"]);
    render(
      <DawProvider
        projectPath={shareProjectKey("tok")}
        initialProject={project()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(await screen.findByText(blocked)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Waive with reason" }),
    ).toBeNull();
  });
});

describe("ImpactPanel applied edits", () => {
  function projectWithApplied() {
    return minimalProject({
      clips: {
        tracks: {
          host: [
            clipRow({
              id: "c1",
              track_id: "host",
              source_start: 0,
              source_end: 2,
              timeline_start: 0,
              timeline_end: 2,
            }),
            clipRow({
              id: "c2",
              track_id: "host",
              source_start: 3,
              source_end: 9,
              timeline_start: 2,
              timeline_end: 8,
            }),
          ],
        },
        clip_count: 2,
      },
      applied_edits: {
        count: 2,
        records: [
          appliedEditRecord({
            id: "mapped",
            operation: "ripple_delete",
            track_ids: ["host"],
            source_start: null,
            source_end: null,
            params: { per_track_source: { host: [2, 3] } },
          }),
          appliedEditRecord({
            id: "legacy",
            operation: "ripple_delete",
            track_ids: ["host"],
            timeline_start: 0,
            timeline_end: 1334.8,
            source_start: null,
            source_end: null,
            params: {},
          }),
        ],
      },
    });
  }

  beforeEach(() => {
    loadHostCommandCount.mockReset().mockResolvedValue(1);
    useDawStore.getState().hydrate("/tmp/p.json", projectWithApplied());
    useDawStore.setState({ guestMode: null, shareCapabilities: [] });
  });

  it("shows the applied edits count in the summary", () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={projectWithApplied()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    expect(screen.getByText("Applied edits (2)")).toBeInTheDocument();
  });

  it("marks only the unmapped record as not on timeline", () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={projectWithApplied()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    const mapped = screen.getByRole("button", {
      name: "Ripple delete: Shorten the pause · host",
    });
    expect(mapped.textContent).not.toContain("not on timeline");
    const legacy = screen.getByRole("button", {
      name: "Ripple delete: Shorten the pause · host · not on timeline",
    });
    expect(legacy).toBeInTheDocument();
  });

  it("selects the applied record on click", async () => {
    const user = userEvent.setup();
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={projectWithApplied()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Ripple delete: Shorten the pause · host",
      }),
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "applied",
      id: "mapped",
      trackId: "host",
    });
  });

  it("has no a11y violations with the applied list open", async () => {
    const { container } = render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={projectWithApplied()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    const details = container.querySelector("details.impact-applied");
    details?.setAttribute("open", "");
    await expectNoA11yViolations(container);
  });
});
