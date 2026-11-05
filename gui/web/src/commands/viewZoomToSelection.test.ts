import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const zoomToSpan = vi.fn();

beforeEach(() => {
  zoomToSpan.mockReset();
  clearRegisteredCommands();
  registerDawCommands();
  const base = minimalProject({ tracks: [sampleTrack()] });
  useDawStore.getState().hydrate("/tmp/p.json", {
    ...base,
    timeline_duration_sec: 600,
    clips: {
      tracks: {
        "mira-voice": [
          clipRow({ id: "c1", timeline_start: 100, timeline_end: 110 }),
        ],
      },
      clip_count: 1,
    },
  });
  useDawStore.setState({
    stage: "edit",
    zoomToSpan,
    measureTimelineViewport: () => 1000,
  });
});

describe("view.zoomToSelection", () => {
  it("fits a selected clip into 90% of the viewport", async () => {
    useDawStore.setState({
      selection: { kind: "clip", id: "c1", trackId: "mira-voice" },
    });
    expect((await execute("view.zoomToSelection")).status).toBe("ok");
    expect(zoomToSpan).toHaveBeenCalledWith(100, 110, 90);
  });

  it("clamps the zoom to the timeline's maximum", async () => {
    useDawStore.setState({
      selection: { kind: "clip", id: "c1", trackId: "mira-voice" },
      project: {
        ...useDawStore.getState().project!,
        clips: {
          tracks: {
            "mira-voice": [
              clipRow({ id: "c1", timeline_start: 100, timeline_end: 100.001 }),
            ],
          },
          clip_count: 1,
        },
      },
    });
    await execute("view.zoomToSelection");
    const zoom = zoomToSpan.mock.calls[0]![2] as number;
    expect(zoom).toBeLessThan(900 / 0.001);
    expect(zoom).toBeGreaterThan(0);
  });

  it("zooms to a range selection", async () => {
    useDawStore.setState({
      selection: {
        kind: "range",
        target: {
          intervals: [{ start: 20, end: 30 }],
          track_ids: ["mira-voice"],
        },
      } as never,
    });
    await execute("view.zoomToSelection");
    expect(zoomToSpan).toHaveBeenCalledWith(20, 30, 90);
  });

  it("says what to do with nothing selected", async () => {
    useDawStore.setState({ selection: null });
    expect(await execute("view.zoomToSelection")).toEqual({
      status: "disabled",
      reason: "Select something to zoom to",
    });
    expect(zoomToSpan).not.toHaveBeenCalled();
  });

  it("is an Edit-stage command", async () => {
    useDawStore.setState({
      stage: "deliver",
      selection: { kind: "clip", id: "c1", trackId: "mira-voice" },
    });
    expect((await execute("view.zoomToSelection")).status).toBe("disabled");
  });
});
