import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { suggestPendingEdit } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { PendingEditView } from "../../types/project";
import { EmptyInspector } from "./EmptyInspector";

vi.mock("../../api", () => ({
  suggestPendingEdit: vi.fn().mockResolvedValue(undefined),
}));

const suggestMock = vi.mocked(suggestPendingEdit);

function project() {
  return minimalProject({
    tracks: [sampleTrack({ id: "host", role: "dialogue" })],
    clips: {
      tracks: {
        host: [
          {
            id: "c1",
            track_id: "host",
            source_start: 0,
            source_end: 100,
            timeline_start: 0,
            timeline_end: 100,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            source_id: null,
          },
        ],
      },
      clip_count: 1,
    },
  });
}

describe("EmptyInspector", () => {
  beforeEach(() => {
    suggestMock.mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", project());
  });

  it("suggests a cut at the click-time playhead, not the render-time one", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <EmptyInspector unmappable={[]} onSelectPending={() => {}} />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({ playheadSec: 10 });
    });
    await userEvent.click(screen.getByRole("button", { name: "Suggest cut" }));
    expect(suggestMock).toHaveBeenCalledTimes(1);
    const [projectPath, trackId, start, end, reason] = suggestMock.mock
      .calls[0] as [string, string, number, number, string];
    expect(projectPath).toBe("/tmp/p.json");
    expect(trackId).toBe("host");
    expect(start).toBe(10);
    expect(end).toBeCloseTo(12);
    expect(reason).toBe("guest:suggest");
  });

  it("names the unmappable heading and dispatches its selection, and passes axe", async () => {
    const p1: PendingEditView = {
      id: "p1",
      track_id: "host",
      type: "remove",
      reason: "filler",
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
    };
    const onSelectPending = vi.fn();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <EmptyInspector unmappable={[p1]} onSelectPending={onSelectPending} />
      </DawProvider>,
    );
    expect(screen.getByText("Edits in removed audio (1)")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "remove: filler" }),
    );
    expect(onSelectPending).toHaveBeenCalledWith(p1);
    await expectNoA11yViolations(container);
  });
});
