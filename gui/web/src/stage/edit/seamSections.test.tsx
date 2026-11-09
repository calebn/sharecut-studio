import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipJoin } from "../../api";
import { rollSeam } from "../../commands/seamCommands";
import { useDawStore } from "../../state/dawStore";
import { inspectKeyOf } from "../../state/selection";
import {
  appliedEditRecord,
  clipRow,
  editBoundaries,
  minimalProject,
  sampleTrack,
} from "../../test/fixtures";
import type { ClipRow, Selection } from "../../types/project";
import { SectionsBody } from "./SectionsBody";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  setClipJoin: vi.fn(async () => undefined),
}));
vi.mock("../../commands/seamCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/seamCommands")>()),
  rollSeam: vi.fn(async () => ({ status: "done" }) as const),
}));
const hearAcross = vi.hoisted(() => vi.fn());
vi.mock("../../utils/playRange", () => ({ playTimelineRange: hearAcross }));

const left: ClipRow = clipRow({
  id: "c1",
  track_id: "host",
  source_start: 1,
  source_end: 3,
  timeline_start: 0,
  timeline_end: 2,
  fade_out_ms: 100,
});

function right(overrides: Partial<ClipRow> = {}): ClipRow {
  return clipRow({
    id: "c2",
    track_id: "host",
    source_start: 5,
    source_end: 7,
    timeline_start: 2,
    timeline_end: 4,
    fade_in_ms: 100,
    join_left_clip_id: "c1",
    ...overrides,
  });
}

const SEAM: Selection = { kind: "seam", id: "eb:c1:c2", trackId: "host" };

function open(second: ClipRow = right(), withCut = true) {
  const lane = [left, second];
  useDawStore.getState().hydrate(
    "/tmp/ep.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host", speaker: "Mira" })],
      clips: { tracks: { host: lane }, clip_count: 2 },
      applied_edits: {
        count: withCut ? 1 : 0,
        records: withCut
          ? [
              appliedEditRecord({
                track_ids: ["host"],
                source_start: 3,
                source_end: 5,
                reason: "filler",
                applied_at: new Date(Date.now() - 3 * 60_000).toISOString(),
                restore: { state: "ready" },
              }),
            ]
          : [],
      },
      edit_boundaries: editBoundaries(lane),
    }),
  );
  useDawStore.setState({
    selection: SEAM,
    inspectorKey: inspectKeyOf(SEAM),
    joinMutationInFlight: false,
    isPlaying: false,
    joinDraft: null,
  });
  return render(<SectionsBody withRange={false} />);
}

const field = () => screen.getByRole("spinbutton", { name: "Length" });

const typeLength = async (text: string) => {
  await act(async () => {
    fireEvent.keyDown(field(), { key: "Enter" });
  });
  const input = screen.getByRole("textbox", { name: "Length" });
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
};

const drag = (pixels: number) => {
  fireEvent.pointerDown(field(), { clientX: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(field(), { clientX: 110, pointerId: 1 });
  fireEvent.pointerMove(field(), { clientX: 110 + pixels, pointerId: 1 });
};

beforeEach(() => {
  vi.mocked(rollSeam).mockReset().mockResolvedValue({ status: "done" });
  vi.mocked(setClipJoin).mockReset().mockResolvedValue(undefined);
  hearAcross.mockClear();
});

describe("seam sheet", () => {
  it("names the cut and who applied it", () => {
    open();
    expect(screen.getByText(/2\.0 s cut · filler/)).toBeTruthy();
    expect(screen.getByText(/applied 3 min ago/)).toBeTruthy();
  });

  it("says nothing was applied on a split", () => {
    open(right({ source_start: 3, source_end: 5 }), false);
    expect(screen.getByText(/Split at/)).toBeTruthy();
    expect(screen.queryByText(/applied/)).toBeNull();
  });

  it("hides the length for a hard edge", () => {
    open(right({ join_in_mode: "cut" }));
    expect(screen.queryByRole("spinbutton", { name: "Length" })).toBeNull();
  });

  it("offers a length from zero up to 500 ms for a fade", () => {
    open(right({ join_in_mode: "fade" }));
    expect(field()).toHaveAttribute("aria-valuemin", "0");
    expect(Number(field().getAttribute("aria-valuemax"))).toBeLessThanOrEqual(
      500,
    );
  });

  it("starts a crossfade at 1 ms", () => {
    open(right({ join_in_mode: "crossfade", join_crossfade_ms: 50 }));
    expect(field()).toHaveAttribute("aria-valuemin", "1");
  });

  it("commits a typed length once, with the seam's join mode", async () => {
    open(right({ join_in_mode: "fade" }));
    await typeLength("120");
    expect(setClipJoin).toHaveBeenCalledTimes(1);
    expect(setClipJoin).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "fade",
      120,
    );
  });

  it("shows a draft overlap while a crossfade length is dragged, and commits on release", async () => {
    open(right({ join_in_mode: "crossfade", join_crossfade_ms: 50 }));
    drag(20);
    expect(useDawStore.getState().joinDraft?.id).toBe("c2");
    expect(setClipJoin).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.pointerUp(field(), { clientX: 130, pointerId: 1 });
    });
    expect(setClipJoin).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().joinDraft).toBeNull();
  });

  it("replays across the seam once after a successful commit", async () => {
    open(right({ join_in_mode: "fade" }));
    await typeLength("120");
    expect(hearAcross).toHaveBeenCalledTimes(1);
  });

  it("does not replay after a failed commit", async () => {
    vi.mocked(setClipJoin).mockRejectedValueOnce(new Error("nope"));
    open(right({ join_in_mode: "fade" }));
    await typeLength("120");
    expect(hearAcross).not.toHaveBeenCalled();
    expect(screen.getByText("nope")).toBeTruthy();
  });

  it("does not replay while the transport is playing", async () => {
    open(right({ join_in_mode: "fade" }));
    useDawStore.setState({ isPlaying: true });
    await typeLength("120");
    expect(setClipJoin).toHaveBeenCalledTimes(1);
    expect(hearAcross).not.toHaveBeenCalled();
  });

  it("does not replay once the sheet has closed", async () => {
    open(right({ join_in_mode: "fade" }));
    useDawStore.setState({ inspectorKey: null });
    await typeLength("120");
    expect(hearAcross).not.toHaveBeenCalled();
  });

  it("says the seam is gone when its pair no longer exists", () => {
    open();
    act(() => {
      useDawStore.setState({
        selection: { kind: "seam", id: "eb:c1:zz", trackId: "host" },
      });
    });
    expect(screen.getByText("Seam not found")).toBeTruthy();
  });
});

