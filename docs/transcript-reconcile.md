# Transcript reconciliation and bleed detection

Operational guide for per-track audibility classification, bleed suppression, and overlap analysis. Complements the [podcast-transcript-reconcile](../.agents/skills/podcast-transcript-reconcile/SKILL.md) skill and [architecture.md](architecture.md).

For regression fixtures and CI thresholds, see [fixture-catalog.md](fixture-catalog.md).

---

## How bleed is detected

For each word window, reconciliation compares RMS on the word's own track against every other dialogue track at the same timeline position (`compute_word_audibility_map` in `audio_audit.py`).

**Zero-duration / sub-5ms words** (ASR junk with `start == end`) cannot be RMS-measured. Isolated ones are tagged **`inaudible`** with `reason: zero_duration_word` so reconcile can suppress them out of `combined.json`. When the same track has **normal-duration neighbors** on both sides, the token is tagged **`deferred`** (`sandwiched_zero_duration_word`) and is **not** auto-suppressed — keeps glue words like `what` between `know` and `I'm`.

**Anomalously long words** (duration &gt; `max_word_audibility_sec`, default **2.0 s**) skip full-span mean RMS. Stretched Whisper tokens that cover speech + silence + peer talk would otherwise look like bleed/inaudible. They are tagged **`deferred`** with `reason: anomalous_word_duration` and are **not** auto-suppressed — neither mean-RMS nor identical-text overlap (`suppress_overlap_text_matches`).

A word is tagged **`bleed`** when another track's RMS exceeds the own-track RMS by at least **`bleed_dominance_db`** (default **6.0 dB**) and the dominant track is above **`bleed_min_other_rms_db`** (default **−50 dB**).

| Heuristic | Default | Meaning |
|-----------|---------|---------|
| `bleed_dominance_db` | 6.0 | Required RMS gap (other − own) for bleed |
| `bleed_min_other_rms_db` | −50 | Dominant track must be this loud or louder |
| `audibility_rms_db` | −42 | Own RMS below this → `inaudible` |
| `max_word_audibility_sec` | 2.0 | Longer ASR words → `deferred` (no mean-RMS suppress) |

Bleed uses **acoustic dominance**, not identical ASR text. Overlapping words with different transcripts are still bleed candidates when the other mic is louder.

When two tracks have **identical overlapping text** but dominance is below `bleed_dominance_db`, reconcile also runs **text-match suppression** (`suppress_overlap_text_matches`): the weaker mic’s word is marked `suppressed` with `reason: text_match_overlap`. Winner selection uses audibility status, ASR confidence, then own-track RMS. Pairs where either word exceeds `max_word_audibility_sec` are skipped — a stretched token’s overlap is not a reliable duplicate.

| Heuristic | Default | Meaning |
|-----------|---------|---------|
| `bleed_text_match_enabled` | true | Suppress identical overlap dupes after acoustic pass |
| `bleed_text_match_min_overlap_sec` | 0.02 | Minimum timeline overlap for text-match rule |

Configure under `analysis.heuristics` in pipeline defaults (workspace `pipeline.yaml` or `PODCAST_MCP_PIPELINE_DEFAULTS`).

**Success gate (transcript):** `overlap_duplicates` → `text_match_count == 0` after reconcile in the scoped window, ignoring remaining pairs that include an anomalously long ASR token.

---

## transcript_mode

| Mode | Use when |
|------|----------|
| `reconcile` | Production and bleed fixtures — updates metadata **and** suppresses bleed/inaudible words |
| `flag` | Smoke tests (`tests/fixtures/e2e_pipeline.yaml`) — tag only, keep short canned transcripts intact |
| `suggest` | Like flag; cleanup report includes suppression keys |
| `off` | Disable audibility analysis |

**E2e split:** `aligned_dialogue` uses `flag`; `synthetic_bleed_60s` uses `tests/fixtures/synthetic_bleed_e2e_pipeline.yaml` with `reconcile`.

---

## Debugging “no bleed words”

When `bleed_words_tool` or `audibility_map_tool` returns all `audible` during known cross-talk:

1. **Check the dominance gap** — at the overlap midpoint, guest RMS minus host RMS must be ≥ `bleed_dominance_db`. A gap of ~5.8 dB will miss the 6.0 threshold.
2. **Confirm stems are fresh** — stale `artifacts/tracks/` can skip re-render and produce misleadingly quiet stems. After changing raw WAVs or FX, delete `artifacts/` or run `assemble_timeline` on a clean workspace copy.
3. **Pipeline order** — audibility needs rendered stems: `ingest_tracks` → `transcribe_tracks` → `merge_transcript` → `render_dialogue_stems` → `reconcile_transcript` (pass 1); pass 2 after `assemble_timeline`. See [transcript-workflow.md](transcript-workflow.md).
4. **Audition** — `play_audio_tool` on both tracks in the overlap window before changing heuristics.
5. **Last resort** — lower `bleed_dominance_db` slightly in workspace `pipeline.yaml` (e.g. 5.0) only after listening confirms real bleed is present but below threshold.

