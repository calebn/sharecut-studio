import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContractClip,
  type ContractSource,
  type ContractTrack,
  contractClipRow,
} from "../test/contractProject";
import { clipRow } from "../test/fixtures";
import { SRC_ROOT } from "../test/sourceFiles";
import type { EditMode, TrimEdge } from "./clipEdgePreview";
import { trimEdgeLimits } from "./trimLimits";

type Contract = {
  tracks: ContractTrack[];
  sources: ContractSource[];
  cases: {
    name: string;
    track?: string;
    clips: ContractClip[];
    clip_id: string;
    edge: TrimEdge;
    mode: EditMode;
    limits: [number, number];
  }[];
};

const CONTRACT = JSON.parse(
  readFileSync(
    join(SRC_ROOT, "../../../contracts/trim-edge-limits.json"),
    "utf8",
  ),
) as Contract;

describe("trim edge limits match trim_edge_limits (contracts/trim-edge-limits.json)", () => {
  it.each(CONTRACT.cases)("$name", (c) => {
    const track = CONTRACT.tracks.find((t) => t.id === (c.track ?? "host"));
    if (!track) throw new Error(`no track ${c.track}`);
    const lane = c.clips.map((row) =>
      contractClipRow(track, CONTRACT.sources, row),
    );
    const index = lane.findIndex((clip) => clip.id === c.clip_id);
    const { lo, hi } = trimEdgeLimits(lane, index, c.edge, c.mode);
    expect([lo, hi]).toEqual(c.limits.map((v) => expect.closeTo(v, 9)));
  });
});

describe("clips of two different sources", () => {
  const lane = (firstKey: string | null, secondKey: string | null) => [
    clipRow({
      id: "a",
      source_id: "src-a",
      recording_key: firstKey,
      source_start: 0,
      source_end: 4,
      source_duration_sec: 20,
      timeline_start: 0,
      timeline_end: 4,
    }),
    clipRow({
      id: "b",
      source_id: "src-b",
      recording_key: secondKey,
      source_start: 6,
      source_end: 10,
      source_duration_sec: 20,
      timeline_start: 4,
      timeline_end: 8,
    }),
  ];

  it("share a recording only when both name the same one", () => {
    expect(trimEdgeLimits(lane("rec_1", "rec_1"), 0, "out", "ripple")).toEqual({
      lo: 0.05,
      hi: 6,
    });
  });

  it("are not the same recording just because neither knows its recording", () => {
    expect(trimEdgeLimits(lane(null, null), 0, "out", "ripple")).toEqual({
      lo: 0.05,
      hi: 20,
    });
    expect(trimEdgeLimits(lane("rec_1", null), 0, "out", "ripple")).toEqual({
      lo: 0.05,
      hi: 20,
    });
  });
});
