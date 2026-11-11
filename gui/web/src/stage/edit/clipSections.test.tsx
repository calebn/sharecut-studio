import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipFade, setClipJoin } from "../../api";
import { executePointerCommand } from "../../commands/pointer";
import { rollSeam } from "../../commands/seamCommands";
import { saveClipEdge, TRIM_MODE } from "../../edit/clipEdgeSave";
import { getClipPlacement } from "../../edit/clipPlacement";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  editBoundaries,
  minimalProject,
  sampleTrack,
} from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { CLIP_READ_ONLY_REASON } from "./clipReadOnly";
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
vi.mock("../../commands/seamCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/seamCommands")>()),
  rollSeam: vi.fn(async () => ({ status: "done" }) as const),
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
      edit_boundaries: editBoundaries(clips),
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
  vi.mocked(rollSeam).mockReset().mockResolvedValue({ status: "done" });
  vi.mocked(saveClipEdge).mockClear();
  vi.mocked(executePointerCommand).mockClear();
});

/** Drag the Start field far enough to begin a placement preview. */
function previewStart() {
  const field = screen.getByRole("spinbutton", { name: "Start" });
  fireEvent.pointerDown(field, { clientX: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(field, { clientX: 110, pointerId: 1 });
  fireEvent.pointerMove(field, { clientX: 150, pointerId: 1 });
}

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

  it("sets the clip's Length and End on the timeline by trimming the out edge", async () => {
    open();
    await type("Length", "1.5");
    expect(saveClipEdge).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      clip,
      { kind: "trim", edge: "out", mode: TRIM_MODE, sourceSec: 2.5 },
      expect.any(Function),
    );
    await type("End", "1.25");
    expect(saveClipEdge).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      clip,
      { kind: "trim", edge: "out", mode: TRIM_MODE, sourceSec: 2.25 },
      expect.any(Function),
    );
  });

  it("converts End by the clip's timeline start", async () => {
    open([{ ...clip, timeline_start: 4, timeline_end: 6 }]);
    await type("End", "5.5");
    expect(saveClipEdge).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      expect.objectContaining({ id: clip.id }),
      { kind: "trim", edge: "out", mode: TRIM_MODE, sourceSec: 2.5 },
      expect.any(Function),
    );
  });

  it("lists the clip rows in the spec order", () => {
    open();
    const names = screen
      .getAllByRole("spinbutton")
      .map((field) => field.getAttribute("aria-label"));
    expect(names.slice(0, 6)).toEqual([
      "Start",
      "End",
      "Length",
      "Source start",
      "Source end",
      "Fade in",
    ]);
  });

  it("makes End and Length read-only for a clip with timing steps", () => {
    open([
      {
        ...clip,
        timeline_end: 2.5,
        timing: {
          steps: [{ at: 1, delta_sec: 0.5 }],
          method: "silence",
          micro_fade_ms: 5,
        },
      },
    ]);
    expect(screen.getByRole("spinbutton", { name: "End" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(screen.getByRole("spinbutton", { name: "Length" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(screen.getByRole("spinbutton", { name: "Length" })).toHaveAttribute(
      "aria-valuenow",
      "2.5",
    );
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

  it("tells a Viewer why the clip cannot be edited and ties the track buttons to it", () => {
    open();
    act(() => {
      useDawStore.setState({
        projectPath: "share:ep",
        guestMode: "viewer",
        shareCapabilities: ["view"],
      });
    });
    const reason = screen.getByText(CLIP_READ_ONLY_REASON);
    expect(reason).toBeVisible();
    const button = screen.getByRole("button", { name: "host" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-describedby", reason.id);
  });

  it("tells a Viewer why several selected clips cannot be edited", () => {
    open([clip, second]);
    act(() => {
      useDawStore.setState({
        selection: {
          kind: "clip",
          id: "c1",
          trackId: "host",
          ids: ["c1", "c2"],
        },
        projectPath: "share:ep",
        guestMode: "viewer",
        shareCapabilities: ["view"],
      });
    });
    expect(screen.getByText(CLIP_READ_ONLY_REASON)).toBeVisible();
  });

  it("shows an editor no read-only note", () => {
    open();
    expect(screen.queryByText(CLIP_READ_ONLY_REASON)).toBeNull();
    expect(screen.getByRole("button", { name: "host" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("refuses a source edge outside the minimum-span bounds", async () => {
    open();
    await type("Source start", "5");
    expect(saveClipEdge).not.toHaveBeenCalled();
  });

  it("keeps a pending placement when a trim is refused", async () => {
    open();
    previewStart();
    await type("Source start", "5");
    expect(getClipPlacement().kind).toBe("preview");
  });

  it("cancels a pending placement when auto reduction opens", () => {
    open();
    previewStart();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect automatic audio reduction" }),
    );
    expect(getClipPlacement()).toEqual({ kind: "idle" });
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

  it("shows the server's timing summary as read-only text, with no axe violations", async () => {
    const { container } = open([
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
    await expectNoA11yViolations(container);
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

  it("refuses a typed fraction for a fade without saving", async () => {
    open();
    await type("Fade in", "1.5");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Fade in" }), {
      key: "Escape",
    });
    await type("Fade in", "0.4");
    expect(setClipFade).not.toHaveBeenCalled();
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
    previewStart();
    expect(getClipPlacement().kind).toBe("preview");
    await key("Fade in", "ArrowUp");
    expect(getClipPlacement()).toEqual({ kind: "idle" });
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

describe("clip join rows", () => {
  const third: ClipRow = {
    ...second,
    id: "c3",
    source_start: 5,
    source_end: 7,
    timeline_start: 4,
    timeline_end: 6,
    join_left_clip_id: "c2",
  };
  const group = (name: string) => within(screen.getByRole("group", { name }));

  it("gives a track's first clip only its end join", () => {
    open([clip, second]);
    expect(screen.queryByRole("group", { name: "Start join" })).toBeNull();
    expect(screen.getByRole("group", { name: "End join" })).toBeVisible();
    expect(
      screen.getByRole("spinbutton", { name: "End join length" }),
    ).toBeVisible();
    expect(
      screen.getByRole("spinbutton", { name: "End join offset" }),
    ).toBeVisible();
  });

  it("gives a track's last clip only its start join", () => {
    open([clip, second], {}, second);
    expect(screen.queryByRole("group", { name: "End join" })).toBeNull();
    expect(screen.getByRole("group", { name: "Start join" })).toBeVisible();
  });

  it("shows both joins of a middle clip, each with its own type, length and offset", () => {
    open([clip, second, third], {}, second);
    for (const side of ["Start join", "End join"]) {
      expect(screen.getByRole("group", { name: side })).toBeVisible();
      expect(
        screen.getByRole("spinbutton", { name: `${side} length` }),
      ).toBeVisible();
      expect(
        screen.getByRole("spinbutton", { name: `${side} offset` }),
      ).toBeVisible();
    }
  });

  it("offers Hard edge, Fade and Crossfade with the clip's type pressed", () => {
    open([clip, second], {}, second);
    const start = group("Start join");
    expect(start.getByRole("button", { name: "Fade" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(start.getByRole("button", { name: "Hard edge" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(start.getByRole("button", { name: "Crossfade" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("sets the type of the join into the clip at the length it holds", async () => {
    open([clip, second], {}, second);
    await act(async () => {
      fireEvent.click(
        group("Start join").getByRole("button", { name: "Crossfade" }),
      );
    });
    expect(setClipJoin).toHaveBeenCalledTimes(1);
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "crossfade",
      20,
    );
  });

  it("sets the type of the join out of the clip on the next clip", async () => {
    open([clip, second]);
    await act(async () => {
      fireEvent.click(
        group("End join").getByRole("button", { name: "Hard edge" }),
      );
    });
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "cut",
      null,
    );
  });

  it("leaves Crossfade out where the next clip has no room or fade to overlap", () => {
    open(
      [clip, { ...second, join_crossfade_blocked: "no_fade_in" }],
      {},
      second,
    );
    expect(
      group("Start join").queryByRole("button", { name: "Crossfade" }),
    ).toBeNull();
  });

  it("shows the join type as text and the fields read-only without edit access", () => {
    useDawStore.getState().hydrate(
      "share:tok",
      minimalProject({
        tracks: [sampleTrack({ id: "host", speaker: "Mira" })],
        clips: { tracks: { host: [clip, second] }, clip_count: 2 },
        edit_boundaries: editBoundaries([clip, second]),
      }),
    );
    useDawStore.setState({
      selection: { kind: "clip", id: "c2", trackId: "host" },
      shareCapabilities: [],
    });
    render(<SectionsBody withRange={false} />);
    expect(screen.queryByRole("group", { name: "Start join" })).toBeNull();
    expect(screen.getByText("Fade")).toBeVisible();
    expect(
      screen.getByRole("spinbutton", { name: "Start join offset" }),
    ).toHaveAttribute("aria-readonly", "true");
  });

  it("shows type, Length and Offset for touching clips from different recordings", () => {
    const other = { ...second, source_id: "take-2", recording_key: "take-2" };
    open(
      [{ ...clip, source_id: "take-1", recording_key: "take-1" }, other],
      {},
      other,
    );
    expect(
      group("Start join").getByRole("button", { name: "Fade" }),
    ).toBeVisible();
    expect(
      screen.getByRole("spinbutton", { name: "Start join length" }),
    ).toBeVisible();
    expect(
      screen.getByRole("spinbutton", { name: "Start join offset" }),
    ).toBeVisible();
  });

  it("shows no join rows where a gap separates the neighbours", () => {
    const apart = { ...second, timeline_start: 3, timeline_end: 5 };
    open([clip, apart], {}, apart);
    expect(screen.queryByRole("group", { name: "Start join" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /join/ })).toBeNull();
  });

  it("shows the applied length with its value and text", () => {
    const applied = { ...second, fade_in_ms: 120 };
    open([{ ...clip, fade_out_ms: 80 }, applied], {}, applied);
    const field = screen.getByRole("spinbutton", {
      name: "Start join length",
    });
    expect(field).toHaveAttribute("aria-valuenow", "120");
    expect(field).toHaveAttribute("aria-valuetext", "120 ms");
  });

  it("applies a typed length once to the current type", async () => {
    open([clip, second], {}, second);
    await type("Start join length", "120");
    expect(setClipJoin).toHaveBeenCalledTimes(1);
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "fade",
      120,
    );
  });

  it("shows the new length after it is applied", async () => {
    open([clip, second], {}, second);
    await type("Start join length", "120");
    act(() => {
      const lane = [
        { ...clip, fade_out_ms: 120 },
        { ...second, fade_in_ms: 120 },
      ];
      useDawStore.getState().hydrate(
        "/tmp/ep.json",
        minimalProject({
          tracks: [sampleTrack({ id: "host", speaker: "Mira" })],
          clips: { tracks: { host: lane }, clip_count: 2 },
          edit_boundaries: editBoundaries(lane),
        }),
      );
    });
    expect(
      screen.getByRole("spinbutton", { name: "Start join length" }),
    ).toHaveAttribute("aria-valuenow", "120");
  });

  it("steps the applied length from its current value and jumps to the bounds", async () => {
    const applied = { ...second, fade_in_ms: 120 };
    open([clip, applied], {}, applied);
    await key("Start join length", "ArrowUp");
    expect(setClipJoin).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "fade",
      121,
    );
    await key("Start join length", "Home");
    expect(setClipJoin).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "fade",
      0,
    );
  });

  it.each([
    ["a fractional", "1.5"],
    ["a negative", "-5"],
    ["a zero", "0"],
  ])(
    "refuses %s crossfade length without calling the server",
    async (_name, text) => {
      const crossfade = { ...second, join_in_mode: "crossfade" as const };
      open([clip, crossfade], {}, crossfade);
      await type("Start join length", text);
      expect(setClipJoin).not.toHaveBeenCalled();
    },
  );

  it("has no length at a hard edge but keeps the type and offset", () => {
    const cut = { ...second, join_in_mode: "cut" as const };
    open([clip, cut], {}, cut);
    expect(
      screen.queryByRole("spinbutton", { name: "Start join length" }),
    ).toBeNull();
    expect(
      group("Start join").getByRole("button", { name: "Hard edge" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("spinbutton", { name: "Start join offset" }),
    ).toBeVisible();
  });

  it("rolls the join into the clip once with the typed offset from where it opened", async () => {
    open([clip, second], {}, second);
    await type("Start join offset", "5");
    expect(rollSeam).toHaveBeenCalledTimes(1);
    const [snapshot, deltaMs] = vi.mocked(rollSeam).mock.calls[0] ?? [];
    expect(snapshot?.id).toBe("eb:c1:c2");
    expect(deltaMs).toBeCloseTo(5, 9);
  });

  it("rolls the join out of the clip as the same seam", async () => {
    open([clip, second]);
    await type("End join offset", "-4");
    const [snapshot, deltaMs] = vi.mocked(rollSeam).mock.calls[0] ?? [];
    expect(snapshot?.id).toBe("eb:c1:c2");
    expect(deltaMs).toBeCloseTo(-4, 9);
  });

  it("shows a refused roll in the sheet", async () => {
    vi.mocked(rollSeam).mockResolvedValueOnce({
      status: "failed",
      message: "The seam moved before the roll saved. Nothing changed.",
    });
    open([clip, second]);
    await type("End join offset", "5");
    expect(
      screen.getByText(
        "The seam moved before the roll saved. Nothing changed.",
      ),
    ).toBeVisible();
  });

  it("cancels a pending placement when a join is edited", async () => {
    open([clip, second], {}, second);
    previewStart();
    expect(getClipPlacement().kind).toBe("preview");
    await type("Start join length", "120");
    expect(getClipPlacement()).toEqual({ kind: "idle" });
  });

  it("locks the join controls and the trim and fade fields while a join saves", () => {
    open([clip, second], {}, second);
    act(() => useDawStore.setState({ joinMutationInFlight: true }));
    expect(
      screen.getByRole("spinbutton", { name: "Start join length" }),
    ).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("spinbutton", { name: "Fade in" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(
      group("Start join").getByRole("button", { name: "Hard edge" }),
    ).toBeDisabled();
  });

  it("disables the join controls while a clip save is running", async () => {
    let finish: (value: { undo: null }) => void = () => {};
    vi.mocked(saveClipEdge).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    open([clip, second], {}, second);
    await key("Source start", "ArrowUp");
    expect(
      group("Start join").getByRole("button", { name: "Hard edge" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("spinbutton", { name: "Start join length" }),
    ).toHaveAttribute("aria-readonly", "true");
    await act(async () => finish({ undo: null }));
  });

  it("disables Ripple delete and the auto reduction button while a join saves", () => {
    open([clip, second], {}, second);
    act(() => useDawStore.setState({ joinMutationInFlight: true }));
    expect(
      screen.getByRole("button", { name: "Ripple delete" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Inspect automatic audio reduction" }),
    ).toBeDisabled();
  });

  it("clears a join refusal when the clip's own fade changes", async () => {
    vi.mocked(rollSeam).mockResolvedValueOnce({
      status: "failed",
      message: "The seam moved before the roll saved. Nothing changed.",
    });
    open([clip, second], {}, second);
    await type("Start join offset", "5");
    expect(screen.getByText(/The seam moved/)).toBeVisible();
    act(() => {
      const lane = [clip, { ...second, fade_in_ms: 40 }];
      useDawStore.getState().hydrate(
        "/tmp/ep.json",
        minimalProject({
          tracks: [sampleTrack({ id: "host", speaker: "Mira" })],
          clips: { tracks: { host: lane }, clip_count: 2 },
          edit_boundaries: editBoundaries(lane),
        }),
      );
    });
    expect(screen.queryByText(/The seam moved/)).toBeNull();
  });

  it("shows a refused join type in the sheet", async () => {
    vi.mocked(setClipJoin).mockRejectedValueOnce(new Error("Join refused"));
    open([clip, second], {}, second);
    await act(async () => {
      fireEvent.click(
        group("Start join").getByRole("button", { name: "Hard edge" }),
      );
    });
    expect(screen.getByText("Join refused")).toBeVisible();
  });

  it("shows the same refusal on both joins without a duplicate row key", async () => {
    const failed = {
      status: "failed",
      message: "The seam moved before the roll saved. Nothing changed.",
    } as const;
    vi.mocked(rollSeam).mockResolvedValue(failed);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    open([clip, second, third], {}, second);
    await type("Start join offset", "5");
    await type("End join offset", "5");
    expect(screen.getAllByText(failed.message)).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("clears the crossfade draft of each join when its drag ends", async () => {
    const mid = { ...second, join_in_mode: "crossfade" as const };
    const last = { ...third, join_in_mode: "crossfade" as const };
    open([clip, mid, last], {}, mid);
    for (const [name, rightId] of [
      ["Start join length", "c2"],
      ["End join length", "c3"],
    ] as const) {
      const field = screen.getByRole("spinbutton", { name });
      fireEvent.pointerDown(field, { clientX: 100, pointerId: 1, button: 0 });
      fireEvent.pointerMove(field, { clientX: 110, pointerId: 1 });
      fireEvent.pointerMove(field, { clientX: 130, pointerId: 1 });
      expect(useDawStore.getState().joinDraft?.id).toBe(rightId);
      await act(async () => {
        fireEvent.pointerUp(field, { clientX: 130, pointerId: 1 });
      });
      expect(useDawStore.getState().joinDraft).toBeNull();
    }
  });

  it("keeps a trim of the clip's source end out of the End join offset", () => {
    open([clip, second]);
    const offset = () =>
      screen.getByRole("spinbutton", { name: "End join offset" });
    expect(offset()).toHaveAttribute("aria-valuenow", "0");
    act(() => {
      const lane = [{ ...clip, source_end: 2.5 }, second];
      useDawStore.getState().hydrate(
        "/tmp/ep.json",
        minimalProject({
          tracks: [sampleTrack({ id: "host", speaker: "Mira" })],
          clips: { tracks: { host: lane }, clip_count: 2 },
          edit_boundaries: editBoundaries(lane),
        }),
      );
    });
    expect(offset()).toHaveAttribute("aria-valuenow", "0");
  });

  it("has no axe violations with both joins showing", async () => {
    const { container } = open([clip, second, third], {}, second);
    await expectNoA11yViolations(container);
  });
});