const rolled = (leftEnd: number) => {
  const l = clipRow({
    id: "c1",
    track_id: "host",
    source_id: "long",
    source_start: 6,
    source_end: leftEnd,
    source_duration_sec: 30,
    timeline_start: 0,
    timeline_end: leftEnd - 6,
  });
  const r = clipRow({
    id: "c2",
    track_id: "host",
    source_id: "long",
    source_start: leftEnd,
    source_end: 14,
    source_duration_sec: 30,
    timeline_start: leftEnd - 6,
    timeline_end: leftEnd - 6 + (14 - leftEnd),
    join_left_clip_id: "c1",
  });
  return [l, r];
};

function projectOf(lane: ClipRow[]) {
  return minimalProject({
    tracks: [sampleTrack({ id: "host", speaker: "Mira" })],
    clips: { tracks: { host: lane }, clip_count: lane.length },
    edit_boundaries: editBoundaries(lane),
  });
}

function openRolled(leftEnd = 10) {
  useDawStore.getState().hydrate("/tmp/ep.json", projectOf(rolled(leftEnd)));
  useDawStore.setState({
    selection: SEAM,
    inspectorKey: inspectKeyOf(SEAM),
    joinMutationInFlight: false,
    isPlaying: false,
    joinDraft: null,
    guestMode: null,
    shareCapabilities: null,
  });
  return render(<SectionsBody withRange={false} />);
}

const offset = () => screen.getByRole("spinbutton", { name: "Offset" });

