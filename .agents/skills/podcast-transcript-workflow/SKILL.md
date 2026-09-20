---
name: podcast-transcript-workflow
description: >-
  Hub for transcript quality: acoustic reconcile, rule-based precorrect, agent
  refine, and listen-first audition. Use when cleaning transcripts, fixing bleed,
  or before focus/tighten/NL edits — read this first for layer order and pipeline
  gates. Layer skills are podcast-transcript-reconcile, -precorrect, -refine,
  -audition, -correct (not this hub for a single-layer task).
---

# Transcript workflow (hub)

Read **[docs/transcript-workflow.md](../../docs/transcript-workflow.md)** for the full operator guide.

## Four layers (in order)

| # | Layer | Skill | Pipeline step(s) |
|---|-------|-------|------------------|
| 1 | Acoustic — suppress bleed/inaudible | **podcast-transcript-reconcile** | `reconcile_transcript` (after `render_dialogue_stems` and after `assemble_timeline`) |
| 2 | Rules — glossary, cross-track | **podcast-transcript-precorrect** | `precorrect_transcript` (once, after pass 1 reconcile) |
| 3 | Refine — context/grammar fixes | **podcast-transcript-refine** | `require_transcript_refine` (agent clears via `refine-done`) |
| 4 | Escalate — one span, listen-first | **podcast-transcript-audition** | On demand from refine |

Quick single-word fix: **podcast-transcript-correct** (use refine for batches).

## Full pipeline checkpoint

```
transcribe → merge → render_dialogue_stems → reconcile → precorrect
→ require_transcript_refine [YOU: refine → refine-done]
→ focus / tighten / NL edits → FX → assemble → reconcile → export
```

Do **not** run focus, tighten, or narrative cuts until refine status is **done** or explicitly **waived**. Unattended batch runs (`--unattended` / `PODCAST_BATCH=1`) auto-waive when mode is `waive_unattended`.

## What reconcile does / does not

- **Does:** Hide bleed/inaudible words from `combined.json` (metadata only; audio unchanged). Identical overlap dupes → `text_match_count == 0` after reconcile.
- **Does not:** Fix ASR text on audible words — use precorrect + refine.
- **Audio follow-up:** After transcript is clean, **podcast-mute-bleed** gates stems from non-suppressed intervals.

## Workspace setup

```bash
podcast transcript context set --project PATH --show-title "..." --guest-name "..." --term "..."
```

Add `{workspace}/show_glossary.yaml` for show-specific replacements (see doc examples).

## Decision tree

| Problem | Go to |
|---------|-------|
| Bleed / wrong track audible | reconcile → audition if ambiguous |
| Cross-track word mismatch | precorrect report → refine |
| Stretched ASR token / missing words in a long span | `transcript_timing.json` + deferred `anomalous_word_duration` → refine / audition (do **not** clamp times) |
| Episode name / Spanish garble | show_glossary → precorrect → refine |
| Low-confidence / grammar | refine → audition |
| One unclear span | audition only |

## Handoffs

- After precorrect: **podcast-transcript-refine** (`refine-brief` → episode pass → `refine-done`)
- After refine: **podcast-focus-episode**, **podcast-tighten-dialogue**, **podcast-edit-natural-language**
- Stale audibility after FX: `reconcile_transcript` (pass 2 in full pipeline) or `render_preview`
