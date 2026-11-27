import { describe, expect, it } from "vitest";
import type { DuckingPlan } from "../api";
import { ApiError } from "../utils/apiError";
import {
  DUCKING_AGAIN_LABEL,
  DUCKING_CHANGED,
  DUCKING_CHECKING,
  DUCKING_CURRENT,
  DUCKING_LABEL,
  DUCKING_NO_MUSIC,
  DUCKING_NO_SPEECH,
  DUCKING_STALE,
  DUCKING_UNREACHABLE,
  duckingAppliedLine,
  duckingKind,
  duckingReadyLine,
  duckingRefusal,
  duckingRefusalLine,
  duckingTrackCount,
} from "./duckingCopy";

const row = (changed: boolean, replacedEarlierDips = 0) => ({
  trackId: `t${changed}${replacedEarlierDips}`,
  changed,
  replacedEarlierDips,
  simplified: false,
});
const plan = (
  depthDb: number,
  ...tracks: ReturnType<typeof row>[]
): DuckingPlan => ({ planToken: "t", depthDb, tracks });

describe("duckingKind", () => {
  it("is current when no track would change, even with dips already saved", () => {
    expect(duckingKind(plan(-18, row(false, 5), row(false)))).toBe("current");
    expect(duckingKind(plan(-18))).toBe("current");
  });
  it("is ready when a track would change and no earlier dips are replaced", () => {
    expect(duckingKind(plan(-18, row(true), row(false)))).toBe("ready");
  });
  it("is stale when a changed track has earlier dips to replace", () => {
    expect(duckingKind(plan(-18, row(true, 2), row(false)))).toBe("stale");
  });
});

describe("copy", () => {
  it("counts only the tracks the plan would change", () => {
    expect(duckingTrackCount(plan(-18, row(true), row(false), row(true)))).toBe(
      2,
    );
  });

  it("says the depth in whole or tenth dB, always as a positive number", () => {
    expect(duckingReadyLine(plan(-18, row(true)))).toBe(
      "Lowers 1 music track by 18 dB while people speak. Your own volume points stay.",
    );
    expect(duckingReadyLine(plan(-12.5, row(true), row(true)))).toBe(
      "Lowers 2 music tracks by 12.5 dB while people speak. Your own volume points stay.",
    );
  });

  it("does not claim the audio was rendered again", () => {
    const line = duckingAppliedLine(plan(-18, row(true), row(true)));
    expect(line).toBe(
      "Music now lowers under speech on 2 music tracks. Play or export to hear it.",
    );
    expect(line).not.toMatch(/render/i);
  });

  it("never says not found, in any line", () => {
    const lines = [
      DUCKING_AGAIN_LABEL,
      DUCKING_CHANGED,
      DUCKING_CHECKING,
      DUCKING_CURRENT,
      DUCKING_LABEL,
      DUCKING_NO_MUSIC,
      DUCKING_NO_SPEECH,
      DUCKING_STALE,
      DUCKING_UNREACHABLE,
      duckingReadyLine(plan(-18, row(true))),
      duckingAppliedLine(plan(-18, row(true))),
    ];
    for (const line of lines) expect(line).not.toMatch(/not found/i);
  });
});

describe("duckingRefusal", () => {
  it.each([
    ["ducking_no_targets", 400, "none", DUCKING_NO_MUSIC],
    ["ducking_no_dialogue_activity", 400, "silent", DUCKING_NO_SPEECH],
    ["document_conflict", 409, "changed", DUCKING_CHANGED],
    [null, 409, "changed", DUCKING_CHANGED],
  ] as const)("reads code %s, status %s as %s", (code, status, kind, line) => {
    const refusal = duckingRefusal(new ApiError("x", code, status));
    expect(refusal).toBe(kind);
    expect(duckingRefusalLine(refusal ?? "none")).toBe(line);
  });

  it("leaves any other failure to the host's own words", () => {
    expect(
      duckingRefusal(new ApiError("x", "ducking_too_many_points", 400)),
    ).toBeNull();
    expect(duckingRefusal(new Error("offline"))).toBeNull();
  });
});
