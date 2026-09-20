---
name: podcast-transcript-precorrect
description: >-
  Offline transcript precorrect: glossary replacements, optional speaker
  attribution, cross-track text sync, unified report. Layer 2 — after reconcile,
  before podcast-transcript-refine. Use for rule-based cleanup, not agent grammar
  passes (refine) or single-word fixes (podcast-transcript-correct). Hub:
  podcast-transcript-workflow.
---

# Transcript precorrect

Hub: [podcast-transcript-workflow](../podcast-transcript-workflow/SKILL.md). **Layer 2 (rules)** — no agent judgment.

Prerequisite: `{workspace}/show_glossary.yaml` for show-specific replacements.

## When to run

After pass 1 `reconcile_transcript` (stems from `render_dialogue_stems` exist). Before **podcast-transcript-refine** agent gate.

```bash
podcast transcript context set --project PATH --show-title "..." --term "..." --guest-name "..."
podcast transcript precorrect --project PATH --dry-run
podcast transcript precorrect --project PATH --apply
```

Progress is automatic on MCP/CLI (relay tool headlines; do not invent status). Spec: [docs/progress.md](../../docs/progress.md). Long CLI runs: `--json-progress` ([cli-progress.md](../../docs/cli-progress.md)).

## Pipeline

`precorrect_transcript` runs once in full pipeline — after pass 1 `reconcile_transcript`, before `require_transcript_refine`. Apply resets refine status to **pending**.

## MCP

`precorrect_transcript_tool(project_path, dry_run=True)`

## Cross-track sync (after reconcile)

`run_cross_track_sync` copies text from the audibility winner to the loser when:

- Words overlap in time (`min_overlap_sec`, default 0.2 s)
- Text similarity ≥ `min_similarity` (default 0.55) — identical tokens or high `SequenceMatcher` ratio; substring floor does **not** apply to short tokens inside longer ones (e.g. `"I"` / `"talking"`)
- Durations are compatible (`max_duration_ratio` / `max_word_duration_sec`) unless overlap covers most of both words
- Winner is unambiguous: audibility score + confidence margin ≥ `confidence_margin` (default 0.15)

**Common blockers:** all overlap pairs are `text_match` (nothing to fix); similarity too low (deferred); duration mismatch (deferred); both tracks `audible` with tied confidence (`ambiguous_audibility`). For CI gold, `synthetic_bleed_60s` includes a deliberate `todae`/`today` pair at 10 s with lower host confidence so cross-track applies once.

See [docs/transcript-precorrect.md](../../docs/transcript-precorrect.md#cross-track-sync).

## Output

`artifacts/transcript_precorrect_report.json` — hand off `deferred_queue` to [podcast-transcript-refine](../podcast-transcript-refine/SKILL.md).

Optional speaker detail: [podcast-speaker-attribution](../podcast-speaker-attribution/SKILL.md).
