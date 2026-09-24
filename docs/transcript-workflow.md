# Transcript workflow

Canonical guide for transcript quality: when each layer runs, what it fixes, and how it fits the pipeline.

Deep dives: [transcript-reconcile.md](transcript-reconcile.md), [transcript-precorrect.md](transcript-precorrect.md).

Agent skill hub: [.agents/skills/podcast-transcript-workflow/SKILL.md](../.agents/skills/podcast-transcript-workflow/SKILL.md).

## Four layers

| Layer | What it does | Changes text? | Changes audio? | Skill |
|-------|----------------|---------------|----------------|-------|
| **1. Acoustic** | Word-level RMS; tag bleed/inaudible; suppress in combined | No | No | `podcast-transcript-reconcile` |
| **2. Rules** | Glossary, homophones, cross-track sync | Yes (rules) | No | `podcast-transcript-precorrect` |
| **3. Refine** | Agent context/grammar fixes from deferred queue | Yes (reviewed) | No | `podcast-transcript-refine` |
| **4. Escalate** | Listen-first single-span decisions | Yes (one span) | No | `podcast-transcript-audition` |

## Pipeline order

```text
ingest_tracks
transcribe_tracks
merge_transcript
render_dialogue_stems          # pass 1 stems (raw-ish, for audibility)
reconcile_transcript           # pass 1 — suppress bleed/inaudible
precorrect_transcript          # glossary + cross-track + report
require_transcript_refine      # agent: refine-done / waive; --unattended auto-waives
analyze_focus_cuts
focus_from_transcript
analyze_fillers_pauses
tighten_from_transcript
clean_audio
balance_tracks
compress_tracks
assemble_timeline              # final stems (edits + FX)
reconcile_transcript           # pass 2 — post-FX audibility refresh
mix_with_music
master_loudness
export_deliverables
```

`precorrect_transcript` runs **once** (after pass 1 reconcile). Pass 2 reconcile updates suppression metadata only. Precorrect apply resets `artifacts/transcript_refine_status.json` to **pending**.

After a successful unattended pipeline run that executes an active refine gate,
the gate's current `source: unattended` waiver is refreshed if later steps
change suppression metadata without changing transcript text or word structure.
The status must still be the same gate decision at completion; a newer explicit
refine decision wins. Partial runs that skip the gate, runs with refine mode
`off`, pending, done, and explicit user/agent/CLI/MCP waivers remain stale and
require a new intentional refine decision. A lock beside the status file
coordinates status writers across local processes.

In the host GUI, an approval blocked by this gate offers a **Waive with
reason** recovery form. The waiver is recorded as a user decision; it does not
retry or automatically approve the edit. Review the transcript, enter a
non-empty reason, then retry approval intentionally.

Resume examples:

```bash
podcast pipeline run --project episode.project.json --from precorrect_transcript
podcast pipeline run --project episode.project.json --from assemble_timeline   # includes pass 2 reconcile
podcast pipeline run --project episode.project.json --unattended              # auto-waive refine gate
```

## What reconcile fixes (and does not)

**Fixes:** Words tagged `bleed` or `inaudible` get `suppressed: true` and are **omitted** from `combined.json` and search/play gating. Raw per-track JSON still retains all words.

