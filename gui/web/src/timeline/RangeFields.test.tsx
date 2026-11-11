import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { makeRangeTarget } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { RangeFields } from "./RangeFields";

const project = minimalProject({
  tracks: [
    sampleTrack({ id: "a", label: "Speaker", range_media_seal: "seal" }),
  ],
  clips: {
    tracks: {
      a: [
        clipRow({
          track_id: "a",
          timeline_start: 0,
          timeline_end: 5,
          source_start: 0,
          source_end: 5,
        }),
      ],
    },
    clip_count: 1,
  },
});
const twoTrackProject = () => {
  const clips = (id: string) => [
    clipRow({
      track_id: id,
      timeline_start: 0,
      timeline_end: 5,
      source_start: 0,
      source_end: 5,
    }),
  ];
  return minimalProject({
    tracks: [
      sampleTrack({ id: "a", label: "Speaker", range_media_seal: "seal" }),
      sampleTrack({ id: "b", label: "Guest", range_media_seal: "seal" }),
    ],
    clips: { tracks: { a: clips("a"), b: clips("b") }, clip_count: 2 },
  });
};

const SCOPE_HINT = "Pick a track in Scope to apply this range.";

const target = makeRangeTarget(project, [{ start: 1, end: 2 }], ["a"])!;

beforeEach(() =>
  useDawStore.setState({
    project,
    projectPath: "/tmp/episode",
    selection: { kind: "range", target },
    rangeArmed: false,
    rangeBusy: false,
    guestMode: null,
    shareCapabilities: null,
    joinMutationInFlight: false,
    sessionRegion: null,
  }),
);

