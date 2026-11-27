export type ReadyRowId = "add" | "transcribe" | "align" | "clean" | "suggest";

export const ROW_ORDER: readonly ReadyRowId[] = [
  "add",
  "transcribe",
  "align",
  "clean",
  "suggest",
];

/** The row each pipeline step belongs to (spec INT-PREPARE-RUN). */
export const ROW_STEPS: Readonly<Record<ReadyRowId, readonly string[]>> = {
  add: ["ingest_tracks"],
  transcribe: ["transcribe_tracks"],
  align: [
    "align_tracks",
    "require_align_accept",
    "merge_transcript",
    "render_dialogue_stems",
    "reconcile_transcript",
    "precorrect_transcript",
  ],
  clean: [
    "extract_room_tone_beds",
    "fill_gate_holes",
    "clean_audio",
    "compress_tracks",
    "balance_tracks",
    "assemble_timeline",
  ],
  suggest: ["analyze_fillers_pauses", "apply_sound_actions"],
};

export const RUN_WINDOW_ROW: Readonly<Record<string, ReadyRowId>> = {
  extract_room_tone_beds: "align",
};

export function ownerRow(step: string): ReadyRowId | undefined {
  return ROW_ORDER.find((id) => ROW_STEPS[id].includes(step));
}

export const ROW_ACTIVITY: Readonly<Record<ReadyRowId, string>> = {
  add: "Adding audio",
  transcribe: "Transcribing",
  align: "Lining up tracks",
  clean: "Cleaning",
  suggest: "Finding suggestions",
};

/** What the row a step runs in is doing, for lines that must not name the step. */
export function stepActivity(step: string): string | undefined {
  const row = RUN_WINDOW_ROW[step] ?? ownerRow(step);
  return row === undefined || row === "add" ? undefined : ROW_ACTIVITY[row];
}
