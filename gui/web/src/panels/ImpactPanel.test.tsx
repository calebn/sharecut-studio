import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveEdits, waiveTranscriptRefine } from "../api";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { ApiError, TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { ImpactPanel } from "./ImpactPanel";

vi.mock("../api", () => ({
  approveEdits: vi.fn(),
  rejectEdits: vi.fn(),
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
    vi.mocked(approveEdits).mockReset();
    vi.mocked(waiveTranscriptRefine).mockReset();
    useDawStore.getState().hydrate("/tmp/p.json", project());
    useDawStore.setState({ guestMode: null, shareCapabilities: [] });
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