describe("range fields", () => {
  it("draws nothing for a plain range: its verbs are the Action bar's", () => {
    const { container } = render(<RangeFields />);
    expect(container).toBeEmptyDOMElement();
  });
  it("has no In and Out inputs, Select range, Cancel or Apply: a range is edited by its Scrub fields", () => {
    render(<RangeFields sheet always />);
    expect(screen.queryAllByRole("button")).toEqual([
      expect.objectContaining({ textContent: "Speaker" }),
    ]);
    for (const name of ["In", "Out", "Length"])
      expect(screen.getByRole("spinbutton", { name })).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector('input[type="number"]')).toBeNull();
  });
  it("commits In, Out and Length as a new range selection", async () => {
    render(<RangeFields sheet always />);
    const field = (name: string) => screen.getByRole("spinbutton", { name });
    expect(field("In")).toHaveAttribute("aria-valuenow", "1");
    expect(field("Out")).toHaveAttribute("aria-valuenow", "2");
    expect(field("Length")).toHaveAttribute("aria-valuenow", "1");
    field("Length").focus();
    fireEvent.keyDown(field("Length"), { key: "ArrowUp" });
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "range",
      target: { intervals: [{ start: 1, end: 2.01 }] },
    });
  });
  it("narrows the scope with track toggles and keeps one on", async () => {
    const user = userEvent.setup();
    render(<RangeFields sheet always />);
    const speaker = screen.getByRole("button", { name: "Speaker" });
    expect(speaker).toHaveAttribute("aria-pressed", "true");
    await user.click(speaker);
    expect(speaker).toHaveAttribute("aria-pressed", "true");
  });
  it("asks which audible occurrence when repeated material has two", async () => {
    const user = userEvent.setup();
    const repeated = minimalProject({
      tracks: [
        sampleTrack({ id: "speaker", label: "Speaker", range_media_seal: "s" }),
      ],
      clips: {
        tracks: {
          speaker: [
            clipRow({
              id: "first",
              track_id: "speaker",
              origin_track_id: "speaker",
              source_id: null,
              source_start: 0,
              source_end: 8,
              timeline_start: 0,
              timeline_end: 8,
            }),
            clipRow({
              id: "second",
              track_id: "speaker",
              origin_track_id: "speaker",
              source_id: null,
              source_start: 0,
              source_end: 8,
              timeline_start: 10,
              timeline_end: 18,
            }),
          ],
        },
        clip_count: 2,
      },
      transcript: {
        utterances: [
          {
            track_id: "speaker",
            speaker: "Speaker",
            start: 1,
            end: 7,
            text: "one two",
            words: [
              { text: "one", start: 1, end: 2, word_index: 0 },
              { text: "two", start: 6, end: 7, word_index: 1 },
            ],
          },
        ],
      },
    });
    useDawStore.setState({
      project: repeated,
      selection: {
        kind: "transcriptRange",
        trackId: "speaker",
        startWordIndex: 0,
        endWordIndex: 1,
      },
    });
    render(<RangeFields />);
    expect(screen.getByText("Choose the audible occurrence.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Occurrence 2/ }));
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "range",
      target: { intervals: [{ start: 11, end: 17 }] },
    });
  });
  it("draws no word step buttons for a words selection", () => {
    useDawStore.setState({
      selection: {
        kind: "transcriptRange",
        trackId: "a",
        startWordIndex: 0,
        endWordIndex: 0,
      },
    });
    render(<RangeFields />);
    expect(screen.queryByRole("group", { name: /word/i })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("adopts the agent range on the tracks nothing narrowed", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      selection: null,
      rangeArmed: true,
      sessionRegion: { start_sec: 3, end_sec: 4 },
      playheadSec: 9,
      followingClientId: "agent",
    });
    render(<RangeFields sheet />);
    await user.click(
      screen.getByRole("button", {
        name: "Use agent range on selected tracks",
      }),
    );
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "range",
      target: { track_ids: ["a"], intervals: [{ start: 3, end: 4 }] },
    });
    expect(useDawStore.getState().playheadSec).toBe(9);
    expect(useDawStore.getState().followingClientId).toBe("agent");
  });
  it("holds a scope picked before the agent range is adopted, then adopts onto it", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      project: twoTrackProject(),
      selection: null,
      rangeDraft: null,
      sessionRegion: { start_sec: 3, end_sec: 4 },
    });
    render(<RangeFields sheet />);
    const guest = screen.getByRole("button", { name: "Guest" });
    expect(guest).toHaveAttribute("aria-pressed", "false");
    await user.click(guest);
    expect(guest).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Speaker" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(useDawStore.getState().agentRangeScope).toEqual(["b"]);
    await user.click(
      screen.getByRole("button", {
        name: "Use agent range on selected tracks",
      }),
    );
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "range",
      target: { track_ids: ["b"], intervals: [{ start: 3, end: 4 }] },
    });
    expect(useDawStore.getState().agentRangeScope).toBeNull();
  });
  it("shows the draft's scope over a scope picked before adoption", () => {
    useDawStore.setState({
      project: twoTrackProject(),
      selection: null,
      sessionRegion: { start_sec: 3, end_sec: 4 },
    });
    useDawStore.getState().armRange({ start: 0, end: 5, trackIds: ["a"] });
    useDawStore.getState().setAgentRangeScope(["b"]);
    render(<RangeFields sheet />);
    expect(screen.getByRole("button", { name: "Speaker" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Guest" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
  it("adopts on the tracks that remain when a picked track is removed", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      project: twoTrackProject(),
      selection: null,
      rangeDraft: null,
      sessionRegion: { start_sec: 3, end_sec: 4 },
      agentRangeScope: ["b"],
    });
    const { rerender } = render(<RangeFields sheet />);
    expect(screen.getByRole("button", { name: "Guest" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const full = twoTrackProject();
    act(() =>
      useDawStore.setState({
        project: { ...full, tracks: full.tracks.filter((t) => t.id === "a") },
      }),
    );
    rerender(<RangeFields sheet />);
    expect(screen.queryByRole("button", { name: "Guest" })).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: "Use agent range on selected tracks",
      }),
    );
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "range",
      target: { track_ids: ["a"], intervals: [{ start: 3, end: 4 }] },
    });
  });
  it("drops the draft once the agent range is adopted", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      selection: null,
      sessionRegion: { start_sec: 3, end_sec: 4 },
    });
    useDawStore.getState().armRange({ start: 0, end: 5, trackIds: ["a"] });
    render(<RangeFields sheet />);
    await user.click(
      screen.getByRole("button", {
        name: "Use agent range on selected tracks",
      }),
    );
    expect(useDawStore.getState().rangeDraft).toBeNull();
    expect(useDawStore.getState().rangeArmed).toBe(false);
  });
  it("keeps an open Inspector open on the range it adopts", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      selection: { kind: "track", trackId: "a" },
      inspectorKey: "track:a",
      sessionRegion: { start_sec: 3, end_sec: 4 },
    });
    render(<RangeFields sheet />);
    await user.click(
      screen.getByRole("button", {
        name: "Use agent range on selected tracks",
      }),
    );
    expect(useDawStore.getState().selection).toMatchObject({ kind: "range" });
    expect(useDawStore.getState().inspectorKey).toBe("range");
  });
  describe("draft", () => {
    const field = (name: string) => screen.getByRole("spinbutton", { name });
    const arm = (draft = { start: 1, end: 3, trackIds: ["a"] }) => {
      useDawStore.setState({ selection: null });
      useDawStore.getState().armRange(draft);
    };
    it("shows the seeded In, Out and Length", () => {
      arm();
      render(<RangeFields sheet />);
      expect(field("In")).toHaveAttribute("aria-valuenow", "1");
      expect(field("Out")).toHaveAttribute("aria-valuenow", "3");
      expect(field("Length")).toHaveAttribute("aria-valuenow", "2");
    });
    it("commits the seeded span when Enter accepts Out unchanged", async () => {
      const user = userEvent.setup();
      arm();
      render(<RangeFields sheet />);
      await user.click(field("Out"));
      await user.keyboard("{Enter}");
      const s = useDawStore.getState();
      expect(s.selection).toMatchObject({
        kind: "range",
        target: { intervals: [{ start: 1, end: 3 }], track_ids: ["a"] },
      });
      expect(s.rangeArmed).toBe(false);
      expect(s.rangeDraft).toBeNull();
      expect(s.inspectorKey).toBe("range");
    });
    it("commits a typed In with the draft's Out", async () => {
      const user = userEvent.setup();
      arm();
      render(<RangeFields sheet />);
      await user.click(field("In"));
      await user.keyboard("2{Enter}");
      expect(useDawStore.getState().selection).toMatchObject({
        kind: "range",
        target: { intervals: [{ start: 2, end: 3 }] },
      });
    });
    it("announces the first commit", async () => {
      const user = userEvent.setup();
      arm();
      render(<RangeFields sheet />);
      await user.click(field("In"));
      await user.keyboard("2{Enter}");
      expect(useDawStore.getState().feedbackToast?.message).toBe(
        "Range 2.00–3.00 s selected",
      );
    });
    it("refuses an Out past the timeline end inline", async () => {
      const user = userEvent.setup();
      arm();
      render(<RangeFields sheet />);
      await user.click(field("Out"));
      await user.keyboard("9{Enter}");
      expect(useDawStore.getState().selection).toBeNull();
      expect(useDawStore.getState().rangeDraft).toEqual({
        start: 1,
        end: 3,
        trackIds: ["a"],
      });
    });
    it("keeps a typed span and asks for a track when the scope is empty", async () => {
      const user = userEvent.setup();
      arm({ start: 1, end: 3, trackIds: [] });
      render(<RangeFields sheet />);
      await user.click(field("In"));
      await user.keyboard("2{Enter}");
      expect(useDawStore.getState().selection).toBeNull();
      expect(useDawStore.getState().rangeDraft).toEqual({
        start: 2,
        end: 3,
        trackIds: [],
      });
      expect(useDawStore.getState().feedbackToast?.message).toBe(
        "Choose at least one track",
      );
    });
    it("keeps a lasting hint while the draft has no track", () => {
      arm({ start: 1, end: 3, trackIds: [] });
      render(<RangeFields sheet />);
      expect(screen.getByText(SCOPE_HINT)).toBeVisible();
    });
    it("shows no hint while the draft has a track", () => {
      arm();
      render(<RangeFields sheet />);
      expect(screen.queryByText(SCOPE_HINT)).toBeNull();
    });
    it("hides once a range is selected", () => {
      arm();
      useDawStore.setState({ selection: { kind: "range", target } });
      render(<RangeFields />);
      expect(screen.queryByRole("spinbutton")).toBeNull();
    });
  });
});
