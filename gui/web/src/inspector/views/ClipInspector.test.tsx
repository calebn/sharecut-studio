import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipFade, setClipJoin } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { ClipInspector } from "./ClipInspector";

vi.mock("../../api", () => ({
  setClipFade: vi.fn(async () => undefined),
  setClipJoin: vi.fn(async () => undefined),
  applyFadeRecommendations: vi.fn(async () => undefined),
}));

const clip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 2,
  timeline_start: 0,
  timeline_end: 2,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
};

function hydrateClipProject(
  track: ReturnType<typeof sampleTrack>,
  savedClip: ClipRow = clip,
) {
  useDawStore.getState().hydrate(
    "/tmp/ep.json",
    minimalProject({
      tracks: [track],
      clips: { tracks: { [savedClip.track_id]: [savedClip] }, clip_count: 1 },
    }),
  );
}

async function dragFade(edge: "in" | "out", value: number) {
  const input = screen.getByLabelText(`Fade ${edge} ms`);
  fireEvent.pointerDown(input, { pointerId: 1 });
  fireEvent.change(input, { target: { value: String(value) } });
  fireEvent.pointerUp(input, { pointerId: 1 });
  await waitFor(() => expect(setClipFade).toHaveBeenCalled());
}

describe("ClipInspector presentation", () => {
  it("names the origin speaker and timeline range with the ID shown once", async () => {
    const moved = {
      ...clip,
      id: "internal-clip-id",
      track_id: "guest",
      origin_track_id: "host",
      source_start: 30,
      source_end: 36,
      timeline_start: 4,
      timeline_end: 10,
    };
    useDawStore.getState().hydrate(
      "/tmp/ep.json",
      minimalProject({
        tracks: [
          sampleTrack({ id: "guest", speaker: "Guest" }),
          sampleTrack({ id: "host", speaker: "Host" }),
        ],
        clips: { tracks: { guest: [moved] }, clip_count: 1 },
      }),
    );
    const { container } = render(<ClipInspector clip={moved} />);
    expect(
      screen.getByRole("heading", {
        name: "Host clip, 00:04.000 to 00:10.000",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("internal-clip-id")).toHaveLength(1);
    await expectNoA11yViolations(container);
  });

  it("places delete actions in a named section after constructive controls", () => {
    hydrateClipProject(sampleTrack({ speaker: "Host" }));
    const { container } = render(<ClipInspector clip={clip} />);
    const destructive = screen.getByRole("region", { name: "Delete clip" });
    expect(
      within(destructive).getByRole("button", { name: "Delete" }),
    ).toBeEnabled();
    expect(
      within(destructive).getByRole("button", { name: "Ripple delete" }),
    ).toBeEnabled();
    const buttons = [...container.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    expect(buttons).toEqual([
      "Delete",
      "Ripple delete",
      "Seek join",
      "Play across join",
    ]);
    expect(
      screen.getByLabelText("Fade in ms").compareDocumentPosition(destructive) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});

describe("ClipInspector fades", () => {
  beforeEach(() => {
    vi.mocked(setClipFade).mockReset().mockResolvedValue(undefined);
  });

  it("clamps to the dialogue track's cap and has no axe violations", async () => {
    hydrateClipProject(sampleTrack({ fade_max_ms: 40 }));
    const { container } = render(<ClipInspector clip={clip} />);
    expect(screen.getByLabelText("Fade in ms")).toHaveAttribute("max", "40");
    expect(screen.getByText("max 40 ms")).toBeInTheDocument();
    await dragFade("in", 40);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 40, 0);
    await expectNoA11yViolations(container);
  });

  it("clamps an uncapped track to the clip length", async () => {
    const shortClip = { ...clip, source_end: 0.2 };
    hydrateClipProject(
      sampleTrack({ role: "music", fade_max_ms: null }),
      shortClip,
    );
    render(<ClipInspector clip={shortClip} />);
    await dragFade("in", 200);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 200, 0);
  });

  it("previews a fade edge, commits one pair, and preserves the stationary edge", async () => {
    const shortClip = { ...clip, source_end: 0.2, fade_out_ms: 30 };
    hydrateClipProject(
      sampleTrack({ role: "music", fade_max_ms: null }),
      shortClip,
    );
    render(<ClipInspector clip={shortClip} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.pointerDown(fadeIn, { pointerId: 1 });
    fireEvent.change(fadeIn, { target: { value: "150" } });
    expect(fadeIn).toHaveValue("150");
    expect(screen.getByLabelText("Fade out ms")).toHaveValue("30");
    expect(setClipFade).not.toHaveBeenCalled();
    fireEvent.pointerUp(fadeIn, { pointerId: 1 });
    await waitFor(() => {
      expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 150, 30);
    });
  });

  it("keeps an in-flight fade owner while showing a fresh same-clip pair", async () => {
    hydrateClipProject(sampleTrack());
    let resolveSave: (() => void) | undefined;
    vi.mocked(setClipFade).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const view = render(<ClipInspector clip={clip} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.pointerDown(fadeIn, { pointerId: 1 });
    fireEvent.change(fadeIn, { target: { value: "20" } });
    fireEvent.pointerUp(fadeIn, { pointerId: 1 });
    await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(1));
    expect(fadeIn).toBeDisabled();

    const freshClip = { ...clip, fade_in_ms: 7, fade_out_ms: 4 };
    const project = useDawStore.getState().project;
    if (!project) throw new Error("expected hydrated project");
    useDawStore.setState({
      project: {
        ...project,
        clips: {
          ...project.clips,
          tracks: { ...project.clips.tracks, host: [freshClip] },
        },
      },
    });
    view.rerender(<ClipInspector clip={freshClip} />);
    expect(screen.getByLabelText("Fade in ms")).toHaveValue("7");
    expect(screen.getByLabelText("Fade out ms")).toHaveValue("4");
    expect(screen.getByLabelText("Fade in ms")).toBeDisabled();
    fireEvent.pointerDown(screen.getByLabelText("Fade out ms"), {
      pointerId: 2,
    });
    expect(setClipFade).toHaveBeenCalledTimes(1);

    await act(async () => resolveSave?.());
    await waitFor(() => {
      expect(screen.getByLabelText("Fade in ms")).toBeEnabled();
    });
    expect(screen.getByLabelText("Fade in ms")).toHaveValue("7");
  });

  it("keeps the typed value when the save fails", async () => {
    hydrateClipProject(sampleTrack({ fade_max_ms: 40 }));
    vi.mocked(setClipFade).mockRejectedValueOnce(new Error("boom"));
    render(<ClipInspector clip={clip} />);
    await dragFade("in", 40);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByLabelText("Fade in ms")).toHaveValue("0");
  });

  it("waits for the clip's track before offering Apply", () => {
    useDawStore
      .getState()
      .hydrate(
        "/tmp/ep.json",
        minimalProject({ tracks: [sampleTrack({ id: "guest" })] }),
      );
    render(<ClipInspector clip={clip} />);
    expect(screen.queryByText(/^max /)).toBeNull();
    expect(screen.getByLabelText("Fade in ms")).toBeDisabled();
  });

  it("cancels a pointer-cancelled preview and skips unchanged clicks", () => {
    hydrateClipProject(sampleTrack());
    render(<ClipInspector clip={clip} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.pointerDown(fadeIn, { pointerId: 1 });
    fireEvent.change(fadeIn, { target: { value: "20" } });
    fireEvent.pointerCancel(fadeIn, { pointerId: 1 });
    expect(fadeIn).toHaveValue("0");
    fireEvent.pointerDown(fadeIn, { pointerId: 2 });
    fireEvent.pointerUp(fadeIn, { pointerId: 2 });
    expect(setClipFade).not.toHaveBeenCalled();
  });

  it("commits a keyboard range adjustment on key release", async () => {
    hydrateClipProject(sampleTrack());
    render(<ClipInspector clip={clip} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.keyDown(fadeIn, { key: "ArrowRight" });
    fireEvent.change(fadeIn, { target: { value: "1" } });
    expect(setClipFade).not.toHaveBeenCalled();
    fireEvent.keyUp(fadeIn, { key: "ArrowRight" });
    await waitFor(() => {
      expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 1, 0);
    });
  });

  it("ignores a key release unrelated to the active range adjustment", async () => {
    hydrateClipProject(sampleTrack());
    render(<ClipInspector clip={clip} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.keyDown(fadeIn, { key: "ArrowRight" });
    fireEvent.change(fadeIn, { target: { value: "1" } });
    fireEvent.keyUp(fadeIn, { key: "Tab" });
    expect(setClipFade).not.toHaveBeenCalled();
    fireEvent.keyUp(fadeIn, { key: "ArrowRight" });
    await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(1));
  });

  it("ignores a rejected write after switching projects", async () => {
    hydrateClipProject(sampleTrack());
    let rejectSave: ((reason: Error) => void) | undefined;
    vi.mocked(setClipFade).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const view = render(<ClipInspector clip={clip} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.pointerDown(fadeIn, { pointerId: 1 });
    fireEvent.change(fadeIn, { target: { value: "20" } });
    fireEvent.pointerUp(fadeIn, { pointerId: 1 });
    await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(1));

    useDawStore
      .getState()
      .hydrate("/tmp/other.json", minimalProject({ tracks: [sampleTrack()] }));
    view.rerender(<ClipInspector clip={clip} />);
    await act(async () => rejectSave?.(new Error("old project failed")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Fade in ms")).toBeEnabled();
    expect(screen.getByLabelText("Fade in ms")).toHaveValue("0");
  });

  it("cancels a keyboard preview with Escape", () => {
    hydrateClipProject(sampleTrack());
    render(<ClipInspector clip={clip} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.keyDown(fadeIn, { key: "ArrowRight" });
    fireEvent.change(fadeIn, { target: { value: "1" } });
    fireEvent.keyDown(fadeIn, { key: "Escape" });
    expect(fadeIn).toHaveValue("0");
    expect(setClipFade).not.toHaveBeenCalled();
  });

  it("commits an ordinary blur once and ignores a completion after project switch", async () => {
    hydrateClipProject(sampleTrack());
    render(<ClipInspector clip={clip} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.pointerDown(fadeIn, { pointerId: 1 });
    fireEvent.change(fadeIn, { target: { value: "20" } });
    fireEvent.blur(fadeIn);
    fireEvent.pointerUp(fadeIn, { pointerId: 1 });
    await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(1));

    vi.mocked(setClipFade).mockClear();
    fireEvent.pointerDown(fadeIn, { pointerId: 2 });
    fireEvent.change(fadeIn, { target: { value: "30" } });
    useDawStore
      .getState()
      .hydrate("/tmp/other.json", minimalProject({ tracks: [sampleTrack()] }));
    fireEvent.pointerUp(fadeIn, { pointerId: 2 });
    expect(setClipFade).not.toHaveBeenCalled();
  });

  it("no longer offers a track-wide fade button", () => {
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [sampleTrack()] }));
    render(<ClipInspector clip={clip} />);
    expect(
      screen.queryByRole("button", {
        name: /recommended fades|smooth all joins/i,
      }),
    ).toBeNull();
  });

  it("uses the track speaker as the clip inspector identity", () => {
    hydrateClipProject(sampleTrack({ label: "Host track", speaker: "Avery" }));
    render(<ClipInspector clip={clip} />);
    expect(
      screen.getByRole("heading", {
        name: "Avery clip, 00:00.000 to 00:02.000",
      }),
    ).toBeVisible();
  });
});

describe("ClipInspector join", () => {
  const second: ClipRow = {
    ...clip,
    id: "c2",
    timeline_start: 2,
    timeline_end: 4,
    join_left_clip_id: "c1",
    join_render_mode: "fade",
    join_crossfade_ms: 0,
    join_crossfade_blocked: null,
  };
  const cutAfterSecond: ClipRow = {
    ...second,
    id: "c3",
    timeline_start: 4,
    timeline_end: 6,
    join_left_clip_id: "c2",
    join_in_mode: "cut",
  };
  function hydrateCutAfter(trackFadeMax: number | null, left: ClipRow) {
    useDawStore.getState().hydrate(
      "/tmp/ep.json",
      minimalProject({
        tracks: [sampleTrack({ role: "music", fade_max_ms: trackFadeMax })],
        clips: {
          tracks: { host: [clip, left, cutAfterSecond] },
          clip_count: 3,
        },
      }),
    );
  }

  beforeEach(() => {
    vi.mocked(setClipJoin).mockClear();
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [sampleTrack()] }));
  });

  it("hides the join control on a track's first clip", () => {
    render(<ClipInspector clip={{ ...clip, join_left_clip_id: null }} />);
    expect(screen.queryByLabelText("Incoming transition")).toBeNull();
  });

  it("sets mode and fades together with the typed length", async () => {
    const user = userEvent.setup();
    const { container } = render(<ClipInspector clip={second} />);
    expect(
      screen.getByRole("button", { name: "Apply transition length" }),
    ).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText("Incoming transition"),
      "Crossfade (overlap both clips)",
    );
    expect(setClipJoin).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "crossfade",
      null,
    );
    await user.type(screen.getByLabelText("Transition length ms"), "30");
    await user.click(
      screen.getByRole("button", { name: "Apply transition length" }),
    );
    expect(setClipJoin).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "fade",
      30,
    );
    expect(
      screen.getByRole("button", { name: "Apply transition length" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Seek join" }).className,
    ).not.toMatch(/link/);
    await expectNoA11yViolations(container);
  });

  it("blocks other clip mutations until a fade save settles", async () => {
    const user = userEvent.setup();
    hydrateCutAfter(null, second);
    let resolveSave: (() => void) | undefined;
    vi.mocked(setClipFade).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<ClipInspector clip={second} />);
    await user.type(screen.getByLabelText("Transition length ms"), "25");
    const fadeIn = screen.getByLabelText("Fade in ms");
    fireEvent.pointerDown(fadeIn, { pointerId: 1 });
    fireEvent.change(fadeIn, { target: { value: "1" } });
    fireEvent.pointerUp(fadeIn, { pointerId: 1 });
    await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(1));

    expect(screen.getByLabelText("Incoming transition")).toBeDisabled();
    expect(screen.getByLabelText("Transition length ms")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Apply transition length" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Ripple delete" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Incoming transition"), {
      target: { value: "crossfade" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply transition length" }),
    );
    expect(setClipJoin).not.toHaveBeenCalled();

    await act(async () => resolveSave?.());
    await waitFor(() => {
      expect(screen.getByLabelText("Incoming transition")).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("rejects a zero crossfade length without calling the server", async () => {
    const user = userEvent.setup();
    render(<ClipInspector clip={{ ...second, join_in_mode: "crossfade" }} />);
    expect(screen.getByLabelText("Transition length ms")).toHaveAttribute(
      "min",
      "1",
    );
    await user.type(screen.getByLabelText("Transition length ms"), "0");
    await user.click(
      screen.getByRole("button", { name: "Apply transition length" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 1 ms");
    expect(setClipJoin).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Transition length ms")).toHaveValue(null);
  });

  it("rejects a typed 0 when switching to crossfade", async () => {
    const user = userEvent.setup();
    render(<ClipInspector clip={second} />);
    await user.type(screen.getByLabelText("Transition length ms"), "0");
    await user.selectOptions(
      screen.getByLabelText("Incoming transition"),
      "Crossfade (overlap both clips)",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 1 ms");
    expect(setClipJoin).not.toHaveBeenCalled();
  });

  it("says why a crossfade will not blend", () => {
    render(
      <ClipInspector
        clip={{
          ...second,
          join_in_mode: "crossfade",
          join_crossfade_blocked: "no_fade_in",
        }}
      />,
    );
    expect(screen.getByText(/no fade-in/)).toBeInTheDocument();
  });

  it("disables only the fade at a cut join", () => {
    render(<ClipInspector clip={{ ...second, join_in_mode: "cut" }} />);
    expect(screen.getByLabelText("Fade in ms")).toBeDisabled();
    expect(screen.getByLabelText("Fade out ms")).toBeEnabled();
    expect(screen.getByText(/Fade in ignored/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Transition length ms")).toBeNull();
    expect(screen.getByText(/hard cut/)).toBeInTheDocument();
  });

  it("keeps a first clip's fade-in editable when its leftover mode is cut", () => {
    render(
      <ClipInspector
        clip={{
          ...clip,
          join_left_clip_id: null,
          join_in_mode: "cut",
          fade_in_ms: 20,
        }}
      />,
    );
    expect(screen.getByLabelText("Fade in ms")).toBeEnabled();
    expect(screen.queryByText(/Fade in ignored/)).toBeNull();
    expect(screen.queryByLabelText("Incoming transition")).toBeNull();
  });

  it("disables the fade-out when the next join is a cut", () => {
    const third: ClipRow = {
      ...second,
      id: "c3",
      timeline_start: 4,
      timeline_end: 6,
      join_left_clip_id: "c2",
      join_in_mode: "cut",
    };
    useDawStore.getState().hydrate(
      "/tmp/ep.json",
      minimalProject({
        tracks: [sampleTrack()],
        clips: { tracks: { host: [clip, second, third] }, clip_count: 3 },
      }),
    );
    render(<ClipInspector clip={second} />);
    expect(screen.getByLabelText("Fade in ms")).toBeEnabled();
    expect(screen.getByLabelText("Fade out ms")).toBeDisabled();
    expect(screen.getByText(/Fade out ignored/)).toBeInTheDocument();
  });

  it("shows the fade cap next to the cut hint", async () => {
    hydrateCutAfter(40, second);
    render(<ClipInspector clip={second} />);
    expect(
      screen.getByText(/Fade out ignored.* · max 40 ms/),
    ).toBeInTheDocument();
    await dragFade("in", 40);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c2", 40, 0);
  });

  it("sends the ignored fade-out unchanged", async () => {
    const left = { ...second, fade_out_ms: 30 };
    hydrateCutAfter(null, left);
    vi.mocked(setClipFade).mockClear();
    render(<ClipInspector clip={left} />);
    await dragFade("in", 20);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c2", 20, 30);
  });

  it("preserves the stationary fade while the available edge range shrinks", async () => {
    const left = { ...second, source_end: 0.05, fade_out_ms: 30 };
    hydrateCutAfter(null, left);
    vi.mocked(setClipFade).mockClear();
    render(<ClipInspector clip={left} />);
    expect(screen.getByLabelText("Fade in ms")).toHaveAttribute("max", "20");
    await dragFade("in", 20);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c2", 20, 30);
  });

  it("uses a typed length once, then the mode default", async () => {
    const user = userEvent.setup();
    render(<ClipInspector clip={second} />);
    await user.type(screen.getByLabelText("Transition length ms"), "40");
    await user.selectOptions(
      screen.getByLabelText("Incoming transition"),
      "Crossfade (overlap both clips)",
    );
    expect(setClipJoin).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "crossfade",
      40,
    );
    expect(screen.getByLabelText("Transition length ms")).toHaveValue(null);
    await user.selectOptions(
      screen.getByLabelText("Incoming transition"),
      "Cut (no fade)",
    );
    expect(setClipJoin).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "cut",
      null,
    );
  });

  it("rejects a bad length without calling the server", async () => {
    const user = userEvent.setup();
    render(<ClipInspector clip={second} />);
    await user.type(screen.getByLabelText("Transition length ms"), "-5");
    await user.click(
      screen.getByRole("button", { name: "Apply transition length" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "non-negative integer",
    );
    expect(setClipJoin).not.toHaveBeenCalled();
  });
});
