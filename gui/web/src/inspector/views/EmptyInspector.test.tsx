import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { suggestPendingEdit } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { minimalProject, sampleTrack } from "../../test/fixtures";
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
});
