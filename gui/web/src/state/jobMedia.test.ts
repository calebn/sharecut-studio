import { describe, expect, it, vi } from "vitest";
import type { PipelineJobSnapshot } from "../types/pipeline";
import {
  isTranscribing,
  recordJobMedia,
  runIncludesTranscribe,
} from "./jobMedia";

const STEPS = [
  "ingest_tracks",
  "transcribe_tracks",
  "align_tracks",
  "require_align_accept",
  "extract_room_tone_beds",
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

describe("isTranscribing", () => {
  const PATH = "/tmp/ep";
  const step = (name: string, status: string) => ({
    name,
    status,
    elapsed_sec: 1,
    error: null,
  });
  const run = (overrides: Partial<PipelineJobSnapshot> = {}) =>
    ({
      id: "j1",
      project_path: PATH,
      from_step: null,
      only_step: null,
      status: "running",
      current: 1,
      total: 12,
      message: null,
      error: null,
      elapsed_sec: 0,
      steps: [
        step("ingest_tracks", "ok"),
        step("transcribe_tracks", "running"),
      ],
      ...overrides,
    }) satisfies PipelineJobSnapshot;

  it.each([
    ["transcribe_tracks running", run()],
    ["a queued run", run({ status: "queued", steps: [] })],
    [
      "ingest running, transcribe not listed yet",
      run({ steps: [step("ingest_tracks", "running")] }),
    ],
    [
      "ingest done, transcribe not listed yet",
      run({ steps: [step("ingest_tracks", "ok")] }),
    ],
    [
      "a transcribe-only run",
      run({
        only_step: "transcribe_tracks",
        steps: [step("transcribe_tracks", "running")],
      }),
    ],
    [
      "a run from transcribe",
      run({
        from_step: "transcribe_tracks",
        steps: [step("transcribe_tracks", "running")],
      }),
    ],
  ] as const)("is true for %s", (_name, job) => {
    expect(isTranscribing(job, PATH)).toBe(true);
  });

  it.each([
    ["no run", null],
    ["another project's run", run({ project_path: "/tmp/other" })],
    ["an analyze run", run({ kind: "analyze" })],
    [
      "a run that starts after transcribing",
      run({
        from_step: "clean_audio",
        steps: [step("clean_audio", "running")],
      }),
    ],
    ["a finished run", run({ status: "ok" })],
    [
      "transcribe_tracks disabled: ingest ok, align_tracks running",
      run({
        skip_steps: ["transcribe_tracks"],
        steps: [step("ingest_tracks", "ok"), step("align_tracks", "running")],
      }),
    ],
    [
      "transcribe_tracks skipped before it is listed",
      run({
        skip_steps: ["transcribe_tracks"],
        steps: [step("ingest_tracks", "ok")],
      }),
    ],
    [
      "transcribe_tracks ok, align_tracks running",
      run({
        steps: [
          step("ingest_tracks", "ok"),
          step("transcribe_tracks", "ok"),
          step("align_tracks", "running"),
        ],
      }),
    ],
    [
      "transcribe_tracks failed",
      run({
        steps: [
          step("ingest_tracks", "ok"),
          step("transcribe_tracks", "error"),
        ],
      }),
    ],
    [
      "a later step listed with no transcribe entry",
      run({
        steps: [step("ingest_tracks", "ok"), step("align_tracks", "running")],
      }),
    ],
  ] as const)("is false for %s", (_name, job) => {
    expect(isTranscribing(job, PATH)).toBe(false);
  });
});