Word times stay in **source-media seconds** at every layer — reconcile, precorrect, and refine never rewrite them onto the edited clock. Audibility RMS and follow-transcript gating map word source spans to timeline seconds through `SessionTimeline` when they read rendered stems (see [episode-format-v2.md § Timebase invariant](episode-format-v2.md#timebase-invariant)).

**ASR timing flags:** After `transcribe_tracks`, words longer than `analysis.heuristics.max_word_audibility_sec` (default **2.0 s**) are soft-marked `audibility_status: deferred` and listed in `artifacts/transcript_timing.json`. Timestamps are **not** clamped — a stretched Whisper token often covers real under-transcribed speech. Precorrect copies those into `deferred_queue` (`kind: anomalous_word_duration`) for refine/audition.

**Does not fix:**

- ASR mishearings on words still marked `audible` (e.g. “Budapest” for “Puro Pinché Party”)
- Wrong speaker attribution when both tracks are loud (dominance below `bleed_dominance_db`)
- Grammar or proper nouns — use precorrect + refine

## Workspace files

| File | Purpose |
|------|---------|
| `{workspace}/show_glossary.yaml` | Show title, recurring terms, replacements |
| `{workspace}/transcript_context.yaml` | Guest names, skip spans, episode overrides |
| `artifacts/transcript_timing.json` | Stretched ASR word flags from transcribe (no time rewrite) |
| `artifacts/transcript_precorrect_report.json` | Glossary/cross-track fixes, `deferred_queue`, `garble_hits` |
| `artifacts/transcript_refine_status.json` | Gate: `pending` / `done` / `waived` + precorrect fingerprint; successful unattended runs that execute the gate refresh only its stale waivers |

The Studio Pipeline tab edits per-project **Terms** and **Guest names** in
`transcript_context.yaml`. These values join the show title in Whisper's
initial prompt for both the Python and whisper.cpp backends. Saving a change
marks the vocabulary as needing transcription;
**Re-transcribe** runs the pipeline from `transcribe_tracks` through downstream
steps. Each transcript stores the vocabulary revision it was produced with. Studio
asks for re-transcription when any transcript differs from the revision in
`transcript_context.yaml`: single-track runs update only that track, a concurrent
edit stays stale, and a project without transcripts never asks. ASR caches
include model, language, and prompt. Because the cache name changed, the first
transcription after upgrading re-runs Whisper once per track; older
`transcripts/{track}_{audio}.json` files are no longer read. The prompt
has a 400-character limit by default, and Studio rejects terms that would be
truncated. This changes future ASR output, not existing transcript words.

Set context before transcribe when possible:

```bash
podcast transcript context set --project episode.project.json \
  --show-title "Shot of Truth Podcast" --guest-name "Olga Araceli" --term "Puro Pinché Party"
```

### Example `show_glossary.yaml`

```yaml
show_title: Shot of Truth Podcast
replacements:
  - match: Budapest Party
    replace: Puro Pinché Party
  - match: shot shoot podcast
    replace: Shot of Truth Podcast
  - match: in sight fear
    replace: inciting fear
  - match: wazoo
    replace: Wazzu
  - match: port the weather
    replace: port de verdad
garble_patterns:
  - Buddha Pachan
  - Charter Truth
```

Show-specific names belong here, not in global `.agents/defaults/transcript_glossary.yaml`.

## Agent gate (`require_transcript_refine`)

After `precorrect_transcript`, the pipeline step **`require_transcript_refine`** blocks until status is **done** or **waived** (fingerprint must match the latest precorrect apply).

1. `transcript refine-brief` / `transcript_refine_brief_tool`
2. Whole-episode context pass + `deferred_queue` / `garble_hits` (skill **podcast-transcript-refine**)
3. Apply high-confidence fixes; batch ambiguous items for user
4. Escalate listen-first spans to **podcast-transcript-audition**
5. `transcript refine-done` (or user `refine-waive --reason …`)

Mode (`analysis.transcript_refine.mode` in pipeline.yaml):

| Mode | Behavior |
|------|----------|
| `waive_unattended` (default) | Hard-fail interactive/MCP; auto-waive when `PODCAST_BATCH=1` or `--unattended` |
| `require` | Always hard-fail until done/waived |
| `off` | Skip the gate step |

Focus/tighten/NL service entry points also call the same assert so agents cannot bypass via direct tools.

## Decision tree

| Symptom | Layer |
|---------|-------|
| Wrong speaker’s words on a track | Reconcile (bleed suppress); audition if dominance ambiguous |
| Same moment, different words on two tracks | Precorrect cross-track sync, then refine |
| Garbled proper noun / episode title | `show_glossary.yaml` → precorrect → refine |
| Low-confidence word, grammar unclear | Refine batch → audition |
| Single ambiguous span | Audition only |

## Troubleshooting

**Zero bleed words during known cross-talk** — See [transcript-reconcile.md](transcript-reconcile.md#debugging-no-bleed-words). Check stem freshness after `render_dialogue_stems`.

**Focus theme wrong / “Budapest” in outline** — Precorrect + agent refine were skipped or `show_glossary.yaml` missing.

**Reconciliation stale** — Run `assemble_timeline` or `render_preview` after FX/edits; pass 2 reconcile runs automatically in full pipeline.

**Optional second precorrect** — Only if FX materially changes cross-track overlap text; not part of default pipeline.
