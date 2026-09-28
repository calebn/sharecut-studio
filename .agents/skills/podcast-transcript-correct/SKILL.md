---
name: podcast-transcript-correct
description: >-
  Quick single-word transcript fixes and low-confidence listing. Use for one-off
  typos. For batches, grammar, or post-precorrect cleanup use
  podcast-transcript-refine; for listen-first ambiguous spans use
  podcast-transcript-audition. Hub: podcast-transcript-workflow.
---

# Transcript correction (quick)

Hub: [podcast-transcript-workflow](../podcast-transcript-workflow/SKILL.md).

For **batches**, grammar review, or post-precorrect work, use **[podcast-transcript-refine](../podcast-transcript-refine/SKILL.md)** (`apply_transcript_cleanup_tool`).

## Tools

- `low_confidence_words_tool(project_path, threshold=0.7)`
- `correct_transcript_tool` / `correct_transcript_phrase_tool` — single fix (one undo step each); pass `expected_text` (the word or phrase text you just read) to refuse the fix if it changed meanwhile (#650)
- `set_word_suppressed_tool` — toggle suppress on one per-track word (same path as Sharecut Studio Suppress/Unsuppress); text only, drops the word from `combined.json`, audio unchanged; pass `expected_text` to refuse the toggle if the word changed meanwhile (#744)
- `set_words_ignored_tool(project_path, track_id, start_word_index, end_word_index, ignored, expected_text=None)` — strike through and mute a word range at render, non-destructively (#633; same path as Sharecut Studio Ignore/Restore). Unlike suppress, ignored words stay in the transcript text; only their audio is muted, computed from the transcript at render and never written to `Clip.mute_regions`. No cut, pending edit, or `EditDecision` is created. Host-only — not available to guests. Pass `expected_text` (the space-joined words you read for this range) to refuse the toggle if those words changed meanwhile (#744).
- `apply_transcript_cleanup_tool` — prefer via refine skill for multi-word batches
- `history_undo` — revert last correction

**CLI:** `podcast transcript correct` (`--expected-text` refuses a fix whose word changed meanwhile, #650), `podcast transcript review`

**Host Sharecut Studio:** Transcript tab → double-click a word, type, Enter (inline; Esc cancels), or **Correct** → click a word → inspector Apply / Suppress / Ignore (document commands; text only for Suppress, audio+text for Ignore, timing unchanged either way). Select mode has an Ignore/Restore toolbar button for a transcript range, and each ignored run gets a hover Restore control. Annotate → **Previous / Next** walks the low-confidence words (with Correct on, each step opens the word in the inspector). Agent listen-first audition stays MCP-only (`podcast-transcript-audition`).

## NL workflow

1. “Show uncertain words” → `low_confidence_words_tool`
2. One word → `search_transcript_tool` → `correct_transcript_tool`, passing `expected_text` set to the matched word; on a "changed since this correction started" error, search again and retry with the current text
3. More than one word → switch to **podcast-transcript-refine**

Corrections update `episode.project.json` only; audio is unchanged.