### Mix-side tuning (when audio sounds doubled)

Reconciliation fixes **transcript metadata**, not waveforms. When the premix is muddy and bleed is weakly detected:

- **Duck the primary speaker** in the overlap window so the off-mic track dominates on the wrong mic.
- **Increase cross-inject** (guest into host) in controlled tests.

The committed synthetic fixture recipe (validated in CI):

```yaml
# ground_truth/manifest.yaml bleed_events excerpt
window: {start: 12.0, end: 16.0}
duck: {into: host, gain_db: -30}
inject:
  - {from: guest, into: host, gain_db: -10}
  - {from: host, into: guest, gain_db: -32}
```

Regenerate and validate: `python3 scripts/build_synthetic_bleed_fixture.py` (fails if bleed count &lt; `expected_metrics.json` floors).

---

## Ship gate: staleness at export time

The pipeline's last audio-affecting step (`mix_with_music`) always marks reconciliation
stale (`PipelineRunner.AUDIO_AFFECTING_STEPS`), and nothing downstream re-reconciles
before `export_deliverables` — so a full pipeline run can finish with a genuinely stale
reconciliation state without erroring. `export_deliverables` writes
`artifacts/export_qc.json` with the current `reconciliation_status()` and an explicit
issue message when stale, specifically so this doesn't ship unnoticed. See
[podcast-master-export](../.agents/skills/podcast-master-export/SKILL.md#final-ship-gate-export_qcjson).
If you see `reconciliation.stale: true` there, re-run `reconcile_transcript_tool` and
re-export.

## Typical workflow

1. `reconciliation_status_tool` — stale after FX/edits?
2. `render_preview` or `assemble_timeline` if stems are stale.
3. `audibility_map_tool` or `bleed_words_tool` — scope with `start_sec` / `end_sec`.
4. `overlap_duplicates_tool` — overlapping pairs with text-match hints (read-only).
5. `reconcile_transcript_tool` with `dry_run=true` to preview suppressions, then apply.
6. Hand off to [transcript-precorrect.md](transcript-precorrect.md) for glossary and cross-track sync.

Reconcile updates **transcript metadata only** by default. For acoustic follow-up once transcript bleed is clean, see [podcast-mute-bleed](../.agents/skills/podcast-mute-bleed/SKILL.md).

---

## Acoustic follow-up: mute when not talking

After `text_match_count == 0` and combined transcript is clean:

1. Ensure stems are **fresh and not longer than the session timeline** (`assemble_timeline` / `render_dialogue_stems`). `stem_is_fresh` rejects source-length stems (wrong clock).
2. `podcast edit apply-bleed-mute --dry-run` — preview gate intervals per stem (skips stale/overlong stems).
3. `podcast edit apply-bleed-mute` — gate `artifacts/tracks/*.wav` to non-suppressed word spans.
4. Audition with `play --compare`; re-run mix/premix after gating.

MCP: `apply_transcript_gate_tool`. Transcript word flags are unchanged; this sets
`timeline.tracks[].transcript_gate` (history-snapshotted) and rewrites stem WAVs
in the requested window. Undo restores the flag; `play processed:*` re-applies the
gate via segment/stem render when the flag is set.

---

## Synthetic and AMI fixtures

| Fixture | What it validates |
|---------|-------------------|
| `synthetic_bleed_60s` | Deterministic bleed SNR, reconcile suppressions, precorrect cross-track |
| `ami_bleed_60s` | AMI word timings + synthetic overlap audio (headset WAV URLs unavailable) |

Build scripts encode the bleed recipes above:

- `scripts/build_synthetic_bleed_fixture.py`
- `scripts/build_ami_bleed_fixture.py` (imports `import_ami_words.py`, overlap windows from word timings)

AMI overlap pairs can exist without bleed tags if dominance stays under threshold — use synthetic_bleed as the **primary gold** for reconcile assertions; AMI as realism check (`e2e_real`).

---

## Manual bleed debugging

Listen-through checklist and CLI commands for `synthetic_bleed_60s` (12–16 s window) and `ami_bleed_60s`:

```bash
./scripts/run_bleed_debug_battery.sh
```

See [e2e-fixture-manual.md](e2e-fixture-manual.md#bleed-debugging).

## Related

- [transcript-precorrect.md](transcript-precorrect.md) — cross-track text sync after reconcile
- [speaker-attribution.md](speaker-attribution.md) — bleed-gated speaker pass
- [testing.md](testing.md) — `make e2e`, `make e2e-real`
