import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContractClip,
  type ContractSource,
  type ContractTrack,
  contractClipRow,
} from "../test/contractProject";
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
