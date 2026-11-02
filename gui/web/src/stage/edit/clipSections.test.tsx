import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipFade, setClipJoin } from "../../api";
import { executePointerCommand } from "../../commands/pointer";
import { saveClipEdge, TRIM_MODE } from "../../edit/clipEdgeSave";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { inspectorHeading } from "./inspectorHeading";
import { SectionsBody } from "./SectionsBody";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  setClipFade: vi.fn(async () => null),
  setClipJoin: vi.fn(async () => undefined),
}));
vi.mock("../../edit/clipEdgeSave", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../edit/clipEdgeSave")>()),
  saveClipEdge: vi.fn(async () => ({ undo: null })),
}));
vi.mock("../../commands/pointer", () => ({
  executePointerCommand: vi.fn(async () => ({ status: "ok" })),
}));

const clip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 1,
  source_end: 3,
  timeline_start: 0,
  timeline_end: 2,
  fade_in_ms: 10,
  fade_out_ms: 20,
  join_in_mode: "fade",
  source_id: null,
  source_duration_sec: 10,
  recording_key: null,
};
const second: ClipRow = {
  ...clip,
  id: "c2",
  source_start: 3,
  source_end: 5,
  timeline_start: 2,
  timeline_end: 4,
  join_left_clip_id: "c1",
};

function open(
  clips: ClipRow[] = [clip],
  trackOverrides: Parameters<typeof sampleTrack>[0] = {},
  selected = clips[0],
  tracks = [sampleTrack({ id: "host", speaker: "Mira", ...trackOverrides })],
) {
  useDawStore.getState().hydrate(
    "/tmp/ep.json",
    minimalProject({
      tracks,
      clips: { tracks: { host: clips }, clip_count: clips.length },
    }),
  );
  useDawStore.setState({
    selection: { kind: "clip", id: selected.id, trackId: "host" },
    timelineDragging: false,
    joinMutationInFlight: false,
  });
  return render(<SectionsBody withRange={false} />);
}

const key = (name: string, k: string, init: object = {}) =>
  act(async () => {
    fireEvent.keyDown(screen.getByRole("spinbutton", { name }), {
      key: k,
      ...init,
    });
  });
const type = async (name: string, text: string) => {
  await key(name, "Enter");
  const input = screen.getByRole("textbox", { name });
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
};

beforeEach(() => {
  vi.mocked(setClipFade).mockReset().mockResolvedValue(null);
  vi.mocked(setClipJoin).mockReset().mockResolvedValue(undefined);
  vi.mocked(saveClipEdge).mockClear();
  vi.mocked(executePointerCommand).mockClear();
});

describe("clip content", () => {
  it("heads a clip by its speaker and timeline range, not its id", () => {
    open();
    expect(
      inspectorHeading(
        { kind: "clip", id: "c1", trackId: "host" },
        useDawStore.getState().project,
      ).name,
    ).toBe("Mira · 00:00.000 to 00:02.000");
  });

  it("trims a source edge with one ripple save and has no axe violations", async () => {
    const { container } = open();
    await type("Source start", "1.25");
    expect(saveClipEdge).toHaveBeenCalledTimes(1);
    expect(saveClipEdge).toHaveBeenCalledWith(
      "/tmp/ep.json",
      clip,
      { kind: "trim", edge: "in", mode: TRIM_MODE, sourceSec: 1.25 },
      expect.any(Function),
    );
    await expectNoA11yViolations(container);
  });

  it("saves nothing when a source edge is opened and left unchanged", async () => {
    open([{ ...clip, source_start: 1.2345 }]);
    await key("Source start", "Enter");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Source start" }), {
        key: "Enter",
      });
    });
    expect(saveClipEdge).not.toHaveBeenCalled();
  });

  it("shows a Viewer no fade note", () => {
    open();
    act(() => {
      useDawStore.setState({
        projectPath: "share:ep",
        guestMode: "viewer",
        shareCapabilities: ["view"],
      });
    });
    expect(screen.queryByText(/max \d+ ms/)).toBeNull();
  });

  it("refuses a source edge outside the minimum-span bounds", async () => {
    open();
    await type("Source start", "5");
    expect(saveClipEdge).not.toHaveBeenCalled();
  });

  it("keeps a pending placement when a trim is refused", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
    await type("Source start", "5");
    expect(screen.getByLabelText("Timeline start (seconds)")).toBeVisible();
  });

  it("cancels a pending placement when auto reduction opens", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect automatic audio reduction" }),
    );
    expect(screen.queryByLabelText("Timeline start (seconds)")).toBeNull();
  });

  it("shows a refused trim as an alert", async () => {
    vi.mocked(saveClipEdge).mockRejectedValueOnce(new Error("Trim refused"));
    open();
    await type("Source end", "2.5");
    expect(await screen.findByRole("alert")).toHaveTextContent("Trim refused");
  });

  it("omits the mute row when a trim left the mute outside the clip", () => {
    open([{ ...clip, mute_regions: [{ start_s: 8, end_s: 9 }] }]);
    expect(screen.queryByText("Mute regions")).toBeNull();
  });

  it("lists only the mutes the clip still plays", () => {
    open([
      {
        ...clip,
        mute_regions: [
          { start_s: 1.5, end_s: 2, gain_db: -12 },
          { start_s: 8, end_s: 9 },
        ],
      },
    ]);
    expect(screen.getByText("1.500–2.000 s (-12 dB)")).toBeVisible();
    expect(screen.queryByText(/8\.000/)).toBeNull();
  });

  it("shows the server's timing summary as read-only text, only for a timed clip", () => {
    open([
      {
        ...clip,
        timing_steps: 2,
        timing_summary: "2 corrections, largest 120 ms",
      },
    ]);
    const value = screen.getByText("2 corrections, largest 120 ms");
    expect(value).toBeVisible();
    expect(value.querySelector("button, input, select, a")).toBeNull();
    expect(screen.getByText("Timing")).toBeVisible();
  });

  it("hides the timing line for an untimed clip", () => {
    open();
    expect(screen.queryByText("Timing")).toBeNull();
  });

  it("seeks to the join and offers Ripple delete through the command bus", async () => {
    open();
    expect(screen.getByRole("button", { name: "Seek join" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ripple delete" }));
    await act(async () => {});
    expect(executePointerCommand).toHaveBeenCalledWith("edit.rippleDelete", {
      clipId: "c1",
    });
  });

  it("opens the auto reduction inspector from the clip", () => {
    open();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect automatic audio reduction" }),
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "bleedAttenuation",
      id: "c1",
      trackId: "host",
      regionKey: null,
    });
  });

  it("shows a Viewer the values read-only with no write controls", async () => {
    open();
    act(() => {
      useDawStore.setState({
        projectPath: "share:ep",
        guestMode: "viewer",
        shareCapabilities: ["view"],
      });
    });
    await key("Fade in", "ArrowUp");
    expect(setClipFade).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Ripple delete" })).toBeNull();
  });
});

