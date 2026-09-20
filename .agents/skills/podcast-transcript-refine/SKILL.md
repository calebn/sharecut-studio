---
name: podcast-transcript-refine
description: >-
  Agent transcript text refinement after precorrect: whole-episode context pass,
  deferred queue, low-confidence batches, user confirmation. Marks
  require_transcript_refine done. Use after reconcile + precorrect and before
  focus/tighten/NL edits. Does not handle bleed suppression (podcast-transcript-reconcile)
  or listen-first one-span decisions (podcast-transcript-audition). Hub:
  podcast-transcript-workflow.
---

# Transcript refine (agent layer)

Text fixes **without changing audio**. Hard pipeline gate: **`require_transcript_refine`**
after **`precorrect_transcript`**, before **focus / tighten / NL editing**.

Hub: [podcast-transcript-workflow](../podcast-transcript-workflow/SKILL.md). Bleed: [podcast-transcript-reconcile](../podcast-transcript-reconcile/SKILL.md) only.

## Gate (required)

Interactive / MCP sessions **must** clear the gate before narrative edits:

| Command / tool | Purpose |
|----------------|---------|
| `transcript refine-status` / `transcript_refine_status_tool` | pending / done / waived + fingerprint |
| `transcript refine-brief` / `transcript_refine_brief_tool` | Context pack for the episode pass |
| `transcript refine-done` / `transcript_refine_done_tool` | Mark complete after refine |
| `transcript refine-waive --reason …` / `transcript_refine_waive_tool` | Explicit skip (user/agent) |

Precorrect `--apply` resets status to **pending**. Unattended pipelines (`PODCAST_BATCH=1` or `podcast pipeline run --unattended`) auto-waive when `analysis.transcript_refine.mode` is `waive_unattended` (default). Agents must **not** set unattended flags — do the episode pass, then `refine-done`.

## Non-destructive / undo

| Apply path | Undo steps |
|------------|------------|
| `apply_transcript_cleanup_tool` | **1 per batch** (preferred) |
| `verify_transcript_tool` | 1 per batch (words only) |
| `correct_transcript_phrase_tool` | 1 per phrase |
| `correct_transcript_tool` | 1 per word (avoid many) |

Never call `correct_word` / `correct_phrase` outside `ProjectWorkspace.mutate`.

## Tools

| Tool | Use |
|------|-----|
| `transcript_refine_brief_tool` | Start here — glossary, deferred/garble counts, combined path |
| `low_confidence_words_tool` | Work queue (`threshold` 0.35–0.7) |
| `search_transcript_tool` | Find garbled patterns before fixing |
| `apply_transcript_cleanup_tool` | Batch words + phrases (one undo step) |
| `play_audio_tool` / `play_transcript_query_tool` | Audition before proposing |
| `history_undo` | Revert last batch |
| `transcript_refine_done_tool` | Clear the hard gate |

Bleed triage belongs in **reconcile**, not here. Do not reopen ownership of suppressed bleed words.

## Phase 0 — Brief + context

```bash
podcast transcript refine-brief --project PATH
podcast transcript refine-status --project PATH
```

Ensure `show_glossary.yaml` / `transcript_context.yaml` exist (see [docs/transcript-workflow.md](../../docs/transcript-workflow.md)).

## Phase 1 — Whole-episode pass (required)

Read combined dialogue (or timestamps). Infer theme, speakers, recurring names, Spanglish, show terms. Batch **high-confidence** glossary/context fixes first (show title, guest names, episode titles, verified public facts).

**Never auto-fix:** homophones without context, unknown person names, intentional Spanglish/slang.

## Phase 2 — Precorrect report queues

Read `artifacts/transcript_precorrect_report.json`:

- Work `deferred_queue` and `garble_hits`
- Do not rescan the whole episode for cross-track fixes precorrect already attempted

## Phase 3 — Batched user review

Present **5–15 items**:

```markdown
### Batch N

| # | Track | Time | Heard | Proposed | Why |
|---|-------|------|-------|----------|-----|
| 1 | vicky | 104s | Budapest Party | Puro Pinché Party | show_glossary / guided baseline |
```

Stop and wait for flagged rows before `apply_transcript_cleanup_tool`.

## Phase 4 — Escalate to audition

For bleed-overlap homophones or both tracks garble differently, hand off to [podcast-transcript-audition](../podcast-transcript-audition/SKILL.md) — **one issue per turn**.

## Apply, verify, clear gate

1. One `apply_transcript_cleanup_tool` per track per approved batch
2. `search_transcript_tool` for old garbled strings — zero hits
3. Spot-check `transcripts/combined.json`
4. **`transcript_refine_done_tool`** (or CLI `refine-done`) with a short notes summary

## Common patterns (Shot of Truth–style)

| ASR error | Likely fix |
|-----------|------------|
| Charter Truth / shot shoot podcast | Shot of Truth Podcast |
| Budapest Party | Puro Pinché Party |
| port de Vanda / port the weather | port de verdad |
| in sight fear | inciting fear |
| wazoo | Wazzu |
| Deferred `anomalous_word_duration` (multi-second token) | Listen to the full `[start,end)` span; restore missing words — do **not** invent tighter ASR ends |

Add episode-specific entries to `show_glossary.yaml`.

## Pair with

- **Before:** podcast-transcript-workflow, podcast-transcript-precorrect
- **After:** podcast-focus-episode, podcast-tighten-dialogue, podcast-edit-natural-language
- **Escalation:** podcast-transcript-audition
