import { describe, expect, it } from "vitest";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../types/pipeline";
import {
  currentTightenIntensity,
  findHitsConfirm,
  findHitsRunError,
  tightenIntensityLabel,
  tightenIntensityOptions,
  tightenProposeRunOptions,
} from "./tightenIntensity";

function cfg(config: Record<string, unknown> = {}): PipelineConfigResponse {
  return {
    defaults: {},
    config,
    enabled_steps: [],
    unattended: true,
    steps: [],
    params: [
      {
        path: "tighten.intensity",
        label: "x",
        description: "x",
        type: "enum",
        enum: ["light", "medium", "aggressive"],
        default: "medium",
        group: "common",
        section: "tighten",
        affects: [],
      },
    ],
    components: {},
    step_names: [],
  };
}

describe("tightenIntensity helpers", () => {
  it("reads options from the server catalog", () => {
    expect(tightenIntensityOptions(null)).toEqual([]);
    expect(tightenIntensityOptions(cfg())).toEqual([
      "light",
      "medium",
      "aggressive",
    ]);
  });

  it("prefers the working set, then the catalog default", () => {
    expect(currentTightenIntensity(null)).toBeNull();
    expect(currentTightenIntensity(cfg())).toBe("medium");
    expect(
      currentTightenIntensity(cfg({ tighten: { intensity: "light" } })),
    ).toBe("light");
  });

  it("capitalizes labels", () => {
    expect(tightenIntensityLabel("aggressive")).toBe("Aggressive");
  });

  it("builds a one-step run that forces tighten on without mutating input", () => {
    const input = cfg({ tighten: { max_pause_sec: 1.2, enabled: false } });
    const before = structuredClone(input.config);
    const opts = tightenProposeRunOptions(input, "light");
    expect(opts.onlyStep).toBe("analyze_fillers_pauses");
    expect(opts.useWorkingSet).toBe(false);
    expect(opts.config?.tighten).toEqual({
      max_pause_sec: 1.2,
      intensity: "light",
      enabled: true,
    });
    expect(input.config).toEqual(before);
  });
});

describe("findHitsConfirm", () => {
  it("asks only when hits are listed", () => {
    expect(findHitsConfirm(0)).toBeNull();
    expect(findHitsConfirm(3)).toContain("(3 now)");
  });
});

describe("findHitsRunError", () => {
  const snap = (
    over: Partial<PipelineJobSnapshot> = {},
  ): PipelineJobSnapshot => ({
    id: "j1",
    project_path: "/p",
    from_step: null,
    only_step: "analyze_fillers_pauses",
    kind: "pipeline",
    status: "error",
    current: null,
    total: null,
    message: null,
    error: "refine required",
    elapsed_sec: 0,
    steps: [],
    ...over,
  });

  it("returns the error of the started job only", () => {
    expect(findHitsRunError("j1", snap())).toBe("refine required");
    expect(findHitsRunError(null, snap())).toBeNull();
    expect(findHitsRunError("other", snap())).toBeNull();
    expect(findHitsRunError("j1", snap({ status: "running" }))).toBeNull();
    expect(findHitsRunError("j1", snap({ error: null }))).toBe(
      "Find hits failed.",
    );
  });
});
