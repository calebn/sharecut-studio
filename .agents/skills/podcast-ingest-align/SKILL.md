---
name: podcast-ingest-align
description: >-
  Session-clock concepts and anchor-based fine-tune for remote multitrack
  ingest when files differ in length and record start/stop. Prefer
  podcast-align-audio for the day-to-day suggest → verify → play --compare
  workflow. Use this skill for fixture builds or when speakers talk over each
  other in the premix and you need timeline-model detail.
---

# Ingest alignment (remote multitrack)

> **Preferred workflow:** use `.agents/skills/podcast-align-audio/SKILL.md` for suggest → verify → `play --compare`. This skill documents session-clock concepts and anchor-based fine-tune.

## The model

Each speaker has **their own file** with its own **start/stop** (Zoom, Riverside, local recorders). Files are **different lengths**.

Ingest must map everything to one **session timeline** (podcast real time):

| Concept | Meaning |
|---------|---------|
| **Session t=0** | Chosen on the **reference** speaker's file (first speaker unless `session.reference_speaker`) |
| **`session_start_in_file_sec`** | File timestamp where session t=0 lives on that recorder (guest often **> 0** if they pressed record late) |
| **`extract_start`** | Session time where the episode clip begins (same moment for all speakers) |
| **`content_align_sec`** | Fine-tune from transcript anchors (optional) |

**Trim formula:** `file_trim = session_start_in_file_sec + extract_start - content_align_sec`

Do **not** use the same file timestamp on every recorder without `session_start_in_file_sec`.

## Workflow

1. **One source file per speaker** in `ingest.yaml` — draft it with **`podcast ingest import DIR`** from a generic recorder export folder (audio-only; review labels) or author by hand.
2. Run **`podcast ingest suggest`** on the opening (or your analysis window) — see `podcast-align-audio`.
3. **Provisional extract + transcribe** each dialogue track when using anchors.
4. Add **`align_anchors`** (host phrase → guest phrase after it).
5. **Re-consolidate** with `--transcript` and `--align-mode transcript`. Untrimmed consolidates place clips by session offset (`source_start`/`timeline_start`); verify reads tracks through those clips.
6. **Listen** — premix and solos on the same `--start` / `--end`.

```yaml
session:
  reference_speaker: Rehana
  hint_sec: 960

speakers:
  - name: Rehana
    sources: ["1 audioRehanaMorita....aif"]
    session_start_in_file_sec: 0
  - name: Speaker 2
    sources: ["Untitled#04.wav"]
    # session_start_in_file_sec auto-detected if omitted

align_anchors:
  - reference_speaker: Rehana
    reference_contains: palestinian
    source_speaker: Speaker 2
    source_contains: family
    gap_sec: 1.0
```

```bash
podcast ingest report \
  --audio-dir "$PODCAST_AUDIO_DIR" \
  --manifest ingest.yaml \
  --analysis-start 960 --analysis-duration 60

podcast ingest consolidate \
  --audio-dir "$PODCAST_AUDIO_DIR" \
  --manifest ingest.yaml \
  --project episode.project.json \
  --extract-start 960 --extract-duration 60 \
  --transcript path/to/per_track.json \
  --align-mode transcript
```

Check JSON: `session_start_in_file_sec`, `extract_trim_start_sec`, `align_method`.

## Mic bleed

Remote tracks often **bleed** the other speaker. Both waveforms can be "hot" at once even when only one person is talking. Prefer **transcript anchors** (who said what) over waveform overlap minimization.

## Tools

- `docs/multitrack-ingest.md` — CLI reference
- E2E project: `tests/fixtures/aligned_dialogue/episode.project.json`

## After alignment changes

Re-transcribe dialogue tracks; old word timestamps do not move with new trims.
