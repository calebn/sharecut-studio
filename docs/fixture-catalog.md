# Fixture catalog — tools, skills, and test data

Canonical registry for Podcast MCP agent skills, MCP tools, pipeline steps, and committed/downloadable fixtures used in e2e testing. See also [e2e-real-data-plan.md](e2e-real-data-plan.md) and [testing.md](testing.md).

---

## Fixtures (Tier A — committed, CI-fast)

| Fixture | Path | Size | Gold labels | Purpose |
|---------|------|------|-------------|---------|
| `aligned_dialogue` | `tests/fixtures/aligned_dialogue/` | ~60s × 2 | Canned only (text ≠ audio) | CLI/MCP smoke, edits, social, history; GUI Playwright (waveform pyramids build on demand) |
| `sharecut_ux_demo` | `tests/fixtures/sharecut_ux_demo/` | same audio (symlinked) | UX showcase seed | Sharecut Studio UX Pages demo; pending edit, comments, chapters |
| `asr_gold` | `tests/fixtures/asr_gold/` | ~5 MB | LibriSpeech official | ASR WER regression (`test_asr_gold_wer.py`) |
| `synthetic_bleed_60s` | `tests/fixtures/synthetic_bleed_60s/` | ~15 MB | Manifest + word JSON | Bleed/reconcile/precorrect gold (`test_synthetic_bleed_*.py`) |
| `ami_bleed_60s` | `tests/fixtures/ami_bleed_60s/` | ~15 MB | AMI word XML + synthetic audio | Natural overlap vs synthetic calibration (nightly) |

### Regenerate

```bash
python3 scripts/build_synthetic_bleed_fixture.py
./scripts/download_fixture_asr_gold.sh
./scripts/download_fixture_ami.sh   # fetches AMI words XML, builds ami_bleed_60s
```

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

`ingest_tracks` → `transcribe_tracks` → `merge_transcript` → `render_dialogue_stems` → `reconcile_transcript` → `precorrect_transcript` → `require_transcript_refine` → `analyze_focus_cuts` → `focus_from_transcript` → `analyze_fillers_pauses` → `tighten_from_transcript` → `clean_audio` → `balance_tracks` → `compress_tracks` → `assemble_timeline` → `reconcile_transcript` → `mix_with_music` → `master_loudness` → `export_deliverables`

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

**A** = automated assertion, **S** = synthetic gold, **R** = range/threshold, **I** = AMI overlap realism.

Synthetic bleed is the **primary gold** for bleed/reconcile/precorrect in PR CI; AMI validates overlap realism; LibriSpeech validates ASR; `aligned_dialogue` remains wiring smoke only.

**Operational lessons** from building these fixtures (dominance thresholds, duck/inject recipes, cross-track precorrect gates) live in [transcript-reconcile.md](transcript-reconcile.md) and [transcript-precorrect.md](transcript-precorrect.md) — not only in test code.
