import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { PendingEditView } from "../../types/project";
import { EmptyInspector } from "./EmptyInspector";

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
    useDawStore.getState().hydrate("/tmp/p.json", project());
  });

  it("shows the idle hint and creates no edits, for a host with a dialogue track", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <EmptyInspector unmappable={[]} onSelectPending={() => {}} />
      </DawProvider>,
    );
    expect(
      screen.getByText(
        "Click a clip, edit, track header, chapter marker, or Levels envelope point.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Suggest cut" }),
    ).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
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
