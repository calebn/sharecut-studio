import { describe, expect, it, vi } from "vitest";
import type { PipelineJobSnapshot } from "../types/pipeline";
import {
  recordJobMedia,
  runIncludesTranscribe,
  transcribeProgress,
} from "./jobMedia";

const STEPS = [
  "ingest_tracks",
  "transcribe_tracks",
  "align_tracks",
  "require_align_accept",
  "merge_transcript",
  "render_dialogue_stems",
  "reconcile_transcript",
  "precorrect_transcript",
  "require_transcript_refine",
  "analyze_prosody",
  "analyze_focus_cuts",
  "focus_from_transcript",
  "analyze_fillers_pauses",
  "tighten_from_transcript",
  "apply_sound_actions",
  "fill_gate_holes",
  "clean_audio",
  "compress_tracks",
  "balance_tracks",
  "assemble_timeline",
  "mix_with_music",
  "master_loudness",
  "export_deliverables",
];

describe("runIncludesTranscribe", () => {
  it("counts a full run", () => {
    expect(runIncludesTranscribe({})).toBe(true);
    expect(runIncludesTranscribe({ fromStep: null, onlyStep: null })).toBe(
      true,
    );
  });

  it.each(STEPS)("from_step %s", (step) => {
    expect(runIncludesTranscribe({ fromStep: step })).toBe(
      step === "ingest_tracks" || step === "transcribe_tracks",
    );
  });

  it.each(STEPS)("only_step %s", (step) => {
    expect(runIncludesTranscribe({ onlyStep: step })).toBe(
      step === "transcribe_tracks",
    );
  });

  it("lets only_step decide when both are set", () => {
    expect(
      runIncludesTranscribe({
        fromStep: "transcribe_tracks",
        onlyStep: "align_tracks",
      }),
    ).toBe(false);
  });

  it("does not count a step it does not know", () => {
    expect(runIncludesTranscribe({ fromStep: "nope" })).toBe(false);
  });
});

describe("the audio a job covered", () => {
  it("is still known after a reload, from this tab's storage", async () => {
    sessionStorage.clear();
    vi.resetModules();
    const before = await import("./jobMedia");
    before.recordJobMedia("j-reload", "a:/a.wav");
    vi.resetModules();
    const after = await import("./jobMedia");
    expect(after).not.toBe(before);
    expect(after.jobMediaKey("j-reload")).toBe("a:/a.wav");
    sessionStorage.clear();
    vi.resetModules();
    const withoutStorage = await import("./jobMedia");
    expect(withoutStorage.jobMediaKey("j-reload")).toBeUndefined();
  });

  it("keeps only the latest jobs", () => {
    sessionStorage.clear();
    for (let at = 0; at < 25; at += 1) recordJobMedia(`j${at}`, `k${at}`);
    const saved = JSON.parse(
      sessionStorage.getItem("sharecut.jobMedia") ?? "{}",
    );
    expect(Object.keys(saved)).toHaveLength(20);
    expect(saved.j24).toBe("k24");
  });
});

describe("transcribeProgress", () => {
  const PATH = "/tmp/ep";
  const run = (overrides: Partial<PipelineJobSnapshot> = {}) =>
    ({
      id: "j1",
      project_path: PATH,
      from_step: null,
      only_step: null,
      status: "running",
      current: 1,
      total: 4,
      message: null,
      error: null,
      elapsed_sec: 0,
      steps: [],
      ...overrides,
    }) satisfies PipelineJobSnapshot;
  const transcribed = [
    { name: "transcribe_tracks", status: "ok", elapsed_sec: 3, error: null },
  ];

  it.each([
    ["a full run, one of four", run(), false, 0.25],
    [
      "a queued run with no total",
      run({ status: "queued", current: null, total: null }),
      false,
      0,
    ],
    [
      "a transcribe-only run, one of two",
      run({ only_step: "transcribe_tracks", total: 2 }),
      true,
      0.5,
    ],
    [
      "a finished transcribe step before words arrive",
      run({ steps: transcribed, current: 3, total: 5 }),
      false,
      0.6,
    ],
  ] as const)(
    "is the run's fraction for %s",
    (_name, job, hasWords, expected) => {
      expect(transcribeProgress(job, PATH, hasWords)).toBe(expected);
    },
  );

  it.each([
    ["no run", null],
    ["another project's run", run({ project_path: "/tmp/other" })],
    ["an analyze run", run({ kind: "analyze" })],
    ["a run that starts after transcribing", run({ from_step: "clean_audio" })],
    ["a finished run", run({ status: "ok" })],
    [
      "a run that skips transcribing",
      run({ skip_steps: ["transcribe_tracks"] }),
    ],
    [
      "a finished transcribe step with words in",
      run({ steps: transcribed, current: 3, total: 5 }),
    ],
  ] as const)("is null for %s", (_name, job) => {
    expect(transcribeProgress(job, PATH, true)).toBeNull();
  });
});
