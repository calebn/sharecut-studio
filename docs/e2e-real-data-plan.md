# E2E test plan — real data fixtures

Plan for expanding end-to-end coverage beyond `aligned_dialogue` (synthetic/canned) using public corpora and controlled real-speech clips. Complements [testing.md](testing.md) and [e2e-fixture-manual.md](e2e-fixture-manual.md).

**Status:** Phase 1 implemented (synthetic bleed, asr_gold, ami_bleed_60s, e2e tests). See [fixture-catalog.md](fixture-catalog.md).

---

## Current state

### What we test today

| Test | Fixture | Real speech? | Gold labels? |
|------|---------|--------------|--------------|
| `test_fixture_smoke` | `aligned_dialogue` | Partial (humming/chimes) | No |
| `test_fixture_play` | `aligned_dialogue` | Partial | No |
| `test_fixture_edits` | `aligned_dialogue` + canned seed | No (text ≠ audio) | Canned only |
| `test_fixture_pipeline` | `aligned_dialogue` + canned | No | Canned only |
| `test_fixture_social` | `aligned_dialogue` + canned | No | Canned only |
| `test_fixture_transcribe_slow` | `aligned_dialogue` | Partial | No |
| `PODCAST_E2E_PROJECT` override | e.g. `test_fixture_5min` | Yes | Weak (prior ASR) |

`aligned_dialogue` is excellent for **pipeline wiring, MCP/CLI smoke, and NL edit mechanics** but cannot validate transcription accuracy, bleed suppression, or precorrect against truth.

### Tools / pipeline steps to cover

| Area | CLI / MCP | Pipeline step |
|------|-----------|---------------|
| Ingest / align | `podcast ingest *` | `ingest_tracks` |
| Transcribe | `podcast transcribe` | `transcribe_tracks` |
| Merge / combined | — | `merge_transcript` |
| Filler / tighten | `podcast edit`, `propose-edits` | `analyze_fillers_pauses`, `tighten_from_transcript` |
| Audio cleanup | `analyze_cleanup`, effects | `clean_audio` |
| Level / compression | — | `balance_tracks`, `compress_tracks` |
| Timeline / preview | `render-preview` | `assemble_timeline` |
| Reconcile / bleed | `reconcile-transcript`, `suppress-bleed` | `reconcile_transcript` |
| Precorrect | `transcript precorrect` | `precorrect_transcript` |
| Speaker ID | `podcast speaker *` | (via precorrect gate) |
| Mix / master / export | — | `mix_with_music`, `master_loudness`, `export_deliverables` |
| Play / audition | `podcast play` | — |
| Social clips | `podcast clips *` | — |
| History | `podcast history *` | — |
| Chapters | chapter tools | — |
| Backend benchmark | `scripts/benchmark_transcribe_backends.py` | — |

---

## Fixture strategy (three tiers)

### Tier A — Committed, CI-fast (&lt;30s total)

Small clips in git. No download step.

| Fixture | Source | Size target | Purpose |
|---------|--------|-------------|---------|
| `aligned_dialogue` | Existing | 60s × 2 | CLI/MCP smoke, edit/social/history (keep) |
| `asr_gold` | Mini LibriSpeech `dev-clean-2` (20 utterances) | ~5 MB | WER regression for transcribe backends |
| `synthetic_bleed_60s` | Generator + committed WAVs | ~15 MB | **Primary** bleed/reconcile/precorrect gold |
| `ami_bleed_60s` | AMI `ES2002a` word XML + synthetic overlap audio | ~15 MB | Natural overlap vs synthetic calibration |

