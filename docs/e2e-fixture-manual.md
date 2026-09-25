# E2E fixture manual listen-through

Commands assume `podcast` is on your PATH from the project venv.

## Fixture paths

| Fixture | Path | Use |
|---------|------|-----|
| `aligned_dialogue` | `tests/fixtures/aligned_dialogue/episode.project.json` | Smoke, NL edit, social; waveform pyramids build on demand (nothing tracked under `artifacts/`) |
| `synthetic_bleed_60s` | `tests/fixtures/synthetic_bleed_60s/episode.project.json` | Bleed/reconcile gold |
| `ami_bleed_60s` | `tests/fixtures/ami_bleed_60s/episode.project.json` | AMI overlap realism |
| `audition_defects` | `tests/fixtures/audition_defects/` (audio generated at test time) | Hum / clipping / skew hypothesis eval |

```bash
PROJECT=tests/fixtures/aligned_dialogue/episode.project.json
BLEED=tests/fixtures/synthetic_bleed_60s/episode.project.json
AMI=tests/fixtures/ami_bleed_60s/episode.project.json
```

Bleed fixtures need **reconcile** pipeline defaults (not the flag-only e2e yaml):

```bash
export PODCAST_MCP_PIPELINE_DEFAULTS=tests/fixtures/synthetic_bleed_e2e_pipeline.yaml
```

Seed canned transcript for NL/social steps without live transcribe:

```bash
podcast fixture seed-transcript --project "$PROJECT" \
  --from tests/fixtures/canned_transcript_aligned.json
```

Known search phrases: `documented`, `people`, `today`, `going`, `great`.

---

## Checklist

| # | Scenario | Prepare | Listen | Expected |
|---|----------|---------|--------|----------|
| 1 | Aligned dialogue | Use repo fixture | `podcast play --project "$PROJECT" --source track:reference --start 0 --end 15` | Raw dialogue (no FX) |
| 1 | | | `podcast play --project "$PROJECT" --source processed:guest --start 0 --end 15` | Processed solo |
| 1 | | | `podcast play --project "$PROJECT" --compare --start 18 --end 28` | Both tracks + premix |
| 1 | | | `podcast play compose --project "$PROJECT" --track-ids reference,guest --tier processed --start 18 --end 28 --dry-run` | Subset mix WAV under `play_cache` |
| 2 | Alignment | — | Play both tracks with identical `--start` / `--end` | Same words, minimal drift |
| 3 | Transcribe (slow) | `podcast transcribe --project "$PROJECT"` | `podcast play --project "$PROJECT" --query documented` | Phrase audible in padding |
| 4 | NL cut | `fixture seed-transcript` → `edit cut-text --query um` → `edit approve` → `render-preview` | `processed:<id>` or premix before/after at cut region | After: tighter gap / shorter segment |
| 5 | Undo | `undo --rerender` | Same premix range | Cut restored |
| 6 | Social clip | `clips propose` → `clips approve` → `clips export` | Play exported WAV path from JSON | Isolated highlight |
| 7 | Master export | `pipeline run` (or from `master_loudness`) | `podcast play --project "$PROJECT" --source export --start 0 --end 30` | Full mix |

If audio sounds wrong, re-run with `--dry-run` and inspect the printed WAV path.

---

## Bleed debugging

Use after automated e2e passes or when tuning reconcile heuristics. Operational detail: [transcript-reconcile.md](transcript-reconcile.md).

**Quick start** — prepares stems, prints bleed/overlap counts, and listen commands:

```bash
./scripts/run_bleed_debug_battery.sh
```

### Prepare stems

Reconciliation reads **processed** stems, not raw WAVs alone:

```bash
export PODCAST_MCP_PIPELINE_DEFAULTS=tests/fixtures/synthetic_bleed_e2e_pipeline.yaml
podcast pipeline run --project "$BLEED" --only ingest_tracks
podcast pipeline run --project "$BLEED" --only render_dialogue_stems
```

