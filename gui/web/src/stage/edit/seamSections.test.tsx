import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipJoin } from "../../api";
import { hearAcross } from "../../commands/seamCommands";
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
  hearAcross: vi.fn(async () => ({ status: "ok" })),
}));

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
  vi.mocked(setClipJoin).mockReset().mockResolvedValue(undefined);
  vi.mocked(hearAcross).mockClear();
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
