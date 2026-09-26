import { describe, expect, it } from "vitest";
import type { PipelineConfigResponse } from "../types/pipeline";
import {
  currentTightenIntensity,
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
