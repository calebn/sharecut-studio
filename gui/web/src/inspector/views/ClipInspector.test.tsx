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
import { BottomSheet } from "../../ui/BottomSheet";
import { UNAPPLIED_VALUE_REASON } from "../NudgeButtons";
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
  source_duration_sec: null,
  recording_key: null,
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

async function applyFade(edge: "in" | "out", value: number) {
  fireEvent.change(screen.getByLabelText(`Fade ${edge} ms`), {
    target: { value: String(value) },
  });
  fireEvent.click(screen.getByRole("button", { name: `Apply fade ${edge}` }));
  await waitFor(() => expect(setClipFade).toHaveBeenCalled());
}

describe("ClipInspector presentation", () => {
  it("inspects the current placed occurrence after cancelling its placement preview", () => {
    const moved = {
      ...clip,
      id: "current-copy",
      track_id: "guest",
      origin_track_id: "host",
      source_start: 30,
      source_end: 32,
      timeline_start: 4,
      timeline_end: 6,
    };
    hydrateClipProject(sampleTrack({ id: "guest" }), moved);
    useDawStore.setState({
      timelineDragging: false,
      joinMutationInFlight: false,
    });
    render(<ClipInspector clip={moved} />);
    fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
    fireEvent.click(screen.getByRole("button", { name: "Later 10 ms" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect automatic audio reduction" }),
    );
    expect(screen.queryByLabelText("Timeline start (seconds)")).toBeNull();
    expect(useDawStore.getState().selection).toEqual({
      kind: "bleedAttenuation",
      id: "current-copy",
      trackId: "guest",
      regionKey: null,
    });
  });
  it("names the origin speaker and timeline range without the raw clip id", async () => {
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
    expect(screen.queryByText("internal-clip-id")).toBeNull();
    expect(screen.queryByText("ID")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("preserves placement after an invalid trim and cancels it for a valid fade", async () => {
    hydrateClipProject(sampleTrack({ speaker: "Host" }));
    useDawStore.setState({
      timelineDragging: false,
      joinMutationInFlight: false,
    });
    render(<ClipInspector clip={clip} />);
    fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
    fireEvent.click(screen.getByRole("button", { name: "Later 10 ms" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Source start" }), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply source start" }));
    expect(screen.getByLabelText("Timeline start (seconds)")).toHaveValue(0.01);
    await applyFade("in", 20);
    expect(screen.queryByLabelText("Timeline start (seconds)")).toBeNull();
    expect(screen.getByRole("button", { name: "Move clip" })).toBeVisible();
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
    expect(buttons.slice(-4)).toEqual([
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

  it("shows numeric source edges with 44px-step controls and protects a dirty trim draft", () => {
    hydrateClipProject(sampleTrack({ speaker: "Host" }));
    render(<ClipInspector clip={clip} />);
    const start = screen.getByRole("spinbutton", { name: "Source start" });
    const startGroup = screen.getByRole("group", {
      name: "Nudge source start",
    });
    const later = within(startGroup).getByRole("button", {
      name: "10 ms later",
    });
    expect(start).toHaveValue(0);
    expect(later).not.toHaveAttribute("aria-disabled");
    fireEvent.change(start, { target: { value: "0.25" } });
    expect(later).toHaveAttribute("aria-disabled", "true");
    expect(later).toBeEnabled();
    expect(later).toHaveAccessibleDescription(UNAPPLIED_VALUE_REASON);
    expect(screen.getByRole("spinbutton", { name: "Source end" })).toHaveValue(
      2,
    );
    expect(
      screen.getByRole("button", { name: "Apply source start" }),
    ).toBeEnabled();
  });

  it("rejects a typed source edge outside the minimum-span bounds", async () => {
    hydrateClipProject(sampleTrack({ speaker: "Host" }));
    render(<ClipInspector clip={clip} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Source start" }), {
      target: { value: "2" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Apply source start" }),
    );
    expect(
      screen.getByText(/must be between 0 and 1\.95 seconds/),
    ).toBeVisible();
  });
});

describe("ClipInspector mute regions", () => {
  const muted = { start_s: 1.5, end_s: 2.5 };

  it("lists a mute the clip still overlaps, whole", () => {
    const overlapping = { ...clip, mute_regions: [muted] };
    hydrateClipProject(sampleTrack({ speaker: "Host" }), overlapping);
    render(<ClipInspector clip={overlapping} />);
    expect(screen.getByText("1.500–2.500 s")).toBeVisible();
  });

  it("hides a mute a trim left outside the clip, which the server keeps", () => {
    const trimmedPast = { ...clip, source_end: 1, mute_regions: [muted] };
    hydrateClipProject(sampleTrack({ speaker: "Host" }), trimmedPast);
    render(<ClipInspector clip={trimmedPast} />);
    expect(screen.queryByText("Mute regions")).toBeNull();
  });
});

describe("ClipInspector fades", () => {
  beforeEach(() => {
    vi.mocked(setClipFade).mockReset().mockResolvedValue(null);
  });

  it("limits a fade to the dialogue track's cap and has no axe violations", async () => {
    hydrateClipProject(sampleTrack({ fade_max_ms: 40 }));
    const { container } = render(<ClipInspector clip={clip} />);
    expect(screen.getByLabelText("Fade in ms")).toHaveAttribute("max", "40");
    expect(screen.getByText("max 40 ms")).toBeInTheDocument();
    await applyFade("in", 40);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 40, 0, {
      fade_in_ms: 0,
      fade_out_ms: 0,
    });
    await expectNoA11yViolations(container);
  });

  it("limits an uncapped track to the clip length", async () => {
    const shortClip = { ...clip, source_end: 0.2 };
    hydrateClipProject(
      sampleTrack({ role: "music", fade_max_ms: null }),
      shortClip,
    );
    render(<ClipInspector clip={shortClip} />);
    await applyFade("in", 200);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 200, 0, {
      fade_in_ms: 0,
      fade_out_ms: 0,
    });
  });

  it("refuses a length past the limit and names it", () => {
    hydrateClipProject(sampleTrack({ fade_max_ms: 40 }));
    render(<ClipInspector clip={clip} />);
    fireEvent.change(screen.getByLabelText("Fade in ms"), {
      target: { value: "41" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply fade in" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Fade in must be a whole number of ms from 0 to 40.",
    );
    expect(setClipFade).not.toHaveBeenCalled();
  });

  it("saves one pair and keeps the other edge", async () => {
    const shortClip = { ...clip, source_end: 0.2, fade_out_ms: 30 };
    hydrateClipProject(
      sampleTrack({ role: "music", fade_max_ms: null }),
      shortClip,
    );
    render(<ClipInspector clip={shortClip} />);
    fireEvent.change(screen.getByLabelText("Fade in ms"), {
      target: { value: "150" },
    });
    expect(screen.getByLabelText("Fade out ms")).toHaveValue(30);
    expect(setClipFade).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply fade in" }));
    await waitFor(() => {
      expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 150, 30, {
        fade_in_ms: 0,
        fade_out_ms: 30,
      });
    });
  });

  it("offers Apply only for a changed length", () => {
    hydrateClipProject(sampleTrack());
    render(<ClipInspector clip={clip} />);
    const apply = screen.getByRole("button", { name: "Apply fade in" });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute("title", "Type a length to apply.");
    fireEvent.change(screen.getByLabelText("Fade in ms"), {
      target: { value: "20" },
    });
    expect(apply).toBeEnabled();
  });

  it("holds the fields while a save runs and shows the saved pair after", async () => {
    hydrateClipProject(sampleTrack());
    let resolveSave: (() => void) | undefined;
    vi.mocked(setClipFade).mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolveSave = () => resolve(null);
        }),
    );
    const view = render(<ClipInspector clip={clip} />);
    fireEvent.change(screen.getByLabelText("Fade in ms"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply fade in" }));
    await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Fade in ms")).toBeDisabled();
    expect(screen.getByLabelText("Fade out ms")).toBeDisabled();

    const saved = { ...clip, fade_in_ms: 20 };
    const project = useDawStore.getState().project;
    if (!project) throw new Error("expected hydrated project");
    useDawStore.setState({
      project: {
        ...project,
        clips: {
          ...project.clips,
          tracks: { ...project.clips.tracks, host: [saved] },
        },
      },
    });
    view.rerender(<ClipInspector clip={saved} />);
    await act(async () => resolveSave?.());
    await waitFor(() => {
      expect(screen.getByLabelText("Fade in ms")).toBeEnabled();
    });
    expect(screen.getByLabelText("Fade in ms")).toHaveValue(20);
  });

  it("shows a refusal and keeps the typed length for another try", async () => {
    hydrateClipProject(sampleTrack({ fade_max_ms: 40 }));
    vi.mocked(setClipFade).mockRejectedValueOnce(
      new Error("This clip changed. Nothing was saved. Adjust the fade again."),
    );
    render(<ClipInspector clip={clip} />);
    await applyFade("in", 40);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Adjust the fade again.",
    );
    expect(screen.getByLabelText("Fade in ms")).toHaveValue(40);
  });

  it("shows a stale refusal after the clip changed underneath and saves a fresh edit", async () => {
    const old = { ...clip, fade_in_ms: 1 };
    hydrateClipProject(sampleTrack(), old);
    let refuse!: (error: Error) => void;
    vi.mocked(setClipFade).mockImplementationOnce(
      () =>
        new Promise<null>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const view = render(<ClipInspector clip={old} />);
    await applyFade("out", 1);
    expect(setClipFade).toHaveBeenLastCalledWith("/tmp/ep.json", "c1", 1, 1, {
      fade_in_ms: 1,
      fade_out_ms: 0,
    });
    const current = useDawStore.getState().project;
    if (!current) throw new Error("expected hydrated project");
    act(() =>
      useDawStore.setState({
        project: {
          ...current,
          clips: { ...current.clips, tracks: { host: [clip] } },
        },
      }),
    );
    view.rerender(<ClipInspector clip={clip} />);
    await act(async () =>
      refuse(
        new Error(
          "This clip changed. Nothing was saved. Adjust the fade again.",
        ),
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Adjust the fade again.",
    );
    expect(screen.getByLabelText("Fade in ms")).toHaveValue(0);
    expect(screen.getByLabelText("Fade out ms")).toHaveValue(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply fade out" }));
    await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(2));
    expect(setClipFade).toHaveBeenLastCalledWith("/tmp/ep.json", "c1", 0, 1, {
      fade_in_ms: 0,
      fade_out_ms: 0,
    });
  });

  it("drops a typed length when the saved one changes underneath it", () => {
    hydrateClipProject(sampleTrack());
    const view = render(<ClipInspector clip={clip} />);
    fireEvent.change(screen.getByLabelText("Fade in ms"), {
      target: { value: "20" },
    });
    view.rerender(<ClipInspector clip={{ ...clip, fade_in_ms: 7 }} />);
    expect(screen.getByLabelText("Fade in ms")).toHaveValue(7);
  });

  it("waits for the clip's track before offering the fields", () => {
    useDawStore
      .getState()
      .hydrate(
        "/tmp/ep.json",
        minimalProject({ tracks: [sampleTrack({ id: "guest" })] }),
      );
    render(<ClipInspector clip={clip} />);
    expect(screen.queryByText(/^max /)).toBeNull();
    expect(screen.getByLabelText("Fade in ms")).toBeDisabled();
    const nudge = within(
      screen.getByRole("group", { name: "Nudge fade in" }),
    ).getByRole("button", { name: "10 ms longer" });
    expect(nudge).toHaveAttribute("aria-disabled", "true");
    expect(nudge).toHaveAccessibleDescription(
      "The fade limit is still loading. Wait a moment, then try again.",
    );
    expect(screen.queryByText("Fades do not apply at a cut.")).toBeNull();
  });

  it("nudges a fade by the same steps as the arrow keys and saves once on release", async () => {
    hydrateClipProject(sampleTrack({ fade_max_ms: 100 }));
    render(<ClipInspector clip={clip} />);
    const group = screen.getByRole("group", { name: "Nudge fade in" });
    const longer = within(group).getByRole("button", { name: "10 ms longer" });
    expect(
      within(group).getByRole("button", { name: "1 ms shorter" }),
    ).toBeInTheDocument();
    fireEvent.pointerDown(longer, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(longer, { pointerId: 1 });
    await waitFor(() => {
      expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 10, 0, {
        fade_in_ms: 0,
        fade_out_ms: 0,
      });
    });
  });

  it("holds the nudges while a typed length is waiting for Apply, and says so", async () => {
    hydrateClipProject(sampleTrack());
    const { container } = render(<ClipInspector clip={clip} />);
    const group = screen.getByRole("group", { name: "Nudge fade in" });
    fireEvent.change(screen.getByLabelText("Fade in ms"), {
      target: { value: "20" },
    });
    const longer = within(group).getByRole("button", { name: "10 ms longer" });
    expect(longer).toHaveAttribute("aria-disabled", "true");
    expect(longer).toBeEnabled();
    const note = screen.getAllByText(UNAPPLIED_VALUE_REASON)[0];
    expect(note).toBeVisible();
    expect(longer).toHaveAttribute("aria-describedby", note?.id);
    longer.focus();
    expect(longer).toHaveFocus();
    fireEvent.pointerDown(longer, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(longer, { pointerId: 1 });
    fireEvent.click(longer);
    await userEvent.keyboard("{Enter}");
    expect(setClipFade).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("ignores a rejected write after switching projects", async () => {
    hydrateClipProject(sampleTrack());
    let rejectSave: ((reason: Error) => void) | undefined;
    vi.mocked(setClipFade).mockImplementationOnce(
      () =>
        new Promise<null>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const view = render(<ClipInspector clip={clip} />);
    fireEvent.change(screen.getByLabelText("Fade in ms"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply fade in" }));
    await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(1));

    useDawStore
      .getState()
      .hydrate("/tmp/other.json", minimalProject({ tracks: [sampleTrack()] }));
    view.rerender(<ClipInspector clip={clip} />);
    await act(async () => rejectSave?.(new Error("old project failed")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Fade in ms")).toBeEnabled();
    expect(screen.getByLabelText("Fade in ms")).toHaveValue(0);
  });

  it("closes the inspector sheet when Escape is pressed in a fade field", () => {
    hydrateClipProject(sampleTrack());
    const onClose = vi.fn();
    render(
      <BottomSheet
        open
        onClose={onClose}
        backgroundPolicy="interactive"
        title="Inspector"
      >
        <ClipInspector clip={clip} />
      </BottomSheet>,
    );
    fireEvent.keyDown(screen.getByLabelText("Fade in ms"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
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
        new Promise<null>((resolve) => {
          resolveSave = () => resolve(null);
        }),
    );
    render(<ClipInspector clip={second} />);
    await user.type(screen.getByLabelText("Transition length ms"), "25");
    fireEvent.change(screen.getByLabelText("Fade in ms"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply fade in" }));
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
    const nudge = within(
      screen.getByRole("group", { name: "Nudge fade in" }),
    ).getByRole("button", { name: "10 ms longer" });
    expect(nudge).toHaveAttribute("aria-disabled", "true");
    expect(nudge).toBeEnabled();
    expect(nudge).toHaveAccessibleDescription("Fades do not apply at a cut.");
    expect(
      within(screen.getByRole("group", { name: "Nudge fade out" })).getByRole(
        "button",
        { name: "10 ms longer" },
      ),
    ).not.toHaveAttribute("aria-disabled");
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
    await applyFade("in", 40);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c2", 40, 0, {
      fade_in_ms: 0,
      fade_out_ms: 0,
    });
  });

  it("sends the ignored fade-out unchanged", async () => {
    const left = { ...second, fade_out_ms: 30 };
    hydrateCutAfter(null, left);
    vi.mocked(setClipFade).mockClear();
    render(<ClipInspector clip={left} />);
    await applyFade("in", 20);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c2", 20, 30, {
      fade_in_ms: 0,
      fade_out_ms: 30,
    });
  });

  it("preserves the stationary fade while the available edge range shrinks", async () => {
    const left = { ...second, source_end: 0.05, fade_out_ms: 30 };
    hydrateCutAfter(null, left);
    vi.mocked(setClipFade).mockClear();
    render(<ClipInspector clip={left} />);
    expect(screen.getByLabelText("Fade in ms")).toHaveAttribute("max", "20");
    await applyFade("in", 20);
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c2", 20, 30, {
      fade_in_ms: 0,
      fade_out_ms: 30,
    });
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
