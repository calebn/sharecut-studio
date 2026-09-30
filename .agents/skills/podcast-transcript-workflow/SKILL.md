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
| 1 | Acoustic — suppress bleed/inaudible | **podcast-transcript-reconcile** | `reconcile_transcript` (after `render_dialogue_stems` and after `assemble_timeline`; raw media is mapped through `SessionTimeline` when stems are absent) |
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

- **Does:** Hide bleed/inaudible words from `combined.json` (metadata only; audio unchanged). Identical overlap dupes on a measured bleed pair → `text_match_count == 0` there after reconcile; the source mic wins by lag, identical words at another spacing both stay, and pairs with no measured path are never text-matched (#774).
- **Silence hallucinations:** ASR uses VAD; words over digital silence carry `suspect_hallucination` (with the forced aligner, on by default once downloaded, also words it places with no acoustic evidence, i.e. `alignment_score` below `transcribe.forced_alignment.min_word_score` **and** the word's own track quiet over the span or another dialogue lane louder there; a low score alone never flags, #780). Peer evidence follows the lane clip's selected `source_id` and offset. A missing selected source is unknown evidence. A low score alone never flags; see [the transcript workflow guide](../../docs/transcript-workflow.md) for the evidence and cache rules. The flag does not filter audio. Find flagged words in `transcript_refine_brief_tool` (`suspect_hallucination_open_words` / `suspect_hallucination_sample`) or Studio Annotate, and suppress real hallucinations with `set_word_suppressed_tool`.
- **Does not:** Fix ASR text on audible words — use precorrect + refine.
- **Audio follow-up:** After transcript is clean, **podcast-mute-bleed** gates stems from non-suppressed intervals.

Pipeline, CLI `podcast transcribe`, and MCP `transcribe_track` use the same
`transcribe.language` setting, `en` by default. Set it to YAML `null` in pipeline
configuration for auto-detection. Language remains part of the ASR cache key.

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
| Stretched ASR token / missing words in a long span | `transcript_timing.json` + deferred `anomalous_word_duration` → refine / audition (do **not** clamp times) (with the word aligner installed most words are re-timed by default; the deferred flag remains the backstop on what the aligner leaves) |
| Word times are Whisper-only (`transcripts[].word_aligner: null`; `audition_context_tool` `limits` has `whisper_word_times`; summary says "forced alignment unavailable") | `podcast bootstrap --component word-aligner`, then Studio **Re-time words** / `pipeline run --retime-words`; until then treat word edges as approximate (measured 120 ms early at a lab cut, #775) and audition cut points (#780) |
| Episode name / Spanish garble | show_glossary → precorrect → refine |
| Low-confidence / grammar | refine → audition |
| One unclear span | audition only |

## Handoffs

- After precorrect: **podcast-transcript-refine** (`refine-brief` → episode pass → `refine-done`)
- After refine: **podcast-focus-episode**, **podcast-tighten-dialogue**, **podcast-edit-natural-language**
- Stale audibility after FX: `reconcile_transcript` (pass 2 in full pipeline) or `render_preview`
