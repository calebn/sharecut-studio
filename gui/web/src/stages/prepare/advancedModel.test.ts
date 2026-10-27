import { describe, expect, it } from "vitest";
import { pipelineJobSnapshot } from "../../test/fixtures";
import { pipelineConfig } from "../../test/pipelineConfigFixture";
import {
  advancedGroups,
  paramPath,
  withParam,
  withStepSwitch,
} from "./advancedModel";

const cfg = pipelineConfig({
  defaults: {
    transcribe: { language: "en" },
    align: { large_move_sec: 1 },
    gate_fill: { fade_ms: 10 },
    tighten: { max_pause_sec: 1.2, enabled: false },
  },
  config: {
    transcribe: { language: "en" },
    align: { large_move_sec: 4 },
    gate_fill: { fade_ms: 10 },
    tighten: { max_pause_sec: 1.2, enabled: false },
  },
  enabled_steps: ["transcribe_tracks", "align_tracks", "fill_gate_holes"],
});

describe("advancedGroups", () => {
  it("lists only the four steps that have a row", () => {
    const groups = advancedGroups(cfg, null);
    expect(groups.map((g) => g.title)).toEqual([
      "Transcribe",
      "Line up tracks",
      "Clean and level",
      "Find suggestions",
    ]);
    expect(groups.flatMap((g) => g.steps.map((s) => s.id))).toEqual([
      "transcribe_tracks",
      "align_tracks",
      "fill_gate_holes",
      "analyze_fillers_pauses",
    ]);
  });

  it("reads switches from the enabled steps, and values with their defaults", () => {
    const steps = advancedGroups(cfg, null).flatMap((g) => g.steps);
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId.fill_gate_holes.enabled).toBe(true);
    expect(byId.analyze_fillers_pauses.enabled).toBe(false);
    expect(byId.analyze_fillers_pauses.optional).toBe(true);
    expect(byId.align_tracks.params[0]).toMatchObject({
      kind: "scrub",
      value: 4,
      defaultValue: 1,
    });
    expect(byId.transcribe_tracks.params[0]).toMatchObject({
      kind: "language",
      value: "en",
    });
  });

  it("shows no language as Detect automatically", () => {
    const auto = pipelineConfig({
      config: { transcribe: { language: null } },
      defaults: { transcribe: { language: "en" } },
    });
    const language = advancedGroups(auto, null)[0].steps[0].params[0];
    expect(language).toMatchObject({ value: "auto", defaultValue: "en" });
  });

  it("carries the last result line of a step", () => {
    const job = pipelineJobSnapshot({
      steps: [
        {
          name: "fill_gate_holes",
          status: "ok",
          elapsed_sec: 1,
          error: null,
          summary: "12 gaps filled",
        },
      ],
    });
    const gaps = advancedGroups(cfg, job)[2].steps[0];
    expect(gaps.result).toBe("12 gaps filled");
  });
});

describe("edits", () => {
  it("finds the settings path of a step setting", () => {
    expect(paramPath("align_tracks", "max-move")).toBe("align.large_move_sec");
    expect(paramPath("align_tracks", "nope")).toBeNull();
    expect(paramPath("nope", "max-move")).toBeNull();
  });

  it("writes a value, and Detect automatically as no language", () => {
    expect(withParam(cfg.config, "align.large_move_sec", 6)).toMatchObject({
      align: { large_move_sec: 6 },
    });
    expect(withParam(cfg.config, "transcribe.language", "auto")).toMatchObject({
      transcribe: { language: null },
    });
    expect(withParam(cfg.config, "transcribe.language", "fr")).toMatchObject({
      transcribe: { language: "fr" },
    });
  });

  it("switches a step on or off", () => {
    expect(withStepSwitch(cfg, "fill_gate_holes", false)).toEqual({
      enabled_steps: ["transcribe_tracks", "align_tracks"],
    });
  });

  it("turns tighten on and off with the steps that gate it", () => {
    const on = withStepSwitch(cfg, "analyze_fillers_pauses", true);
    expect(on.enabled_steps).toContain("analyze_fillers_pauses");
    expect(on.config).toMatchObject({ tighten: { enabled: true } });
    const off = withStepSwitch(
      { ...cfg, enabled_steps: on.enabled_steps, config: on.config! },
      "analyze_fillers_pauses",
      false,
    );
    expect(off.config).toMatchObject({ tighten: { enabled: false } });
  });
});
