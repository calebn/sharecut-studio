---
name: podcast-speaker-attribution
description: >-
  FOSS speaker embedding enrollment and bleed-window attribution. Use when
  reconcile tags bleed but cross-track text differs, or to debug attribution
  with podcast speaker CLI/MCP tools — not the acoustic stem gate
  (podcast-mute-bleed) or reconcile flags alone (podcast-transcript-reconcile).
---

# Speaker attribution

## Same-room bleed vs RMS reconcile

Reconcile tags bleed by **which mic is louder** (RMS dominance). Same-room recording needs **who is speaking** via enrolled ECAPA profiles. Use `gate-track` + bleed-mute to cut each stem down to the home speaker — not unsupervised diarization.

## When precorrect runs speaker pass

- `analysis.speaker_id.mode: auto` (default) and bleed count/ratio exceeds thresholds
- `mode: always` forces the pass
- `mode: never` — skip entirely; precorrect emits a skip message

## Ask for speaker count (interactive)

Before enroll/compare on a new episode, ask how many distinct speakers (and names if easy). Persist with `podcast speaker set-speaker-count --speakers N` or MCP `speaker_set_count_tool`. Batch pipeline infers from dialogue track count when unset — never block overnight runs.

## Standalone vs precorrect

| Situation | Action |
|-----------|--------|
| Normal episode pipeline | Let `precorrect_transcript` gate speaker pass |
| Same-room bleed cleanup | `enroll` → `gate-track --apply` → [podcast-mute-bleed](podcast-mute-bleed/SKILL.md) |
| Compare all tracks at one moment | `podcast speaker compare --start X --end Y` |
| Two people on one mic | `enroll --speaker A --track T --start … --end …` (repeat per person) |
| Debug one window | `podcast speaker score` or `speaker_score_tool` |
| Re-build profiles after stem change | `podcast speaker enroll` then `gate-track --dry-run` |
| No torch installed | Skip; precorrect continues with glossary + cross-track |

## Commands

```bash
podcast speaker doctor
podcast speaker enroll --project PATH [--track ID]
podcast speaker enroll --project PATH --speaker NAME --track T --start S --end E
podcast speaker compare --project PATH --start S --end E
podcast speaker gate-track --project PATH --dry-run
podcast speaker gate-track --project PATH --apply
podcast speaker label --project PATH --track T --start S --end E --dry-run
podcast speaker set-speaker-count --project PATH --speakers N
podcast speaker attribute --project PATH --dry-run
```

Progress is automatic on MCP/CLI (relay tool headlines; do not invent status). Spec: [docs/progress.md](../../docs/progress.md). Long CLI attribute/gate passes: `--json-progress`.

## MCP

`speaker_enroll_tool`, `speaker_compare_window_tool`, `speaker_compare_pair_tool`, `speaker_gate_track_tool`, `speaker_label_tool`, `speaker_set_count_tool`, `speaker_attribute_tool`, `speaker_score_tool`, `speaker_profiles_tool`, `speaker_doctor_tool`

## Hand off to audition

When margin is below `min_margin` or text remains ambiguous after attribution, add items to the precorrect deferred queue and use [podcast-transcript-audition](podcast-transcript-audition/SKILL.md).

After `gate-track`, run [podcast-mute-bleed](podcast-mute-bleed/SKILL.md) so stems gate acoustically; speaker gap protection keeps owner speech across short holes between words.
