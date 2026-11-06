import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipFade, setClipsFade } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { inspectorHeading } from "./inspectorHeading";
import { SectionsBody } from "./SectionsBody";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  setClipFade: vi.fn(async () => null),
  setClipsFade: vi.fn(async () => null),
}));

const first: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 2,
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
  ...first,
  id: "c2",
  source_start: 2,
  source_end: 4,
  timeline_start: 2,
  timeline_end: 4,
  fade_out_ms: 40,
};

function open(clips: ClipRow[] = [first, second], cap: number | null = 100) {
  useDawStore.getState().hydrate(
    "/tmp/ep.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host", speaker: "Mira", fade_max_ms: cap })],
      clips: { tracks: { host: clips }, clip_count: clips.length },
    }),
  );
  useDawStore.setState({
    selection: {
      kind: "clip",
      id: clips[0].id,
      trackId: "host",
      ids: clips.map((c) => c.id),
    },
  });
  return render(<SectionsBody withRange={false} />);
}

const key = (name: string, k: string) =>
  act(async () => {
    fireEvent.keyDown(screen.getByRole("spinbutton", { name }), { key: k });
  });
const type = async (name: string, text: string) => {
  await key(name, "Enter");
  const input = screen.getByRole("textbox", { name });
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
};
const baseline = (clip: ClipRow) => ({
  fade_in_ms: clip.fade_in_ms,
  fade_out_ms: clip.fade_out_ms,
});

beforeEach(() => {
  vi.mocked(setClipFade).mockClear();
  vi.mocked(setClipsFade).mockReset().mockResolvedValue(null);
});

describe("several clips", () => {
  it("heads the form by the clip count and lists only the fades", () => {
    open();
    expect(
      inspectorHeading(
        useDawStore.getState().selection,
        useDawStore.getState().project,
      ).name,
    ).toBe("2 clips");
    expect(screen.getAllByRole("spinbutton").map((f) => f.ariaLabel)).toEqual([
      "Fade in",
      "Fade out",
    ]);
  });

  it("shows the common value, or Mixed when the clips differ", () => {
    open();
    expect(screen.getByRole("spinbutton", { name: "Fade in" })).toHaveAttribute(
      "aria-valuetext",
      "10 ms",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Fade out" }),
    ).toHaveAttribute("aria-valuetext", "Mixed");
  });

  it("applies the delta to every clip in one command", async () => {
    open();
    await key("Fade in", "ArrowUp");
    await key("Fade out", "ArrowUp");
    expect(setClipsFade).toHaveBeenCalledTimes(2);
    expect(setClipsFade).toHaveBeenNthCalledWith(1, "/tmp/ep.json", [
      {
        clip_id: "c1",
        fade_in_ms: 11,
        fade_out_ms: 20,
        expected: baseline(first),
      },
      {
        clip_id: "c2",
        fade_in_ms: 11,
        fade_out_ms: 40,
        expected: baseline(second),
      },
    ]);
    expect(setClipsFade).toHaveBeenNthCalledWith(2, "/tmp/ep.json", [
      {
        clip_id: "c1",
        fade_in_ms: 10,
        fade_out_ms: 21,
        expected: baseline(first),
      },
      {
        clip_id: "c2",
        fade_in_ms: 10,
        fade_out_ms: 41,
        expected: baseline(second),
      },
    ]);
    expect(setClipFade).not.toHaveBeenCalled();
  });

  it("clamps each clip by its own limits", async () => {
    open();
    await type("Fade out", "100");
    expect(setClipsFade).toHaveBeenCalledWith("/tmp/ep.json", [
      {
        clip_id: "c1",
        fade_in_ms: 10,
        fade_out_ms: 100,
        expected: baseline(first),
      },
      {
        clip_id: "c2",
        fade_in_ms: 10,
        fade_out_ms: 100,
        expected: baseline(second),
      },
    ]);
  });

  it("leaves a clip at its limit out of the command", async () => {
    open([first, { ...second, fade_in_ms: 100 }]);
    await key("Fade in", "End");
    expect(setClipsFade).toHaveBeenCalledWith("/tmp/ep.json", [
      {
        clip_id: "c1",
        fade_in_ms: 100,
        fade_out_ms: 20,
        expected: baseline(first),
      },
    ]);
  });

  it("skips a clip whose edge is a cut", async () => {
    open([first, { ...second, join_left_clip_id: "c1", join_in_mode: "cut" }]);
    await key("Fade in", "ArrowUp");
    expect(setClipsFade).toHaveBeenCalledWith("/tmp/ep.json", [
      {
        clip_id: "c1",
        fade_in_ms: 11,
        fade_out_ms: 20,
        expected: baseline(first),
      },
    ]);
  });

  it("is read-only for a Viewer", async () => {
    open();
    act(() => {
      useDawStore.setState({
        projectPath: "share:ep",
        guestMode: "viewer",
        shareCapabilities: ["view"],
      });
    });
    await key("Fade in", "ArrowUp");
    expect(setClipsFade).not.toHaveBeenCalled();
    expect(screen.queryByText(/every selected clip/)).toBeNull();
  });

  it("shows a refused save as an alert", async () => {
    vi.mocked(setClipsFade).mockRejectedValue(new Error("This clip changed."));
    open();
    await key("Fade in", "ArrowUp");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This clip changed.",
    );
  });
});
