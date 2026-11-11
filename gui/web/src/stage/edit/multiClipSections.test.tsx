import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipFade, setClipsFade, setClipsGain } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { inspectorHeading } from "./inspectorHeading";
import { SectionsBody } from "./SectionsBody";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  setClipFade: vi.fn(async () => null),
  setClipsFade: vi.fn(async () => null),
  setClipsGain: vi.fn(async () => null),
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
  fade_out_curve: "s",
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
  fade_in_curve: clip.fade_in_curve ?? "linear",
  fade_out_curve: clip.fade_out_curve ?? "linear",
});

beforeEach(() => {
  vi.mocked(setClipFade).mockClear();
  vi.mocked(setClipsFade).mockReset().mockResolvedValue(null);
  vi.mocked(setClipsGain).mockReset().mockResolvedValue(null);
});

describe("several clips", () => {
  it("heads the form by the clip count and lists the fades and the gain", () => {
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
      "Gain",
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

describe("several clips: gain", () => {
  const gainField = () => screen.getByRole("spinbutton", { name: "Gain" });

  it("shows the common gain, treating an absent gain as 0 dB", () => {
    open([first, second]);
    expect(gainField()).toHaveAttribute("aria-valuetext", "0.0 dB");
    cleanup();
    open([
      { ...first, gain_db: -4 },
      { ...second, gain_db: -4 },
    ]);
    expect(gainField()).toHaveAttribute("aria-valuetext", "\u22124.0 dB");
  });

  it("shows Mixed when the gains differ", () => {
    open([{ ...first, gain_db: 3 }, second]);
    expect(gainField()).toHaveAttribute("aria-valuetext", "Mixed");
  });

  it("sets every clip to the typed value in one command with each baseline", async () => {
    open([
      { ...first, gain_db: 3 },
      { ...second, gain_db: -5 },
    ]);
    await type("Gain", "-2");
    expect(setClipsGain).toHaveBeenCalledTimes(1);
    expect(setClipsGain).toHaveBeenCalledWith("/tmp/ep.json", [
      { clip_id: "c1", gain_db: -2, expected: { gain_db: 3 } },
      { clip_id: "c2", gain_db: -2, expected: { gain_db: -5 } },
    ]);
    expect(setClipFade).not.toHaveBeenCalled();
    expect(setClipsFade).not.toHaveBeenCalled();
  });

  it("leaves out a clip that already has the typed value", async () => {
    open([{ ...first, gain_db: 3 }, second]);
    await type("Gain", "3");
    expect(setClipsGain).toHaveBeenCalledWith("/tmp/ep.json", [
      { clip_id: "c2", gain_db: 3, expected: { gain_db: 0 } },
    ]);
  });

  it("sends nothing when every clip already has the typed value", async () => {
    open([
      { ...first, gain_db: 2 },
      { ...second, gain_db: 2 },
    ]);
    await key("Gain", "Enter");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Gain" }), {
      key: "Escape",
    });
    expect(setClipsGain).not.toHaveBeenCalled();
  });

  it("steps from the common value", async () => {
    open([
      { ...first, gain_db: 2 },
      { ...second, gain_db: 2 },
    ]);
    await key("Gain", "ArrowUp");
    expect(setClipsGain).toHaveBeenCalledWith("/tmp/ep.json", [
      { clip_id: "c1", gain_db: 2.5, expected: { gain_db: 2 } },
      { clip_id: "c2", gain_db: 2.5, expected: { gain_db: 2 } },
    ]);
  });

  it("resets every clip to 0 dB, including from Mixed", async () => {
    open([
      { ...first, gain_db: 3 },
      { ...second, gain_db: -5 },
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Reset Gain to 0/ }));
    });
    expect(setClipsGain).toHaveBeenCalledWith("/tmp/ep.json", [
      { clip_id: "c1", gain_db: 0, expected: { gain_db: 3 } },
      { clip_id: "c2", gain_db: 0, expected: { gain_db: -5 } },
    ]);
  });

  it("is read-only while locked", async () => {
    open();
    act(() => {
      useDawStore.setState({
        projectPath: "share:ep",
        guestMode: "viewer",
        shareCapabilities: ["view"],
      });
    });
    expect(gainField()).toHaveAttribute("aria-readonly", "true");
    await key("Gain", "ArrowUp");
    expect(setClipsGain).not.toHaveBeenCalled();
  });
});