describe("clip fades", () => {
  it("saves one pair and keeps the other edge", async () => {
    open();
    await key("Fade in", "ArrowUp");
    expect(setClipFade).toHaveBeenCalledTimes(1);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 11, 20, {
      fade_in_ms: 10,
      fade_out_ms: 20,
    });
  });

  it("limits a fade to the track cap", async () => {
    open([clip], { fade_max_ms: 100 });
    await key("Fade out", "End");
    expect(setClipFade).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c1",
      10,
      100,
      expect.anything(),
    );
    expect(screen.getByText("max 100 ms")).toBeVisible();
  });

  it("limits an uncapped track to the clip length less the other fade", async () => {
    open([clip], { fade_max_ms: null });
    await key("Fade in", "End");
    expect(setClipFade).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c1",
      1980,
      20,
      expect.anything(),
    );
  });

  it("ignores the fade-out when the next join is a cut", async () => {
    open([clip, { ...second, join_in_mode: "cut" }]);
    await key("Fade out", "ArrowUp");
    expect(setClipFade).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Fade out ignored: the join after this clip is a cut/),
    ).toBeVisible();
  });

  it("shows the fade cap next to the cut hint", () => {
    open([clip, { ...second, join_in_mode: "cut" }], { fade_max_ms: 100 });
    expect(
      screen.getByText(
        "Fade out ignored: the join after this clip is a cut · max 100 ms",
      ),
    ).toBeVisible();
  });

  it("waits for the clip's track before offering the fields", async () => {
    open([clip], {}, clip, []);
    expect(screen.getByText(/still loading/)).toBeVisible();
    await key("Fade in", "ArrowUp");
    expect(setClipFade).not.toHaveBeenCalled();
  });

  it("cancels a pending placement before the write", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
    expect(screen.getByLabelText("Timeline start (seconds)")).toBeVisible();
    await key("Fade in", "ArrowUp");
    expect(screen.queryByLabelText("Timeline start (seconds)")).toBeNull();
    expect(screen.getByRole("button", { name: "Move clip" })).toBeVisible();
  });

  it("announces a refusal and shows the saved value again", async () => {
    vi.mocked(setClipFade).mockRejectedValueOnce(new Error("Fade refused"));
    open();
    await key("Fade in", "ArrowUp");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Fade in not saved: Fade refused",
    );
    expect(screen.getByRole("spinbutton", { name: "Fade in" })).toHaveAttribute(
      "aria-valuenow",
      "10",
    );
  });

  it("ignores the fade at a cut join and says so", async () => {
    open(
      [clip, { ...second, join_in_mode: "cut" }],
      {},
      {
        ...second,
        join_in_mode: "cut",
      },
    );
    await key("Fade in", "ArrowUp");
    expect(setClipFade).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Fade in ignored: the join into this clip is a cut/),
    ).toBeVisible();
  });
});

describe("clip join", () => {
  it("hides the join on a track's first clip", () => {
    open();
    expect(screen.queryByLabelText("Incoming transition")).toBeNull();
  });

  it("sets the mode with the default length", async () => {
    open([clip, second], {}, second);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Incoming transition"), {
        target: { value: "crossfade" },
      });
    });
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "crossfade",
      null,
    );
  });

  it("applies a typed length once to the current mode", async () => {
    open([clip, second], {}, second);
    await type("Transition length", "120");
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "fade",
      120,
    );
  });

  it("does not commit a length from the empty field with the arrow keys", async () => {
    open([clip, second], {}, second);
    await key("Transition length", "ArrowUp");
    await key("Transition length", "Home");
    expect(setClipJoin).not.toHaveBeenCalled();
  });

  it("refuses a negative length without calling the server", async () => {
    open([clip, second], {}, second);
    await type("Transition length", "-5");
    expect(setClipJoin).not.toHaveBeenCalled();
  });

  it("refuses a zero crossfade length", async () => {
    open(
      [clip, { ...second, join_in_mode: "crossfade" }],
      {},
      {
        ...second,
        join_in_mode: "crossfade",
      },
    );
    await type("Transition length", "0");
    expect(setClipJoin).not.toHaveBeenCalled();
  });

  it("has no length at a cut join", () => {
    open(
      [clip, { ...second, join_in_mode: "cut" }],
      {},
      {
        ...second,
        join_in_mode: "cut",
      },
    );
    expect(screen.queryByLabelText("Transition length")).toBeNull();
  });
});
