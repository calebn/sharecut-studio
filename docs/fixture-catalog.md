# Fixture catalog — tools, skills, and test data

Canonical registry for Podcast MCP agent skills, MCP tools, pipeline steps, and committed/downloadable fixtures used in e2e testing. See also [e2e-real-data-plan.md](e2e-real-data-plan.md) and [testing.md](testing.md).

---

## Fixtures (Tier A — committed, CI-fast)

| Fixture | Path | Size | Gold labels | Purpose |
|---------|------|------|-------------|---------|
| `aligned_dialogue` | `tests/fixtures/aligned_dialogue/` | ~60s × 2 | Whole LibriSpeech utterances; published text and MFA-derived timings, not hand-checked | CLI/MCP smoke, edits, social, history; GUI Playwright (waveform pyramids build on demand) |
| `sharecut_ux_demo` | `tests/fixtures/sharecut_ux_demo/` | same audio (symlinked) | UX showcase seed | ShareCut Studio UX Pages demo; pending edit, comments, chapters |
| `asr_gold` | `tests/fixtures/asr_gold/` | ~0.55 MB, 3 utterances | LibriSpeech official | ASR WER regression (`test_asr_gold_wer.py`) |
| `synthetic_bleed_60s` | `tests/fixtures/synthetic_bleed_60s/` | ~10.6 MB | Manifest + word JSON; one tone per word so `echo_risk` measures the bleed path (#774) | Bleed/reconcile/precorrect gold (`test_synthetic_bleed_*.py`) |
| `ami_bleed_60s` | `tests/fixtures/ami_bleed_60s/` | ~10.6 MB | AMI word XML + synthetic audio | Synthetic bleed calibration using AMI overlap timings (nightly) |
| `word_boundary` | `tests/fixtures/word_boundary/` | 3 short clips | LibriSpeech MFA reference (not hand-checked) | Word-boundary benchmark (native vs forced aligners) + checked-in candidate reports (#641) |
| `word_boundary_synthetic` | `tests/fixtures/word_boundary_synthetic/` | 2.5 s tone bursts | Exact by construction (hand-computed) | Word-boundary metric/harness correctness |
| `lab_bleed` | `tests/fixtures/lab_bleed/` | ~0.9 MB, 11 short clips | Owner listening labels | Reviewed real-microphone bleed mutes (`test_lab_bleed_fixtures.py`) |
| `lab_tighten` | `tests/fixtures/lab_tighten/` | ~1.7 MB, 2 × 25 s × 3 tracks | Seeded faster-whisper `base` ASR labels plus a separate owner-verdict table for the clips heard | Real fillers, backchannels and pauses for Tighten Find hits; openable projects (`test_lab_tighten_fixtures.py`) |

### Source sessions: provenance and development/holdout status

A rule written against one recording must be checked on a different one. Group
every excerpt and every transformation of one original session together: more
clips from the same session do not add an independent recording condition. A
recording that guides a fix becomes **development** material from then on.
Only a recording that has never guided a rule, threshold or fixture stays
**holdout**. Change a row's status in the same PR that lets the recording guide
a fix.

| Source session | Fixtures and uses | Conditions and people | Rights | Status |
|----------------|-------------------|-----------------------|--------|--------|
| Sharecut Podcast Lab (private `calebn/sharecut-podcast-lab`, rev `3b414c4c`) | `lab_bleed`, `lab_tighten`, the Lab runs behind `word_onset.py` and `breath_detect.py` constants | One 2026 Zoom call: three gated per-participant tracks (Caleb, Audra, Lana), real bleed on Caleb's mic | Owner-authorized short clips; the full tape stays private | **Development** (thresholds cite it; every Lab excerpt is the same session) |
| LibriSpeech `dev-clean` utterances `1988-147956-0023`, `5338-24640-0003`, `6241-61943-0003` | `word_boundary`, `aligned_dialogue`, `sharecut_ux_demo` (same audio) | Read audiobook speech, three speakers, no conversation, no breath labels | CC BY 4.0 | **Development** |
| Mini LibriSpeech `dev-clean-2` utterances | `asr_gold` | Read speech, WER pin only | CC BY 4.0 | **Development** |
| AMI meeting `ES2002a` word labels | `ami_bleed_60s` (labels real, audio synthetic) | Meeting overlap timings on generated tones | CC BY 4.0 | **Development** (synthetic audio) |
| Generated audio | `synthetic_bleed_60s`, `word_boundary_synthetic`, `audition_defects`, `join_continuity` | Tones and injected defects, no session | n/a | **Synthetic** (never counts as an independent session) |
| Owner catalogue `podcast_111` (2024) | None committed. Local holdout copy only. | Two Zoom per-participant mono exports, gated, 2 speakers | Owner holds the rights | **Holdout** |
| Owner catalogue `podcast_030` (2020) | None committed. Local holdout copy only. | One stereo room recorder file, in person, 16-bit, floor near -52 dBFS | Owner holds the rights | **Holdout** |
| Owner catalogue `podcast_016` (2019) | None committed. Local holdout copy only. | Two mono 24-bit raws, quiet guest about 7 dB under the host, almost no bleed | Owner holds the rights | **Holdout** |
| Owner catalogue `podcast_073` (2021) | None committed. Local holdout copy only. | Three hot gated `_bip` bounces, already edited by the owner | Owner holds the rights | **Holdout, reserved, not yet run** (edited input, so it cannot test content cuts) |
| Owner catalogue `podcast_040` (2020) | None committed. Local holdout copy only. | Remote call: one 24-bit local recorder track (named Host in the manifest, quiet, 23% active) and one 16-bit Zoom `audio_only` export (named Guest), 3466 s, two speakers inferred from file names | Owner holds the rights | **Holdout** (second slice) |
| Owner catalogue `podcast_018` (2019) | None committed. Local holdout copy only. | In person, inferred: two equal-length mono 24-bit raws from one recorder, 2673.5 s, no digital silence, 0.5 s envelope correlation 0.22, both tracks peak at 0 dBFS | Owner holds the rights | **Holdout** (second slice) |

The six owner-catalogue episodes are the #1273 holdout set. Their audio is
private: it contains guests' voices and is never committed, uploaded or pasted.
The owner holds the rights to the whole back catalogue, which satisfies the
commercial-use gate that the public corpus candidates (Open Yap, AMI, DiPCo)
would otherwise have to pass. Work only on copies, recreate them from the
owner's source with the sha256 manifest, and delete scratch projects after
use. Do not tune a threshold on these recordings. The evaluations and their
results are in [holdout-evaluation.md](holdout-evaluation.md).

### Regenerate

```bash
python3 scripts/build_synthetic_bleed_fixture.py
./scripts/download_fixture_asr_gold.sh
./scripts/download_fixture_ami.sh   # fetches AMI words XML, builds ami_bleed_60s
uv run --with piper-tts==1.8.0 python scripts/build_aligned_dialogue_audio.py
```

The `lab_*` fixtures regenerate from a pinned lab checkout passed with
`--lab-root`. See [`lab_bleed`](../tests/fixtures/lab_bleed/README.md) and
[`lab_tighten`](../tests/fixtures/lab_tighten/README.md).

Synthetic bleed uses `tests/fixtures/synthetic_bleed_e2e_pipeline.yaml` (`transcript_mode: reconcile`). Standard e2e smoke uses `tests/fixtures/e2e_pipeline.yaml` (`transcript_mode: flag`).

### Tier B — downloaded / nightly (`e2e_real`)

| Fixture | Script | Purpose |
|---------|--------|---------|
| `ami_bleed_5min` | `scripts/download_fixture_ami.sh` (future) | Longer reconcile metrics |
| `test_fixture_5min` | `PODCAST_E2E_PROJECT` override | Real remote-podcast cadence |

Benchmark ceilings: `tests/fixtures/benchmark_regression_thresholds.json`.

---

## Agent skills

| Skill | Primary surface |
|-------|-----------------|
| `podcast-setup` | `podcast setup`, `podcast doctor` |
| `podcast-ingest-align` | `podcast ingest *`, ingest alignment tools |
| `podcast-align-audio` | ingest + `play_compare_tool` |
| `podcast-pipeline-run` | `pipeline_run`, 14 pipeline steps |
| `podcast-play-audition` | `podcast play`, play tools |
| `podcast-edit-natural-language` | search/cut/approve/render |
| `podcast-tighten-dialogue` | propose/apply edits, fillers |
| `podcast-inaudible-cuts` | `preview_inaudible_cut_tool`, `suggest_handoff_cut_tool` |
| `podcast-transcript-workflow` | hub — layer order, pipeline gates |
| `podcast-transcript-reconcile` | reconcile, bleed, overlap tools |
| `podcast-transcript-precorrect` | precorrect |
| `podcast-transcript-refine` | agent text cleanup (post-precorrect) |
| `podcast-transcript-correct` | correct, low-confidence (quick) |
| `podcast-transcript-audition` | play + correct (manual) |
| `podcast-cleanup-transcript` | redirect → workflow + refine |
| `podcast-speaker-attribution` | speaker tools |
| `podcast-audio-cleanup` | analyze/add effects |
| `podcast-vocal-compression` | compress tracks |
| `podcast-balance-levels` | balance, loudness |
| `podcast-mix-music` | mix_with_music |
| `podcast-master-export` | master, export |
| `podcast-chapter-markers` | chapter tools |
| `podcast-social-clips` | social clip tools |
| `podcast-history` | undo/redo/snapshots |
| `podcast-timeline-comments` | comments, review share |
| `podcast-remote-mcp` | share-token capability-scoped remote MCP |

Skills live under `.agents/skills/`.

---

## MCP tools (82) by module

| Module | Count | Domain |
|--------|-------|--------|
| `mcp/tools/episode.py` | 2 | Project / tracks |
| `mcp/tools/ingest.py` | 3 | Ingest / align |
| `mcp/tools/transcript.py` | 4 | Transcribe / precorrect |
| `mcp/tools/edits.py` | 14 | NL edit / tighten |
| `mcp/tools/timeline.py` | 37 | Reconcile, timeline, FX, chapters |
| `mcp/tools/speaker.py` | 5 | Speaker attribution |
| `mcp/tools/play.py` | 2 | Audition |
| `mcp/tools/pipeline.py` | 5 | Pipeline / render / export |
| `mcp/tools/clips.py` | 6 | Social clips |
| `mcp/tools/history.py` | 4 | Undo / redo |

Registration hub: `src/podcast_mcp/mcp/server.py`. CLI mirrors MCP via `src/podcast_mcp/cli/main.py`.

---

## Pipeline steps (18)

`ingest_tracks` → `transcribe_tracks` → `merge_transcript` → `render_dialogue_stems` → `reconcile_transcript` → `precorrect_transcript` → `require_transcript_refine` → `analyze_focus_cuts` → `focus_from_transcript` → `analyze_fillers_pauses` → `tighten_from_transcript` → `clean_audio` → `compress_tracks` → `balance_tracks` → `assemble_timeline` → `reconcile_transcript` → `mix_with_music` → `master_loudness` → `export_deliverables`

Hard agent gate: **`require_transcript_refine`** (skill **podcast-transcript-refine**). See [transcript-workflow.md](transcript-workflow.md).

---

## E2e test map

| Test | Marker | Fixture |
|------|--------|---------|
| `test_fixture_smoke` | `e2e` | `aligned_dialogue` |
| `test_fixture_pipeline` | `e2e`, `e2e_slow` | `aligned_dialogue` |
| `test_asr_gold_wer` | `e2e`, `e2e_slow` | `asr_gold` |
| `test_synthetic_bleed_reconcile` | `e2e` | `synthetic_bleed_60s` |
| `test_synthetic_bleed_precorrect` | `e2e` | `synthetic_bleed_60s` |
| `test_ami_bleed_reconcile` | `e2e_real` | `ami_bleed_60s` |
| `test_benchmark_regression` | `e2e_real` | `aligned_dialogue` + thresholds JSON |

```bash
make e2e          # Tier A (aligned_dialogue + synthetic bleed + fast e2e)
make e2e-slow     # adds live transcribe (asr_gold WER, aligned_dialogue transcribe)
make e2e-real     # nightly: AMI bleed + benchmark regression
```

---

## Tool × fixture matrix (abbreviated)

| Domain | `aligned_dialogue` | `synthetic_bleed` | `asr_gold` | `ami_bleed` |
|--------|-------------------|-------------------|------------|-------------|
| Setup / smoke | A | A | A | A |
| Transcribe | smoke | — | WER ≤ 12% | — |
| Reconcile | flag-only | bleed ≥ 3 | — | bleed ≥ 1 |
| Precorrect | smoke | cross_track ≥ 1 | — | R |
| NL edit / social | A (canned) | S | — | I |
| Benchmark | timing | — | WER | timing |

**A** = automated assertion, **S** = synthetic gold, **R** = range/threshold, **I** = synthetic calibration with AMI overlap timings.

Synthetic bleed is the **primary gold** for bleed/reconcile/precorrect in PR CI; AMI tests synthetic bleed at published overlap timings; LibriSpeech validates ASR; `aligned_dialogue` tests wiring and complete per-track live-ASR WER against published reference text.

**Operational lessons** from building these fixtures (dominance thresholds, duck/inject recipes, cross-track precorrect gates) live in [transcript-reconcile.md](transcript-reconcile.md) and [transcript-precorrect.md](transcript-precorrect.md) — not only in test code.