describe("several clips: fade shape", () => {
  const group = (name: string) =>
    screen.getByRole("group", { name: new RegExp(`^${name}`) });
  const choice = (name: string, label: string) =>
    within(group(name)).getByRole("button", { name: label });
  const pressed = (name: string) =>
    within(group(name))
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");

  it("presses the common shape, linear for clips that save none", () => {
    open();
    expect(pressed("Fade in shape").map((b) => b.textContent)).toEqual([
      "Linear",
    ]);
  });

  it("reads Mixed with no button pressed when the shapes differ", () => {
    open();
    expect(pressed("Fade out shape")).toEqual([]);
    expect(
      screen.getByText("Mixed", { selector: ".fade-shape-mixed" }),
    ).toBeVisible();
    expect(group("Fade out shape")).toHaveAccessibleName(
      "Fade out shape, Mixed",
    );
  });

  it("sets the absolute shape on every clip that differs, in one command", async () => {
    open();
    await act(async () => {
      fireEvent.click(choice("Fade out shape", "S"));
    });
    expect(setClipsFade).toHaveBeenCalledTimes(1);
    expect(setClipsFade).toHaveBeenCalledWith("/tmp/ep.json", [
      {
        clip_id: "c1",
        fade_in_ms: 10,
        fade_out_ms: 20,
        fade_out_curve: "s",
        expected: baseline(first),
      },
    ]);
    expect(setClipFade).not.toHaveBeenCalled();
  });

  it("leaves out a clip at a cut or a blended edge", async () => {
    open([
      first,
      { ...second, join_left_clip_id: "c1", join_in_mode: "cut" },
      {
        ...second,
        id: "c3",
        join_left_clip_id: "c2",
        join_in_mode: "crossfade",
        join_crossfade_ms: 200,
      },
    ]);
    // c1 ends at a cut, c2 starts at one, c3 starts in a blend that also ends c2's out edge.
    await act(async () => {
      fireEvent.click(choice("Fade in shape", "Equal power"));
    });
    expect(setClipsFade).toHaveBeenCalledWith("/tmp/ep.json", [
      expect.objectContaining({ clip_id: "c1", fade_in_curve: "equal_power" }),
    ]);
  });

  it("leaves out a clip whose out edge is a cut or blended", async () => {
    open([
      first,
      { ...second, join_left_clip_id: "c1", join_in_mode: "cut" },
      {
        ...second,
        id: "c3",
        join_left_clip_id: "c2",
        join_in_mode: "crossfade",
        join_crossfade_ms: 200,
      },
    ]);
    await act(async () => {
      fireEvent.click(choice("Fade out shape", "Equal power"));
    });
    expect(setClipsFade).toHaveBeenCalledTimes(1);
    expect(setClipsFade).toHaveBeenCalledWith("/tmp/ep.json", [
      expect.objectContaining({
        clip_id: "c3",
        fade_out_curve: "equal_power",
      }),
    ]);
  });

  it("does not promise every selected clip for a shape", () => {
    open();
    expect(screen.queryByText(/every selected clip/)).toBeNull();
    expect(
      screen.getByText(/a shape skips clips whose join there is a cut/),
    ).toBeVisible();
  });

  it("disables the shape with a reason when no selected clip's edge applies", () => {
    open([
      { ...first, join_left_clip_id: "c0", join_in_mode: "cut" },
      { ...second, join_left_clip_id: "c1", join_in_mode: "cut" },
    ]);
    const button = choice("Fade in shape", "S");
    expect(button).toBeDisabled();
    const reason =
      "Shape ignored: every selected clip's join here is a cut or a crossfade";
    expect(button).toHaveAttribute("title", reason);
    expect(screen.getAllByText(reason)[0]).toBeVisible();
  });

  it("shows a Viewer the shapes as text", () => {
    open();
    act(() => {
      useDawStore.setState({
        projectPath: "share:ep",
        guestMode: "viewer",
        shareCapabilities: ["view"],
      });
    });
    expect(screen.queryByRole("group", { name: /shape/ })).toBeNull();
    expect(screen.getByText("Linear")).toBeVisible();
    expect(screen.getAllByText("Mixed").length).toBeGreaterThan(1);
  });

  it("has no axe violations", async () => {
    const { container } = open();
    await expectNoA11yViolations(container);
  });
});
