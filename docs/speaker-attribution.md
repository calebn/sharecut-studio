# Speaker attribution

Optional FOSS speaker embedding for standalone recognition and same-room bleed cleanup.

Bleed reconcile tags words by **RMS dominance** (which mic is louder). Same-room recording often needs **speaker identity** (whose voice is this?) via enrolled ECAPA profiles. This is verification, not unsupervised diarization.

## Install

```bash
pip install -e ".[speaker]"      # SpeechBrain ECAPA (primary)
pip install -e ".[speaker-lite]"  # Resemblyzer fallback
```

## Standalone CLI

```bash
podcast speaker doctor
podcast speaker enroll --project episode.project.json
podcast speaker enroll --project PATH --speaker NAME --track T --start 10 --end 40
podcast speaker profiles --project episode.project.json
podcast speaker score --project PATH --track host --start 10 --end 12
podcast speaker compare --project PATH --start 978.65 --end 979.49
podcast speaker compare --project PATH --track-a host --start-a 10 --end-a 12 \
  --track-b guest --start-b 20 --end-b 22
podcast speaker label --project PATH --track host --start 10 --end 12 --dry-run
podcast speaker gate-track --project PATH --dry-run
podcast speaker gate-track --project PATH --apply
podcast speaker set-speaker-count --project PATH --speakers 2
podcast speaker attribute --project episode.project.json --dry-run
podcast speaker attribute --project episode.project.json --apply
```

`compare --start/--end` scores every dialogue stem at the same source window and returns `own` / `bleed` / `uncertain` roles. Pair mode (`--track-a` / `--track-b`) compares two windows A/B.

`gate-track` slides windows over speech regions and suppresses non-home speaker spans (primary path for same-room bleed). Then run bleed-mute to gate stems acoustically.

Long runs support `--json-progress` (`speaker-enroll`, `speaker-attribute`, `speaker-gate` task IDs). Parent contract: [progress.md](progress.md).

## Enrollment audio source

Enrollment and scoring prefer processed stems `artifacts/tracks/{id}.wav` when present (same audio bleed-mute gates). Otherwise raw `track.media.path`. Re-enroll after FX or stem edits; stale profiles (stem hash mismatch) are skipped automatically.

Prefer segment enroll from clean owner-only spans when auto-enroll would bake bleed into the profile.

## Known speaker count

Store `analysis.speaker_id.expected_speaker_count` in `transcript_context.yaml` (or `podcast speaker set-speaker-count`). Agents should ask the user when reachable; batch pipeline infers from dialogue track count when unset. Home-gate warns when distinct winning identities exceed the expected count.

## Multi-speaker on one track

Enroll segment profiles with distinct `speaker_id` values and optional `--home-track` for bleed attribution. `label` applies `speaker_match_*` on overlapping words.

## When the pipeline runs it

Inside `precorrect_transcript` when `analysis.speaker_id.mode` is `auto` (product default) or `always` and bleed thresholds are met. `never` skips entirely (CI / no torch).

```yaml
analysis:
  speaker_id:
    mode: auto
    bleed_word_threshold: 50
    bleed_ratio_threshold: 0.02
    max_speaker_gap_sec: 0.55
    gate_window_sec: 0.75
    gate_hop_sec: 0.25
```

Bleed mute uses enrolled profiles to keep owner speech open across short inter-word gaps when `max_speaker_gap_sec` > 0. Filler/NL cuts skip bleed-labelled spans and force track-local scope when speaker role is `bleed`.

## Same-room workflow

1. `podcast speaker enroll` (segment enroll from clean owner spans when possible)
2. `podcast speaker gate-track --dry-run` then `--apply`
3. `podcast edit apply-bleed-mute` — gate stems to non-suppressed intervals
4. Solo-audition with `play --source processed:TRACK`

## MCP

- `speaker_doctor_tool`
- `speaker_enroll_tool` (optional `speaker_id`, `start_sec`, `end_sec`, `home_track_id`)
- `speaker_profiles_tool`
- `speaker_score_tool`
- `speaker_compare_window_tool`
- `speaker_compare_pair_tool`
- `speaker_label_tool`
- `speaker_gate_track_tool`
- `speaker_set_count_tool`
- `speaker_attribute_tool`

`audition_context` (`detail=full` or `visual`) adds `speaker_roles` when profiles exist (uses the real speaker backend when installed).

## Prove-out

Integration tests marked `@pytest.mark.speaker` require `[speaker]`. On real fixtures, verify `compare` discriminates known bleed windows before claiming cleanup success.
