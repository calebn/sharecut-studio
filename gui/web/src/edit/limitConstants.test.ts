import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT } from "../test/sourceFiles";
import {
  JOIN_GAP_TOLERANCE_SEC,
  MIN_EDGE_SPAN_SEC,
  RIPPLE_EDGE_EPS_SEC,
  TIME_EPS_SEC,
} from "./limits.generated";

function constants(name: string): Record<string, number> {
  const text = readFileSync(join(SRC_ROOT, "../../../contracts", name), "utf8");
  return JSON.parse(text).constants;
}

describe("geometry constants match contracts/*.json", () => {
  it("trim edge span and time epsilon", () => {
    const trim = constants("trim-edge-limits.json");
    expect(MIN_EDGE_SPAN_SEC).toBe(trim.min_clip_span_sec);
    expect(TIME_EPS_SEC).toBe(trim.time_eps_sec);
  });

  it("join gap tolerance", () => {
    expect(JOIN_GAP_TOLERANCE_SEC).toBe(
      constants("join-length-limits.json").join_gap_tolerance_sec,
    );
  });

  it("ripple edge epsilon", () => {
    expect(RIPPLE_EDGE_EPS_SEC).toBe(
      constants("ripple-scope.json").edge_eps_sec,
    );
  });
});
