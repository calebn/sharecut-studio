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
- `correct_transcript_tool` / `correct_transcript_phrase_tool` — single fix (one undo step each)
- `set_word_suppressed_tool` — toggle suppress on one per-track word (same path as Sharecut Studio Suppress/Unsuppress)
- `apply_transcript_cleanup_tool` — prefer via refine skill for multi-word batches
- `history_undo` — revert last correction

**CLI:** `podcast transcript correct`, `podcast transcript review`

**Host Sharecut Studio:** Transcript tab → **Edit** → click a word → inspector Apply / Suppress (document commands). Agent listen-first audition stays MCP-only (`podcast-transcript-audition`).

## NL workflow

1. “Show uncertain words” → `low_confidence_words_tool`
2. One word → `search_transcript_tool` → `correct_transcript_tool`
3. More than one word → switch to **podcast-transcript-refine**

Corrections update `episode.project.json` only; audio is unchanged.
