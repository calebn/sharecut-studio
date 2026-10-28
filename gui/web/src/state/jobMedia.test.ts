import { describe, expect, it } from "vitest";
import { runIncludesTranscribe } from "./jobMedia";

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
