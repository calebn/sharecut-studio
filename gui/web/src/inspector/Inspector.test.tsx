import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ClipRow, TrackView } from "../types/project";
import { Inspector } from "./Inspector";

vi.mock("../api", () => ({
  applyFadeRecommendations: vi.fn(),
  setClipFade: vi.fn(),
  setJoinMode: vi.fn(),
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
    expect(screen.getByRole("heading", { name: "Clip" })).toBeInTheDocument();
    expect(screen.getAllByText("c1").length).toBeGreaterThan(0);
    expect(screen.getByText(/0\.200–0\.800 s/)).toBeInTheDocument();
  });

  it("anchors the empty inspector", () => {
    useDawStore.getState().setSelection(null);
    render(<Inspector />);
    expect(
      document.querySelector('[data-presence-anchor="inspector"]'),
    ).toBeTruthy();
  });

  it("opens EnvelopePointInspector for a selected point", () => {
    useDawStore.getState().hydrate(
      "/tmp/ep",
      minimalProject({
        tracks: [track("host")],
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: [
              { time: 0, value: 1 },
              { time: 4, value: 0.4 },
            ],
          },
        ],
      }),
    );
    useDawStore.getState().setSelection({
      kind: "envelopePoint",
      trackId: "host",
      index: 1,
    });
    render(<Inspector />);
    expect(screen.getByText("Envelope")).toBeTruthy();
    expect(screen.getByLabelText("Envelope time")).toHaveValue(4);
  });
});
