import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ClipRow, TrackView } from "../types/project";
import { wordSelection } from "../utils/rangeSelect";
import { Inspector } from "./Inspector";
import { SelectionSheetBody } from "./SelectionSheetBody";

vi.mock("../api", () => ({
  applyFadeRecommendations: vi.fn(),
  setClipFade: vi.fn(),
  setClipJoin: vi.fn(),
  setEnvelope: vi.fn(),
}));

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

function track(id: string): TrackView {
  return {
    id,
    label: id,
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 20,
    fx_count: 0,
    stem_is_fresh: true,
  };
}

function clip(id: string, trackId: string, start: number): ClipRow {
  return {
    id,
    track_id: trackId,
    source_start: 0,
    source_end: 2,
    timeline_start: start,
    timeline_end: start + 2,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
    source_duration_sec: null,
    recording_key: null,
    mute_regions: [{ start_s: 0.2, end_s: 0.8 }],
  };
}

describe("Inspector clip lookup", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate(
      "/tmp/ep",
      minimalProject({
        tracks: [track("host"), track("guest")],
        clips: {
          clip_count: 1,
          tracks: {
            host: [],
            guest: [clip("c1", "guest", 4)],
          },
        },
      }),
    );
  });

  it("finds a clip by id after it moved to another lane", () => {
    useDawStore.getState().setSelection({
      kind: "clip",
      id: "c1",
      trackId: "host",
    });
    render(<Inspector />);
    expect(
      document.querySelector('[data-presence-anchor="inspector"]'),
    ).toBeTruthy();
    expect(screen.queryByText("Clip not found")).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "guest clip, 00:04.000 to 00:06.000",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("c1")).toBeNull();
    expect(screen.getByText(/0\.200–0\.800 s/)).toBeInTheDocument();
  });

  it("resets a transcript draft when primary switches to a recording named primary", () => {
    useDawStore.getState().hydrate(
      "/tmp/ep",
      minimalProject({
        tracks: [track("host")],
        transcript: {
          utterances: [
            {
              track_id: "host",
              source_id: null,
              speaker: "Host",
              start: 0,
              end: 1,
              text: "primary word",
              mappable: true,
              timeline_start: 0,
              timeline_end: 1,
              words: [
                {
                  text: "primary word",
                  start: 0,
                  end: 1,
                  timeline_start: 0,
                  timeline_end: 1,
                  word_index: 0,
                  confidence: 0.9,
                },
              ],
            },
            {
              track_id: "host",
              source_id: "primary",
              speaker: "Host",
              start: 0,
              end: 1,
              text: "recording word",
              mappable: true,
              timeline_start: 0,
              timeline_end: 1,
              words: [
                {
                  text: "recording word",
                  start: 0,
                  end: 1,
                  timeline_start: 0,
                  timeline_end: 1,
                  word_index: 0,
                  confidence: 0.9,
                },
              ],
            },
          ],
        },
      }),
    );
    useDawStore
      .getState()
      .setSelection(
        wordSelection({ trackId: "host", sourceId: null, wordIndex: 0 }),
      );
    render(<Inspector />);

    const correction = screen.getByLabelText("Corrected text");
    expect(correction).toHaveValue("primary word");
    fireEvent.change(correction, { target: { value: "primary draft" } });
    act(() => {
      useDawStore
        .getState()
        .setSelection(
          wordSelection({ trackId: "host", sourceId: "primary", wordIndex: 0 }),
        );
    });

    expect(
      screen.getByRole("heading", { name: "recording word" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Corrected text")).toHaveValue(
      "recording word",
    );
  });

  it.each([
    [
      "range",
      {
        kind: "range" as const,
        target: {
          kind: "exact_range" as const,
          intervals: [{ start: 1, end: 3 }],
          track_ids: ["host"],
          clips: [],
          media_seals: {},
        },
      },
      "Select range",
    ],
    [
      "transcriptRange",
      {
        kind: "transcriptRange" as const,
        trackId: "host",
        startWordIndex: 0,
        endWordIndex: 1,
      },
      "No audible words in this selection",
    ],
  ])(
    "gives a selected %s its actions as the body",
    (_kind, selection, text) => {
      useDawStore.getState().setSelection(selection);
      render(<Inspector placement="sheet" />);
      expect(
        screen.getByRole("region", { name: "Range fields" }),
      ).toHaveTextContent(text);
      expect(screen.queryByText("Clip not found")).toBeNull();
    },
  );

  it("draws nothing without a selection: Inspect opens it for one", () => {
    useDawStore.getState().setSelection(null);
    const { container } = render(<Inspector />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the volume envelope workspace for a selected point", () => {
    useDawStore.getState().hydrate(
      "/tmp/ep",
      minimalProject({
        tracks: [track("host")],
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: [
              { id: "early", time: 0, value: 1 },
              { id: "late", time: 4, value: 0.4 },
            ],
          },
        ],
      }),
    );
    useDawStore.getState().setSelection({
      kind: "envelopePoint",
      trackId: "host",
      pointId: "late",
    });
    render(<Inspector />);
    expect(screen.getByText("Editing volume envelope")).toBeTruthy();
    expect(screen.getByLabelText("Envelope point")).toHaveValue("late");
  });
});

describe("SelectionSheetBody", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate(
      "/tmp/ep",
      minimalProject({
        tracks: [track("host"), track("guest")],
        clips: {
          clip_count: 1,
          tracks: {
            host: [],
            guest: [clip("c1", "guest", 4)],
          },
        },
      }),
    );
  });

  it("shows range actions without empty inspector while range is armed with no selection", () => {
    useDawStore.setState({ selection: null, rangeArmed: true });
    render(
      <div className="bottom-sheet-body">
        <SelectionSheetBody rangeActionsInSheet peek={null} />
      </div>,
    );
    expect(
      screen.getByRole("button", { name: "Cancel range selection" }),
    ).toBeVisible();
    expect(screen.queryByText(/Click a clip/)).toBeNull();
  });

  it("dual-mounts range actions above the inspector when something else is selected", () => {
    useDawStore.setState({
      rangeArmed: true,
      selection: { kind: "clip", id: "c1", trackId: "guest" },
    });
    render(
      <div className="bottom-sheet-body">
        <SelectionSheetBody rangeActionsInSheet peek={null} />
      </div>,
    );
    expect(
      screen.getByRole("button", { name: "Cancel range selection" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", {
        name: "guest clip, 00:04.000 to 00:06.000",
      }),
    ).toBeInTheDocument();
  });
});
