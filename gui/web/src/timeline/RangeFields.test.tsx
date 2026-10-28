import { render, screen } from "@testing-library/react";
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
  it("has no verb buttons, Clear range or speaker move: those moved to the bar", () => {
    useDawStore.setState({ rangeArmed: true, selection: null });
    render(<RangeFields sheet />);
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Select range", "Cancel range selection"]);
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
  it("keeps the word handles with a words selection", () => {
    useDawStore.setState({
      selection: {
        kind: "transcriptRange",
        trackId: "a",
        startWordIndex: 0,
        endWordIndex: 0,
      },
    });
    render(<RangeFields />);
    expect(screen.getByRole("group", { name: /word/i })).toBeTruthy();
  });
  it("requires deliberate lane selection for numeric and agent ranges", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      selection: null,
      rangeArmed: true,
      sessionRegion: { start_sec: 3, end_sec: 4 },
      playheadSec: 9,
      followingClientId: "agent",
    });
    render(<RangeFields sheet />);
    await user.click(screen.getByRole("button", { name: "Select range" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "choose at least one track",
    );
    await user.click(screen.getByRole("checkbox", { name: "Speaker" }));
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
  it("clears the ticked scope once the agent range is adopted", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      selection: null,
      sessionRegion: { start_sec: 3, end_sec: 4 },
    });
    render(<RangeFields sheet />);
    await user.click(screen.getByRole("checkbox", { name: "Speaker" }));
    expect(useDawStore.getState().rangeScopeTrackIds).toEqual(["a"]);
    await user.click(
      screen.getByRole("button", {
        name: "Use agent range on selected tracks",
      }),
    );
    expect(useDawStore.getState().rangeScopeTrackIds).toBeNull();
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
  it("clears a track selection made while armed when the range is cancelled", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      rangeArmed: true,
      selection: { kind: "track", trackId: "a" },
    });
    render(<RangeFields sheet />);
    await user.click(
      screen.getByRole("button", { name: "Cancel range selection" }),
    );
    expect(useDawStore.getState().selection).toBeNull();
  });
});