const pointerDrag = (pixels: number, modifiers = {}) => {
  fireEvent.pointerDown(offset(), { clientX: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(offset(), { clientX: 110, pointerId: 1 });
  fireEvent.pointerMove(offset(), {
    clientX: 110 + pixels,
    pointerId: 1,
    ...modifiers,
  });
};

const release = async (x: number) => {
  await act(async () => {
    fireEvent.pointerUp(offset(), { clientX: x, pointerId: 1 });
  });
};

const typeOffset = async (text: string) => {
  await act(async () => {
    fireEvent.keyDown(offset(), { key: "Enter" });
  });
  const input = screen.getByRole("textbox", { name: "Offset" });
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
};

const moveStoreTo = (leftEnd: number) =>
  act(() => {
    useDawStore.setState({ project: projectOf(rolled(leftEnd)) });
  });

describe("seam sheet Offset", () => {
  it("opens at zero with the legal range around it, in ms to one decimal", () => {
    openRolled();
    expect(offset()).toHaveAttribute("aria-valuenow", "0");
    expect(offset()).toHaveAttribute("aria-valuemin", "-3950");
    expect(offset()).toHaveAttribute("aria-valuemax", "3950");
    expect(offset()).toHaveTextContent("0.0ms");
  });

  it("reads the roll since the sheet opened and keeps the legal range on the same sources", () => {
    openRolled();
    moveStoreTo(10.0123);
    expect(Number(offset().getAttribute("aria-valuenow"))).toBeCloseTo(12.3, 9);
    expect(Number(offset().getAttribute("aria-valuemin"))).toBeCloseTo(
      -3950,
      9,
    );
    expect(Number(offset().getAttribute("aria-valuemax"))).toBeCloseTo(3950, 9);
  });

  it("re-derives the range from the live interval when a neighbor closes it", () => {
    openRolled();
    const [l, r] = rolled(10.0123);
    if (!l || !r) throw new Error("no clips");
    const next = clipRow({
      id: "c3",
      track_id: "host",
      source_id: "long",
      source_start: 12,
      source_end: 13,
      timeline_start: r.timeline_end,
      timeline_end: r.timeline_end + 1,
    });
    act(() => {
      useDawStore.setState({ project: projectOf([l, r, next]) });
    });
    expect(Number(offset().getAttribute("aria-valuemin"))).toBeCloseTo(
      -3950,
      9,
    );
    expect(Number(offset().getAttribute("aria-valuemax"))).toBeCloseTo(
      12.3 + 1987.7,
      9,
    );
  });

  it("drags a pixel to a millisecond, ten with Shift, a tenth with Alt", () => {
    openRolled();
    pointerDrag(3);
    expect(offset()).toHaveAttribute("aria-valuenow", "3");
    fireEvent.pointerUp(offset(), { clientX: 113, pointerId: 1 });
    cleanup();
    openRolled();
    pointerDrag(3, { shiftKey: true });
    expect(offset()).toHaveAttribute("aria-valuenow", "30");
    cleanup();
    openRolled();
    pointerDrag(3, { altKey: true });
    expect(offset()).toHaveAttribute("aria-valuenow", "0.3");
  });

  it("rolls once on release and not at all on Escape", async () => {
    openRolled();
    pointerDrag(3);
    expect(rollSeam).not.toHaveBeenCalled();
    await release(113);
    expect(rollSeam).toHaveBeenCalledTimes(1);
    const [snapshot, deltaMs] = vi.mocked(rollSeam).mock.calls[0] ?? [];
    expect(snapshot?.id).toBe("eb:c1:c2");
    expect(deltaMs).toBeCloseTo(3, 9);

    vi.mocked(rollSeam).mockClear();
    pointerDrag(3);
    fireEvent.keyDown(offset(), { key: "Escape" });
    await release(113);
    expect(rollSeam).not.toHaveBeenCalled();
  });

  it("sends only the change from the displayed offset when a value is typed", async () => {
    openRolled();
    moveStoreTo(10.005);
    await typeOffset("12.3");
    expect(rollSeam).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rollSeam).mock.calls[0]?.[1]).toBeCloseTo(7.3, 9);
  });

  it("resets to where the seam was when the sheet opened", async () => {
    openRolled();
    moveStoreTo(10.0123);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Reset Offset to 0.0 ms" }),
      );
    });
    expect(rollSeam).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rollSeam).mock.calls[0]?.[1]).toBeCloseTo(-12.3, 9);
  });

  it("sends the geometry of the first preview when the store moves before release", async () => {
    openRolled();
    pointerDrag(3);
    moveStoreTo(10.02);
    await release(113);
    const [snapshot, deltaMs] = vi.mocked(rollSeam).mock.calls[0] ?? [];
    expect(snapshot?.left.source_end).toBe(10);
    expect(deltaMs).toBeCloseTo(3, 9);
  });

  it("says the clips do not touch and offers no Offset across a gap", () => {
    const [l, r] = rolled(10);
    if (!l || !r) throw new Error("no clips");
    useDawStore
      .getState()
      .hydrate(
        "/tmp/ep.json",
        projectOf([l, { ...r, timeline_start: 6, timeline_end: 10 }]),
      );
    useDawStore.setState({ selection: SEAM, inspectorKey: inspectKeyOf(SEAM) });
    render(<SectionsBody withRange={false} />);
    expect(screen.queryByRole("spinbutton", { name: "Offset" })).toBeNull();
    expect(screen.getByText("The clips do not touch")).toBeTruthy();
  });

  it("is read-only with a reason when the clips leave no room", () => {
    const l = clipRow({
      id: "c1",
      track_id: "host",
      source_id: "long",
      source_start: 0,
      source_end: 0.05,
      source_duration_sec: 0.05,
      timeline_start: 0,
      timeline_end: 0.05,
    });
    const r = clipRow({
      id: "c2",
      track_id: "host",
      source_id: "long",
      source_start: 0.05,
      source_end: 0.1,
      timeline_start: 0.05,
      timeline_end: 0.1,
      join_left_clip_id: "c1",
    });
    useDawStore.getState().hydrate("/tmp/ep.json", projectOf([l, r]));
    useDawStore.setState({ selection: SEAM, inspectorKey: inspectKeyOf(SEAM) });
    render(<SectionsBody withRange={false} />);
    expect(offset()).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByText("The clips leave no room to roll")).toBeTruthy();
  });

  it("is read-only for a guest without edit", () => {
    useDawStore.getState().hydrate("share:tok", projectOf(rolled(10)));
    useDawStore.setState({
      selection: SEAM,
      inspectorKey: inspectKeyOf(SEAM),
      shareCapabilities: [],
    });
    render(<SectionsBody withRange={false} />);
    expect(offset()).toHaveAttribute("aria-readonly", "true");
  });
});
