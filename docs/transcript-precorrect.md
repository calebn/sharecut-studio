# Transcript precorrect

Offline transcript cleanup runs **after** `reconcile_transcript` and **before** interactive editing.

## Pipeline step

```
render_dialogue_stems
reconcile_transcript      # pass 1
precorrect_transcript     # glossary → speaker (gated) → cross-track → report
require_transcript_refine # agent refine-done / waive (or --unattended)
analyze_focus_cuts
...
```

Precorrect `--apply` resets `artifacts/transcript_refine_status.json` to **pending**.

See [transcript-workflow.md](transcript-workflow.md).

Or run manually:

```bash
podcast transcript precorrect --project episode.project.json --dry-run
podcast transcript precorrect --project episode.project.json --apply
```

Use `--json-progress` on long episodes; progress events use `task_id` values documented in [cli-progress.md](cli-progress.md). Parent contract: [progress.md](progress.md).

## Configuration

Three layers (merged in order):

1. `.agents/defaults/transcript_glossary.yaml` — global filler denylist, thresholds
2. `{workspace}/show_glossary.yaml` — show title, recurring terms, replacements
3. `{workspace}/transcript_context.yaml` — guest names, skip spans, per-episode overrides

```bash
podcast transcript context show --project episode.project.json
podcast transcript context set --project episode.project.json --show-title "My Show" --term "Guest Name"
podcast transcript context set --project episode.project.json --file context.yaml
```

## Report

`artifacts/transcript_precorrect_report.json` contains:

- `glossary` — replacement candidates or applied fixes
- `speaker_attribution` — enrollment/attribution summary (skipped when gated off)
- `cross_track` — text sync fixes and deferred low-similarity pairs
- `deferred_queue` — items for interactive cleanup (`low_similarity`, `anomalous_word_duration`, …)
- `garble_hits` — regex pattern matches still present

## Cross-track sync

Runs after glossary and optional speaker pass. Uses `overlap_duplicate_report` pairs where text **does not** already match.

| Setting (`transcript_context.yaml` → `cross_track`) | Default | Effect |
|-----------------------------------------------------|---------|--------|
| `min_overlap_sec` | 0.2 | Minimum temporal overlap |
| `min_similarity` | 0.55 | Token match or SequenceMatcher ratio; character-substring floor of 0.55 only when token length ratio ≥ `min_substring_len_ratio` (blocks `"i"` ⊂ `"talking"`) |
| `min_substring_len_ratio` | 0.6 | Required `min(len)/max(len)` for substring boost |
| `max_duration_ratio` | 4.0 | Skip rewrite when one word is much longer than the other (unless overlap covers ≥ `min_overlap_of_both_frac` of **both**) |
| `max_word_duration_sec` | 2.0 | Skip rewrite when either word exceeds this unless both are well-covered by overlap (same default as `max_word_audibility_sec`) |
| `min_overlap_of_both_frac` | 0.5 | Overlap-as-fraction-of-each-word escape hatch for the duration gates |
| `confidence_margin` | 0.15 | Winner = higher audibility score + word confidence |

Winner audibility scores: `audible` (3) &gt; `deferred` (2) &gt; `bleed` (1) &gt; `inaudible` (0). Tied totals → deferred as `ambiguous_audibility`. Duration mismatches → deferred as `duration_mismatch` (refine can still review). Stretched ASR words (`end - start` &gt; `max_word_audibility_sec`) are also enqueued as `anomalous_word_duration` without rewriting timestamps.

**Prerequisites:** `reconcile_transcript` with `transcript_mode: reconcile` so bleed/audibility metadata exists. Overlap alone is not enough — similar but mismatched text (e.g. ASR `todae` vs `today`) is the typical fix target.

Regression: `tests/e2e/test_synthetic_bleed_precorrect.py` on `synthetic_bleed_60s`.

## Interactive follow-up

Start [podcast-transcript-refine](../.agents/skills/podcast-transcript-refine/SKILL.md) from the deferred queue, not a full-episode scan.

Reconcile tuning (bleed before precorrect): [transcript-reconcile.md](transcript-reconcile.md).

Optional speaker debugging: [speaker-attribution.md](speaker-attribution.md).