**AMI clip:** Download full meeting via [AMI corpus](https://groups.inf.ed.ac.uk/ami/download/) (CC BY 4.0). Commit only a single 60s slice + `ground_truth.json` converted from `*.words.xml`. Map two headset channels to `host` / `guest` for podcast-shaped tests.

**LibriSpeech slice:** Official transcripts in `*.trans.txt` next to each FLAC. One file per utterance in `tests/fixtures/asr_gold/manifest.json`.

### Tier B — Downloaded, CI-nightly (~5–15 min)

`scripts/download_fixtures.sh` fetches archives; pytest marker `e2e_real`.

| Fixture | Source | Duration | Purpose |
|---------|--------|----------|---------|
| `ami_bleed_5min` | AMI `ES2002a` or `IS1000a`, 5 min, 4 headsets | 5 min | Full reconcile + overlap metrics |
| `meetings_10h_clip` | [ground-truth/multichannel-meetings-10h](https://huggingface.co/datasets/ground-truth/multichannel-meetings-10h) one session | 3–5 min | Room mic + per-speaker stems (ingest/align) |
| `test_fixture_5min` | Internal Vicky/Rehana slice | 5 min | Real remote-podcast cadence (weak ref) |

Assertions use **structural checks** (bleed count in range, pipeline exit 0, WER below ceiling) not pixel-perfect audio hashes.

### Tier C — Manual / weekly (human listen)

| Fixture | Source | Purpose |
|---------|--------|---------|
| `podcast_weak` | SPoRC / LAION episode metadata + downloaded MP3 | Long-form pipeline, glossary, social clip proposals |
| `podcast-cleanup-test` | Olga/Vicky ~64 min | Full production rehearsal |
| PodcastMix real-with-reference | [MTG/Podcastmix](https://github.com/MTG/Podcastmix) | `mix_with_music` under real speech+music |

Do **not** gate CI on WER for Tier C — transcripts are machine-generated.

---

## Test matrix — corpus × tool

Legend: **A** = assert automatically, **R** = range/threshold, **M** = manual listen, **—** = not applicable

| Tool / step | `asr_gold` | `ami_bleed` | `test_fixture_5min` | `aligned_dialogue` |
|-------------|------------|-------------|---------------------|-------------------|
| `transcribe_tracks` | **A** WER ≤ 15% (base, CPU) | **R** word count ±30% | **R** WER vs seeded tx | smoke only |
| `merge_transcript` | — | **A** combined utterances &gt; 0 | **A** | **A** (canned) |
| `assemble_timeline` | — | **A** preview renders | **A** | **A** |
| `reconcile_transcript` | — | **A** bleed suppressions &gt; 0 at known overlap | **R** suppressions | flag-only (yaml) |
| `precorrect_transcript` | — | **R** cross-track fixes &gt; 0 | **R** glossary hits | smoke |
| `analyze_fillers_pauses` | — | **A** proposals exist | **A** | **A** (canned) |
| `tighten_from_transcript` | — | **M** / **R** duration shrink | **M** | **A** (canned) |
| `clean_audio` | — | **R** audibility map shifts | **R** | skip |
| `balance_tracks` / `compress` | — | **A** LUFS within ±2 dB | **A** | **A** |
| `mix_with_music` | — | — | — | **A** (no music bed) |
| `master_loudness` / `export` | — | **A** MP3 exists, LUFS −16 ±1 | **A** | optional |
| `play` / search | — | **A** query hits AMI vocabulary | **A** documented, people, … | canned terms |
| `edit` / `ripple_delete` | — | **A** undo restores | **A** | **A** |
| `clips` social | — | — | **A** ≥1 candidate | **A** (canned) |
| `speaker attribute` | — | **R** runs when bleed gate met | optional | skip (no bleed) |
| `benchmark_transcribe_backends` | **A** WER + timing JSON | timing only | **R** WER ceiling | timing only |

---

## Proposed new e2e tests

### Fast (`pytest -m e2e`, Tier A)

```
tests/e2e/test_asr_gold_wer.py              # transcribe 3 utterances, WER ≤ 12% (e2e_slow)
tests/e2e/test_synthetic_bleed_reconcile.py # reconcile bleed count from expected_metrics.json
tests/e2e/test_synthetic_bleed_precorrect.py
```

### Nightly (`pytest -m e2e_real`, Tier B subset)

```
tests/e2e/test_ami_bleed_reconcile.py       # AMI overlap + bleed floor
tests/e2e/test_benchmark_regression.py      # timing ceilings from benchmark_regression_thresholds.json
```

### Nightly (`pytest -m e2e_real`)

```
tests/e2e/test_real_transcribe_pipeline.py   # test_fixture_5min or ami 5min: transcribe → precorrect
tests/e2e/test_real_nl_edit_roundtrip.py     # cut-text on real speech, render-preview, undo
tests/e2e/test_real_social_clips.py          # clips propose on real combined transcript
tests/e2e/test_benchmark_regression.py       # benchmark JSON thresholds (speed + WER)
```

### Manual battery (extend `run_e2e_battery.sh`)

Add checklist rows for AMI bleed window and `test_fixture_5min` intro bleed (~20–45s) documented in audit logs.

---

## Corpora reference

| Corpus | License | Best for | Avoid for |
|--------|---------|----------|-----------|
| [Mini LibriSpeech](https://www.openslr.org/31) | CC BY 4.0 | ASR WER gold | bleed, multitrack |
| [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) | CC BY 4.0 | multitrack bleed, overlap, word times | podcast tone |
| [multichannel-meetings-10h](https://huggingface.co/datasets/ground-truth/multichannel-meetings-10h) | Check HF card | room + lapel geometry | WER gold (verify labels) |
| [Maleo Short Podcast](https://huggingface.co/datasets/maleo-ai/maleo-short-1.5H) | Check HF card | overlap/diarization | per-track stems |
| [SPoRC](https://huggingface.co/datasets/blitt/SPoRC) | Check HF card | podcast metadata scale | WER assertions |
| [PodcastMix](https://github.com/MTG/Podcastmix) | Check repo | music+speech mix | dialogue bleed |
| Internal `test_fixture_5min` | Private | remote podcast realism | portable CI |
| Synthetic TTS mix | Owned | perfect gold + bleed SNR | naturalness |

---

## Implementation phases

### Phase 1 — Foundation (1–2 days)

1. `scripts/import_ami_words.py` — AMI `*.words.xml` → `TranscriptWord` JSON
2. `scripts/download_fixture_ami.sh` — fetch one meeting, extract 60s, write `tests/fixtures/ami_bleed_60s/`
3. `scripts/download_fixture_asr_gold.sh` — Mini LibriSpeech 20-file slice
4. `tests/fixtures/ami_bleed_60s/episode.project.json` + `ground_truth.json`
5. `test_asr_gold_wer.py`, `test_ami_bleed_reconcile.py`

### Phase 2 — Pipeline on real speech (2–3 days)

1. Marker `e2e_real` in `pyproject.toml`; `make e2e-real` target
2. `test_real_transcribe_pipeline.py` using `PODCAST_E2E_PROJECT` or AMI 5min
3. Wire `scripts/benchmark_transcribe_backends.py` into `test_benchmark_regression.py` with checked-in ceiling JSON
4. Document `transcript_mode: reconcile` defaults for real fixtures (unlike e2e yaml `flag`)

### Phase 3 — Tool coverage gaps (ongoing)

1. Speaker attribution e2e on AMI when bleed gate opens
2. `podcast ingest align` on multichannel-meetings clip
3. Audio cleanup A/B harness on AMI (gate overreach regression)
4. Optional: synthetic `aligned_dialogue_speech` (TTS + controlled bleed) to replace text≠audio mismatch

### Phase 4 — CI topology

| Job | When | Command |
|-----|------|---------|
| `test` | every PR | `make test` (95% cov, `-n auto`) |
| `e2e` | every PR | `make e2e` (Tier A, &lt;1 min) |
| `e2e-real` | nightly / main | `make e2e-real` (Tier B) |
| `benchmark` | weekly | `benchmark_transcribe_backends.py` + commit thresholds |

---

## Thresholds (initial — tune after Phase 1)

| Metric | Fixture | Ceiling / floor |
|--------|---------|-----------------|
| WER (faster-whisper base, CPU) | `asr_gold` | ≤ 12% per utterance |
| WER (faster-whisper base) | `test_fixture_5min` 90s | ≤ 10% aggregate |
| Bleed suppressions | `ami_bleed_60s` | ≥ 5 words on at least one track |
| `precorrect` cross_track fixes | `ami_bleed_60s` | ≥ 1 |
| Pipeline | all real fixtures | exit 0, no stderr errors |
| Benchmark speed | `aligned_dialogue` | whisper.cpp &lt; faster-whisper (informational) |

whisper.cpp remains **benchmark-only** until WER on `asr_gold` and `test_fixture_5min` meets floors with a larger ggml model.

---

## Open decisions

1. **Commit AMI/LibriSpeech audio to git** vs download-only — recommend commit 60s AMI + 20 LibriSpeech utterances (&lt;25 MB total).
2. **Replace or supplement `aligned_dialogue`** with TTS-generated speech matching canned text.
3. **Whether `test_fixture_5min` becomes a submodule** or stays `PODCAST_E2E_PROJECT` local path for nightly only.
4. **Fixture write guard** (`PODCAST_ALLOW_FIXTURE_WRITE`) before expanding committed fixtures.

---

## Related docs

- [transcribe-backends.md](transcribe-backends.md) — whisper.cpp adapter + WER benchmark
- [e2e-fixture-manual.md](e2e-fixture-manual.md) — manual listen checklist
- [testing.md](testing.md) — render regression fingerprints (sandbox-only hashes of rendered outputs)
- [ROADMAP.md](../ROADMAP.md) — fixture sandbox, larger optional fixture