If counts look wrong after regenerating fixture WAVs, remove stale artifacts first:

```bash
rm -rf tests/fixtures/synthetic_bleed_60s/artifacts
```

### synthetic_bleed_60s checklist

Primary bleed window: **12–16 s** (guest injected onto host mic; host ducked). Cross-track precorrect pair: **~10 s** (`todae` / `today`).

| # | Step | Command | Expected |
|---|------|---------|----------|
| B1 | Compare bleed window | `podcast play --project "$BLEED" --compare --start 12 --end 16` | Guest tone louder on host track in overlap; both tracks active |
| B2 | Host track solo | `podcast play --project "$BLEED" --source track:host --start 12 --end 16` | Weaker host + bleed from guest |
| B3 | Guest track solo | `podcast play --project "$BLEED" --source track:guest --start 12 --end 16` | Full guest speech |
| B4 | Clean host (control) | `podcast play --project "$BLEED" --source track:host --start 2 --end 8` | Host-only monologue, no cross-talk |
| B5 | Precorrect window | `podcast play --project "$BLEED" --compare --start 9.5 --end 11` | Same moment, both tracks; transcript has `todae` vs `today` |
| B6 | Bleed word list | `podcast edit bleed-words --project "$BLEED" --track host --start 12 --end 16` | ≥ 3 host words with `audibility_status: bleed` |
| B7 | Overlap pairs | `podcast edit overlap-duplicates --project "$BLEED" --start 12 --end 16` | `pair_count` ≥ 1 before reconcile; `text_match_count == 0` after reconcile |
| B8 | Full audibility map | `podcast edit audibility-map --project "$BLEED" --track host` | Mix of `audible` and `bleed` in 12–16 s |
| B9 | Reconcile preview | `podcast edit reconcile-transcript --project "$BLEED" --dry-run --start 12 --end 16` | `suppress` list includes bleed host words |
| B10 | Apply + combined | `podcast edit reconcile-transcript --project "$BLEED" --apply --start 12 --end 16` | Bleed words `suppressed: true`; combined transcript omits them |

**Dominance check:** bleed requires other-track RMS ≥ own-track RMS + **6 dB** (`bleed_dominance_db`). If B6 returns zero but B1 sounds doubled, audition before lowering the threshold.

### ami_bleed_60s checklist

AMI ES2002a word timings (60 s slice) with synthetic overlap audio. Nightly fixture (`e2e_real`).

| # | Step | Command | Expected |
|---|------|---------|----------|
| A1 | Compare first half | `podcast play --project "$AMI" --compare --start 0 --end 30` | Overlapping speech regions audible on both tracks |
| A2 | Bleed words | `podcast edit bleed-words --project "$AMI" --track host` | ≥ 1 bleed word (see `expected_metrics.json`) |
| A3 | Overlap report | `podcast edit overlap-duplicates --project "$AMI"` | Multiple pairs from AMI word overlap |
| A4 | Reconcile | `podcast edit reconcile-transcript --project "$AMI" --dry-run` | Suppressions in overlap regions |

### test_fixture_5min (optional, local)

When `PODCAST_E2E_PROJECT` points at a real remote session, document intro bleed in your episode audit log and listen:

```bash
export PODCAST_E2E_PROJECT=/path/to/test_fixture_5min
podcast play --project "$PODCAST_E2E_PROJECT/episode.project.json" --compare --start 20 --end 45
podcast edit bleed-words --project "$PODCAST_E2E_PROJECT/episode.project.json" --start 20 --end 45
```

Adjust `--start` / `--end` to the overlap noted in your pipeline audit.

---

## Automated battery

```bash
make e2e          # fast: aligned_dialogue + synthetic bleed reconcile tests
make e2e-slow     # includes live transcribe and asr_gold WER
make e2e-real     # AMI bleed + benchmark regression
./scripts/run_e2e_battery.sh
./scripts/run_bleed_debug_battery.sh   # bleed listen-through prep + CLI reports
```
