# Measured test results

Benchmarks and shipped pass results kept out of [testing.md](testing.md): the word-boundary benchmark and the #715 pass results.

## Word-boundary benchmark

The real-speech reference fixture and its attribution are in
`tests/fixtures/word_boundary/README.md`. Three LibriSpeech `dev-clean` clips
have published MFA-generated word boundaries. They are a consistent reference,
not manually audited ground truth. Run the native baseline for each `*.gold.json`
with the locally cached faster-whisper `base` model:

```bash
.venv/bin/python scripts/benchmark_word_boundaries.py \
  --gold tests/fixtures/word_boundary/1988-147956-0023.gold.json \
  --native-model base --output /tmp/1988-native.json
```

Use `--prediction candidate.json` instead of `--native-model base` for another
aligner on the **same** audio; the candidate file contains the audio SHA-256,
nonempty `provenance` metadata (model, version, settings, license and optional
runtime), and an ordered `words` array of text/start/end objects. The script checks both
the gold fixture and candidate hashes against the audio
SHA-256, preserves predicted words and provenance in the report, and never
downloads a model. Scores count only normalized matching words in sequence.
Each gold and prediction transcript may contain at most 256 words; this
benchmark targets short clips and rejects longer inputs before alignment.
Report missed/extra words alongside boundary MAE (mean absolute start and end
error) and the fraction of matched words with either boundary off by >150 ms.
If no words match, MAE and the >150 ms fraction are `null`; missed/extra counts
still show the failed coverage. Exact monotone matching prefers lower timing
error when repeated words create equal text matches. The 256-word limit bounds
matching time and traceback memory even when a candidate inserts or omits a
long contiguous span.

The metric also reports a signed bias over matched words:
`mean_start_error_ms` and `mean_end_error_ms` are `prediction - reference`
in milliseconds, so a positive start means the candidate starts late and a
negative end means it clips the tail. CTC forced alignment tends to do both;
#641 and #639 use this bias to tune boundary padding, not just the
unsigned MAE.

The checked-in `*.native-base.json` reports measured 42 matching words across
48 reference words: 82.3 ms boundary MAE, 15/42 (35.7%) over 150 ms, six
missed and four extra words. The 24.0 s combined wall time includes three
separate Python/model-start processes on the local CPU and is not a normalized
inference-speed comparison. The benchmark does not alter production ASR
timestamps or the pipeline.

**Synthetic fixture.** `tests/fixtures/word_boundary_synthetic/` is a 2.5 s
tone-burst WAV with a hand-authored 5-word gold transcript and prediction.
Its README works out the expected metrics by hand (45.0 ms MAE, 1/4 words
over 150 ms, +40.0 ms start bias, −20.0 ms end bias), and a test asserts them
through both the library and the CLI. It is not speech and proves the metric
and harness, not aligner accuracy.

**Forced-aligner harness.** `scripts/benchmark_forced_aligners.py` runs pinned
CTC forced-aligner candidates (`plan` / `run` / `agree` / `download-commands` /
`verify-candidates` subcommands) that re-time an existing word list — native Whisper output, or a
candidate re-timing another candidate — using the numpy CTC Viterbi in
`src/podcast_mcp/engines/ctc_forced_align.py` (shared with the opt-in pipeline
pass in `engines/word_align.py`, #714). Targets:

- `librispeech` — scored against the same gold fixture as above.
- `aligned_dialogue` and `lab` — agreement only (native vs. each candidate,
  and candidates against each other). `aligned_dialogue` now composes
  complete human LibriSpeech utterances with shifted MFA-derived labels. This
  harness target retains its agreement-only contract; use `librispeech` for
  boundary scoring. Neither target supplies human-verified boundary gold.

**Shipped-pass harness (#715).** The `run`/`agree` subcommands above drive the
harness's own `align_prediction` (`retime_spans` against a bare backend), not
production code. A separate `pipeline` subcommand
(`--target librispeech|lab`) instead scores the exact shipped call chain
`transcribe.py`'s `_align_words` uses: `WordAligner.load` (pinned,
sha256-verified) → `WordAligner.align` → `apply_word_spans`. It shares
`prepare_items()` with `run`: decode audio, then take native words from the
checked-in fixtures, else from a `<id>.native.json` already in the runs dir
for the same `audio_sha256`, else from a fresh Whisper pass. A cached file for
the same audio with no recorded model, a different `--native-model`, or a
different installed version of its recorded native library is an error, never
overwritten, so an earlier pass's predictions in that dir stay paired with the
native words they re-timed. Point `pipeline` at the same runs dir as `run`
(both default to `$LAB_RUNS_DIR/align/<target>`) and both passes score the
exact same native words and audio; delete `<id>.native.json` to force a fresh
Whisper pass. Each item's cache check, Whisper run and write hold
`<id>.native.lock` in the runs dir (`util.file_locks.hold_shared_file_lock`, up to
an hour), so a second pass started into the same dir waits for the first,
then reuses its native words (or errors on a mismatch) instead of both
running Whisper. A refusal (mismatched cached words, a bad runs dir, a lock
still held after an hour) prints one `error: …` line to stderr and exits 2. It
writes `<id>.onnx-base-pipeline.json` predictions/reports plus a
`summary.onnx-base-pipeline.json` (never `run`'s `summary.json`, so both can
share one runs dir) with `scored`, `agreement`, `load_sec`, `asr_runtime_sec`
(recorded Whisper time for non-checked-in native words, cached ones included —
`None` for `librispeech`, which reuses checked-in native words) and a
per-item `duration_profile` (`word_boundary_metrics.word_duration_profile()`:
max/p95/p99 and counts over each of `DURATION_THRESHOLDS_SEC` — 1.00, 1.25,
1.50, 1.75, 2.00, 2.25, 2.50 s). `aligned_dialogue` is not a pipeline target:
when #715 ran, the fixture was non-speech tone with zero native words; since
#801 it is TTS speech but stays agreement-only. The label
is `onnx-base-pipeline`, not `pipeline-onnx-base`, so it never matches the
`run` harness's own `*.onnx-base.json` glob. A fast test
(`test_run_pipeline_pass_end_to_end_with_fakes`) covers the pass with a fake
aligner; `tests/test_word_align_real.py` (`e2e_real`) runs it for real. See
"Shipped pass results (#715)" below for the checked-in, measured numbers.

```bash
uv run python scripts/benchmark_forced_aligners.py pipeline --target librispeech --runs-dir .lab-runs/align/librispeech-pipeline
$LAB/scripts/with-asr-lock.sh uv run python scripts/benchmark_forced_aligners.py pipeline --target lab --lab "$LAB"
```

Candidates are declared in `tests/fixtures/word_boundary/candidates.json`
(Hugging Face repo + pinned revision + license; `onnx-base` also pins a
per-file `file_sha256` manifest checked against the production catalog).
Nothing in CI checks those
pins; run `uv run python scripts/benchmark_forced_aligners.py verify-candidates`
(network, metadata only — no weights) before relying on them. It exits 1 and
lists each candidate whose revision or repo no longer resolves, whose repo is
gated (needs an HF token / accepted terms), whose model-card license differs,
or whose pinned files are missing; a model card that declares no license is
not drift: it prints a `note:` line saying the pinned license was not
verified, and the exit code stays 0 (both ONNX candidates' repo,
`onnx-community/wav2vec2-base-960h-ONNX`, has no card license; its
`apache-2.0` pin comes from the upstream `facebook/wav2vec2-base-960h`); a
rate limit, Hub outage, timeout or connection error is reported as "could not
verify" (the pin may be fine — retry) rather than as drift. The harness
resolves each
model with `snapshot_download(..., local_files_only=True)` and **never
downloads**: an uncached model (a Hugging Face `LocalEntryNotFoundError`)
raises `FileNotFoundError` naming the exact download command, which
`download-commands` also prints; any other hub error (permissions, a corrupt
cache) propagates unchanged. Native words the
aligner leaves unaligned keep their Whisper times; zero-duration ones
(`start == end`, a known faster-whisper output) are dropped from each
candidate prediction and counted in `provenance.alignment_stats.dropped_zero_duration`.
Each side's `dropped_zero_duration` count in `*.agree.json` is that recorded
upstream count plus any zero-duration word still in the compared payload
(the native reference's are dropped there), so a candidate's agree count
matches its `alignment_stats`. The ONNX
candidates need only `onnxruntime`, which the base install gets transitively
through `faster-whisper` (it is not a direct dependency, so declare it if
faster-whisper ever drops it).

Each prediction's provenance records `runtime_sec`, `realtime_factor`,
`load_sec` and `peak_rss_mb`. `peak_rss_mb` is the process RSS high-water mark
(`peak_rss_scope: "process"`, `None` on Windows), so in a multi-candidate
`run` later candidates inherit earlier peaks; for per-candidate memory run one
`--candidate` per invocation.

**Candidate results (#641).** Measured 2026-09-27 on an Apple M2 Pro (12
cores, 32 GiB RAM), `--threads 4`, onnxruntime 1.27.0, torch 2.14.0,
transformers 5.17.0, faster-whisper 1.2.1. The `torch-large` rows are the recorded
run only: its backend, candidate pin and checked-in reports were removed in #2257, so
only the ONNX candidates reproduce. Reproduce with:

```bash
uv run python scripts/benchmark_forced_aligners.py download-commands   # then run what it prints
uv run python scripts/benchmark_forced_aligners.py run --target librispeech --runs-dir .lab-runs/align/librispeech --threads 4
```

For per-candidate peak RSS (`peak_rss_mb` is process-wide) run one
`--candidate` per process, and for the agreement targets:

```bash
uv run python scripts/benchmark_forced_aligners.py run --target librispeech --candidate onnx-base --runs-dir .lab-runs/align/librispeech-onnx-base --threads 4
uv run python scripts/benchmark_forced_aligners.py run --target librispeech --candidate onnx-base-int8 --runs-dir .lab-runs/align/librispeech-onnx-base-int8 --threads 4
uv run python scripts/benchmark_forced_aligners.py run --target aligned_dialogue --runs-dir .lab-runs/align/aligned_dialogue --threads 4
$LAB/scripts/with-asr-lock.sh uv run python scripts/benchmark_forced_aligners.py run --target lab --lab "$LAB" --threads 4
```

**Table 1 — scored, LibriSpeech, 3 clips (42 matched / 48 reference words).**

| Candidate       | matched/ref | MAE (ms) | over 150 ms  | start bias (ms) | end bias (ms) | unaligned words | alignment runtime (s, summed) | RTF    | load (s, per-candidate run) | peak RSS (MiB, per-candidate run) | download |
| --------------- | ----------- | -------- | ------------ | ---------------- | -------------- | ---------------- | ------------------------------ | ------ | -------- | -------------- | -------- |
| native `base`   | 42/48       | 82.26    | 15/42 (35.7%) | −62.38            | −85.95          | n/a (ASR)         | n/a (23.96 s incl. 3 process starts) | n/a  | n/a      | n/a            | already cached |
| `onnx-base`     | 42/48       | 42.98    | 2/42 (4.8%)   | +43.81            | −40.24          | 0                 | 0.81                            | 0.044  | 0.67     | 843.9          | 451 MiB (shared repo) |
| `onnx-base-int8`| 42/48       | 47.26    | 4/42 (9.5%)   | +43.81            | −48.81          | 0                 | 1.36                            | 0.074  | 0.41     | 599.3          | 451 MiB (shared repo) |
| `torch-large`   | 42/48       | 48.69    | 1/42 (2.4%)   | +58.57            | −34.05          | 0                 | 3.32                            | 0.181  | 11.70    | 2070.7         | 1.2 GiB |

`onnx-base` and `onnx-base-int8` share one Hub repo
(`onnx-community/wav2vec2-base-960h-ONNX`), so 451 MiB (`du -sh` on the cache
snapshot) covers both `onnx/model.onnx` and `onnx/model_int8.onnx` together;
`torch-large`'s 1.2 GiB is `facebook/wav2vec2-large-960h-lv60-self`'s
`pytorch_model.bin` plus config files. Native's row is faster-whisper ASR, not
a forced aligner, so its runtime/RTF/RSS aren't comparable to the candidates.

The `load` and `peak RSS` columns are a single local measurement (the machine
and date above) from the one-`--candidate`-per-process runs
(`--runs-dir .lab-runs/align/librispeech-<label>` above). Those per-candidate
reports are not checked in, so no test re-verifies these two columns; re-run
the three per-candidate commands above to reproduce them. Every other
candidate column comes from the combined `run --target librispeech` whose
reports are checked in as `tests/fixtures/word_boundary/<id>.<label>.json` and
re-scored by `test_checked_in_candidate_reports_match_reference_fixture` in
`tests/test_word_boundary_metrics.py`.
`load_sec` is measured once per candidate per run and copied into each clip's
provenance, so it is reported once here, not summed across clips. The
checked-in combined-run reports record `load_sec` 0.61 / 0.12 / 47.70 s and a
max `peak_rss_mb` of 852.9 / 852.9 / 2243.7 MiB for `onnx-base` /
`onnx-base-int8` / `torch-large`. RSS there is process-wide, so each candidate
inherits the earlier candidates' peaks (`onnx-base-int8` inherits fp32's
852.9 MiB). Load times also vary between runs with library-import and
disk-cache state (`torch-large` took 47.70 s combined vs 11.70 s alone), so
treat `load` as order-of-magnitude only.

**Table 2 — agreement against native Whisper `base`.** Measured before #801,
when `aligned_dialogue` was a non-speech tone fixture: `aligned_dialogue`
(2 × 60 s) produced **zero** native words: its old canned transcript did not match
the synthesized audio closely enough for faster-whisper `base` to transcribe
anything, so every candidate — which re-times the native word list, not the
audio directly — also has zero predicted words there. There is no agreement
number to report for `aligned_dialogue`; the lab tape is the only agreement
source below. On the **lab** tape (3 × 60 s, real 3-speaker Zoom speech):

| Candidate        | MAE vs native (ms) | over 150 ms   | start bias (ms) | end bias (ms) | RTF   | `onnx-base~X` pairwise MAE (ms) |
| ---------------- | ------------------- | -------------- | ---------------- | -------------- | ----- | -------------------------------- |
| `onnx-base`       | 115.56               | 53/162 (32.7%) | +162.59           | +18.40          | 0.018 | —                                 |
| `onnx-base-int8`  | 120.00               | 51/162 (31.5%) | +159.75           | +17.53          | 0.031 | 28.22 (163 matched)               |
| `torch-large`     | 127.65               | 58/162 (35.8%) | +185.06           | +42.35          | 0.035 | 33.37 (163 matched)               |

Agreement is not accuracy: it says how much the candidates disagree with
native Whisper's own (possibly wrong) word timestamps on real speech, not how
close either is to the truth. `onnx-base`'s share over 150 ms (32.7%) is under
the 50% threshold that would call for auditing `largest_disagreements` by
ear (see § Lab tape below), so no audit was needed.

**Recommendation: ship `onnx-base`.** Walking the fixed decision rule
(candidate #640 → #641 handoff) against the numbers above:

1. *Eligible* means lower MAE than native (82.26 ms) and fewer words over
   150 ms than native (15 of 42), with `unaligned_words` ≤ 3. All three
   candidates clear this (MAE 42.98/47.26/48.69 ms; over-150 counts 2/4/1;
   `unaligned_words` 0 for all three) — every candidate is eligible.
2. Prefer ONNX among eligible candidates (no new heavy framework, per #639).
   `onnx-base-int8` would be preferred over `onnx-base` only if its MAE were
   within 5 ms of fp32 **and** its over-150 ms count within 1 word of fp32.
   The MAE gap is 4.29 ms (within 5 ms) but the over-150 ms gap is 2 words
   (4 vs 2, not within 1) — so `onnx-base` (fp32) stays the ONNX pick.
3. `torch-large` (removed in #2257; numbers above are the recorded #641 run) only wins if it beats the best eligible ONNX candidate
   (`onnx-base`) by ≥15 ms MAE **and** ≥3 fewer over-150 ms words.
   `torch-large`'s MAE (48.69 ms) is *worse* than `onnx-base`'s (42.98 ms),
   so it does not qualify regardless of its over-150 ms count.
4. The winner's LibriSpeech RTF must be <0.5 at `--threads 4`. `onnx-base`'s
   RTF is 0.044 — comfortably under. No runtime fallback is needed.
5. At least one candidate is eligible, so this is not a "do not integrate"
   result.
6. Lab audit: `onnx-base`'s over-150 ms share on the lab tape is 32.7%, under
   the 50% by-ear-audit trigger, so no audit was performed.
7. **Small-sample caveat.** 42 matched read-speech words across 3 LibriSpeech
   clips is not podcast accuracy; the ~82 ms native MAE and the candidates'
   ~43–49 ms MAE are read-speech numbers. The lab agreement numbers (real,
   messier 3-speaker Zoom audio) exist to catch a candidate that only works
   on read speech — `onnx-base` stays the best (or tied-best) agreement
   candidate there too, so nothing in the lab run contradicts the LibriSpeech
   pick, but treat both as directional, not production accuracy claims.

**Padding hint for #639.** `onnx-base`'s signed LibriSpeech bias is
`mean_start_error_ms = +43.81 ms` (the candidate starts words late) and
`mean_end_error_ms = −40.24 ms` (the candidate clips word ends early). If
#639 adds boundary padding around `onnx-base` cuts, that suggests roughly
44 ms of pre-roll and 40 ms of post-roll to compensate — data only; #641
does not tune anything. See [#639](https://github.com/calebn/sharecut-studio/issues/639).

### Lab tape: alignment testing grounds

The lab checkout (see [Local lab verification](testing-e2e.md#local-lab-verification-private-tape)
above) has real 3-speaker Zoom speech with clipped consonants, quiet words and
overlap that the LibriSpeech clips don't exercise. With `LAB` and
`LAB_RUNS_DIR` exported as above, `run --target lab` clips each stem
(`source/zoom_excerpt_pan/audio*.m4a` by default, overridable with
`--lab-glob`) to 60 s, decoding only that window through ffmpeg, and writes
outputs under `$LAB_RUNS_DIR/align/lab`.

There is no ground truth on the lab tape, so read agreement, runtime/RTF, and
the ranked disagreement list (largest first) to audition candidates by ear
instead of trusting a single number. A hallucinated word over gated silence
(#521) is an ASR error, not a boundary error — don't blame the aligner for it.
To get real ground truth for a clip, hand-check its native words and save
them beside the clip WAV as a local `*.gold.json` in the same format as the
checked-in fixture gold, then score it with
`scripts/benchmark_word_boundaries.py --gold`.

**Rules**, on top of the lab rules above:

- Never write under `$LAB/source` or `$LAB/runs/baseline` — the harness
  refuses a `--runs-dir` inside the lab checkout.
- Full-length stems go through `$LAB/scripts/with-asr-lock.sh`.
- Never commit lab audio, transcripts or word text, and never paste word
  text into PRs or issues. Aggregate numbers (MAE, RTF, counts) are fine.

## Shipped pass results (#715)

[#641](#word-boundary-benchmark) benchmarked forced-aligner *candidates*
through the harness's own `align_prediction` (`retime_spans` against a bare
backend). [#715](https://github.com/calebn/sharecut-studio/issues/715) instead
measures the **shipped production pass** — `WordAligner.load` (pinned,
sha256-verified) → `WordAligner.align` → `apply_word_spans`, exactly what
`transcribe.py`'s `_align_words` drives — via `scripts/benchmark_forced_aligners.py
pipeline` (see "Shipped-pass harness (#715)" above) and real
`podcast pipeline run` timings. Measured 2026-09-28 on the same machine as
#641: Apple M2 Pro (12 cores, 32 GiB RAM), macOS 26.6.2, onnxruntime 1.27.0,
faster-whisper 1.2.1, Python 3.14.2, `onnx-base` pinned to
`onnx-community/wav2vec2-base-960h-ONNX` rev `729c1a6730fb549c20a1c73a3d3f96f11020225e`.
Reproduce with:

```bash
podcast bootstrap --component word-aligner
uv run python scripts/benchmark_forced_aligners.py pipeline --target librispeech --runs-dir .lab-runs/align/librispeech-pipeline
$LAB/scripts/with-asr-lock.sh uv run python scripts/benchmark_forced_aligners.py pipeline --target lab --lab "$LAB"
```

**Table 3 — scored, LibriSpeech, shipped pass (`onnx-base-pipeline`), 3 clips (42
matched / 48 reference words).** Checked in as
`tests/fixtures/word_boundary/<id>.onnx-base-pipeline.json`; re-scored and pinned
by `test_checked_in_shipped_pass_report_matches_pipeline_fixture`
(`tests/test_word_boundary_metrics.py`) and reproduced live by the `e2e_real`
`tests/test_word_align_real.py`.

| Pass                        | matched/ref | MAE (ms) | over 150 ms  | start bias (ms) | end bias (ms) | align runtime (s, summed) | RTF    | load (s) | peak RSS (MiB) |
| ---------------------------- | ----------- | -------- | ------------ | ---------------- | -------------- | -------------------------- | ------ | -------- | -------------- |
| native `base` (Whisper only) | 42/48       | 82.26    | 15/42 (35.7%) | −62.38            | −85.95          | n/a (ASR)                   | n/a    | n/a      | n/a            |
| `onnx-base` (#641 harness, `align_prediction`) | 42/48 | 42.98 | 2/42 (4.8%) | +43.81 | −40.24 | 0.81 | 0.044 | 0.67 | 843.9 |
| `onnx-base-pipeline` (#715 shipped pass, `WordAligner.align`) | 42/48 | 42.98 | 2/42 (4.8%) | +43.81 | −40.24 | 1.04 | 0.056 | 0.73 | 569.3 |

The shipped pass's scored numbers match the #641 harness's `onnx-base` row
exactly (same model, same CTC Viterbi in `engines/ctc_forced_align.py`, same
LibriSpeech clips) — this table exists to prove the shipped call chain, not the
harness's own path, produces these numbers. `runtime`/`load`/`peak RSS` differ
slightly: the shipped pass constructs `TranscriptWord`s and calls through
`apply_word_spans` (production's clamp-unaligned-runs pass), one process, no
per-candidate isolation, so peak RSS is lower than the harness's own
per-`--candidate` process measurement.

**Table 4 — lab agreement (real 3-speaker Zoom speech), shipped pass, 3 × 60 s
(162/162 matched — every native word matched; no ground truth, agreement vs.
native `base` only).**

| Pass                 | MAE vs native (ms) | over 150 ms    | start bias (ms) | end bias (ms) | align runtime (s, summed) | RTF    | ASR runtime (s, summed) | load (s) |
| --------------------- | ------------------- | --------------- | ---------------- | -------------- | --------------------------- | ------ | ------------------------- | -------- |
| `onnx-base-pipeline`  | 115.56               | 53/162 (32.7%)  | +162.59           | +18.40          | 3.49                         | 0.019  | 6.06                       | 0.42     |

Higher MAE and bias than the read-speech LibriSpeech table is expected —
real 3-speaker Zoom audio has overlap, clipped consonants and quiet words
that LibriSpeech doesn't exercise (see "Lab tape: alignment testing grounds"
above); over-150 ms share (32.7%) is under the harness's 50%-by-ear-audit
trigger. Not checked in (lab audio/words never enter the repo); reproduce
with the `pipeline --target lab` command above.

**Table 5 — `transcribe_tracks` runtime, flag off vs on** (2-minute lab
excerpt, `source/zoom_excerpt_pan`, 3 tracks, 416 words, large-v3-turbo CPU,
`podcast pipeline run --only transcribe_tracks --force`, 3 alternating reps
under `with-asr-lock.sh`, median reported; wall time via `/usr/bin/time -l`).

| Setting | Rep 1 (s) | Rep 2 (s) | Rep 3 (s) | Median (s) | Median align_sec (summed, 3 tracks) |
| ------- | --------- | --------- | --------- | ---------- | ------------------------------------- |
| `forced_alignment.enabled=false` | 55.02 | 54.77 | 53.85 | **54.77** | n/a |
| `forced_alignment.enabled=true`  | 66.60 | 64.00 | 72.20 | **66.60** | **9.09** (9.09 / 8.77 / 10.25) |

Forced alignment adds ~11.8 s median wall time (+21.6%) to `transcribe_tracks`
on this 2-minute, 3-track excerpt — consistent with the summed `align_sec`
(9.09 s median) transcribe.py now records per job (#715 Commit 1) plus process
overhead. One full `podcast pipeline run` per setting (`--skip
align_tracks,require_align_accept`, same excerpt) also passed, `export_qc.json`
`ok`, both settings: flag off **69.08 s** real, flag on **77.44 s** real
(+8.36 s, +12.1%; a smaller share than the `transcribe_tracks`-only delta
above, since the rest of the pipeline's fixed steps — stems, reconcile,
mix, master, export — take the same time either way).

**Table 6 — word-duration sensitivity table** (`word_boundary_metrics.
word_duration_profile`, `DURATION_THRESHOLDS_SEC`; counts strictly over each
threshold, across all predicted words on that target).

| Target | words | max (s) | p95 (s) | p99 (s) | over 1.00 | over 1.25 | over 1.50 | over 1.75 | over 2.00 | over 2.25 | over 2.50 |
| ------ | ----- | ------- | ------- | ------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- |
| LibriSpeech (46 predicted words, 3 clips) | 46 | 0.76 | 0.76 | 0.76 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Lab (163 predicted words, 3 × 60 s)       | 163 | 0.60 | 0.56 | 0.60 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

No word on either target — read speech or real 3-speaker Zoom audio — comes
within 0.24 s of even the lowest 1.0 s threshold; the longest aligned word
anywhere measured is 0.76 s (LibriSpeech). This is the data behind the
Threshold (#715) rule in
[docs/transcript-workflow.md § ASR timing flags](transcript-workflow.md#asr-timing-flags):
L (longest aligned word 0.76 s + worst |duration error| vs gold 0.22 s) = 0.98
s, so `L + 0.5 = 1.48 <= 2.0` and `DEFAULT_MAX_WORD_DURATION_SEC` stays **2.0
s** (see the comment above the constant in `engines/asr_timing.py`).

### Aligner evidence floor (#195)

`test_evidence_floor_separates_real_words_from_silence_and_noise_probes`
(`tests/test_word_align_real.py`, `e2e_real`) force-aligns every LibriSpeech
word in `tests/fixtures/word_boundary/*.native-base.json` (46 words, 3 clips)
with the real, locally cached `onnx-base` aligner, then appends two probes
after `1988-147956-0023.wav`: 1.5 s of digital silence and 1.5 s of seeded
(`np.random.default_rng(0)`) Gaussian noise at −50 dBFS RMS, each given a
plausible word span. Reproduce with:

```bash
podcast bootstrap --component word-aligner
uv run pytest --no-cov -q -s -m e2e_real tests/test_word_align_real.py -k evidence
```

Measured 2026-09-28 on the same machine as #715 and #641: Apple M2 Pro (12
cores, macOS 26.6.2), 4 aligner threads.

| Signal | n | min | p5 | median |
| ------ | - | --- | -- | ------ |
| Real LibriSpeech words | 46 | 0.2499 | 0.8760 | 0.9765 |
| Digital-silence probe | 1 | 0.0008 | — | — |
| Low-level (−50 dBFS) noise probe | 1 | 0.0001 | — | — |

**Rule applied:** the real-word minimum (0.2499) is well above 10× the
shipped default (10 × 0.01 = 0.1), and both probes score far below the
default floor. Branch 1 (lower the default) and branch 2 (turn the signal
off) do not apply; the shipped default stays **`min_word_score: 0.01`** in
`.agents/defaults/pipeline.yaml`, `AsrOptions.forced_alignment_min_word_score`
and the `transcribe.forced_alignment.min_word_score` `ParamField`.


### Retained mixed bleed and local phrase alignment

`test_bleed_delay_evidence.py` covers signed 150–350 ms recorded copies with
extended reference context, EQ/noise/gain variations, shifted-null and periodic
controls, independent co-speech, changing local delays, and numerical stability
near silent references. Long-delay profile evidence is opt-in and bounded; the
existing short-delay echo rates and threshold contract are unchanged.

`test_retained_bleed_alignment.py` renders literal PCM to check complete direct
phrase preservation, byte-identical mixed speech, unchanged audio outside the
requested region, quiet slack in every channel (including anti-phase activity
and short bursts), crossfade-clock abstention for each participant, independent
held-out delay stability, supported copy endpoints (interior-only evidence
abstains), agreement across all known retained peers, original outer fade preservation, stale-plan rejection,
repeat/reopen convergence, history restoration of timing choices, source-scoped
quiet-overlap provenance, no stacked-media QC issues, and saved mix mutes. It
includes comparable broadband and narrowband overlapping-owner cases. Seed-reporting
controls compare a supported 150 ms copy with the same samples after erasing only
copy words, missing transcripts, out-of-scope seeds, and no-copy audio in the
transcript-only workflow. They check
`no_retained_bleed_candidate`, unchanged project/PCM on empty-plan apply, and
preserved mute, implicit-timeline, empty-lane, missing-audio, recorder-lock, and
saved-choice outcomes. Cross-role controls preserve a lane's missing-copy-seed
status when it serves as a direct reference elsewhere. Service and CLI tests
check default-gate propagation and nonmutating preview output. A louder-owner case
currently abstains because evidence is weak; amplitude alone does not establish
that delay is unidentifiable.

The local planner uses NCC >= 0.25 plus >= 0.2 shifted-null margin, >= 0.05
competing-peak margin, at least three disjoint supported windows, and <= 2 ms
held-out residual. Supported probes must also cover both inferred copy phrase
endpoints. This bounds measured lag consistency; it does not establish samplewise
perfect alignment between probes. General long-delay profiling retains NCC >= 0.5.
Independent held-out calibration (20 seeds per condition) accepted 100/100 clean, EQ, room,
noise, and equal-RMS overlapping-owner cases, 1/20 owner-at-+10-dB cases, and
0/60 drift, periodic, and unrelated controls. Multipath can select the dominant
audible copy rather than first arrival. These synthetic controls are finite
validation, not a guarantee for every room or speaker. The prior transcript-seeded
investigation of a private episode found zero complete phrases meeting all
automatic guards; that result does not assess the bounded discovery path. Isolated
copy evidence must not be reported as a successful correction.

Full-band seam reads are restricted to complete phrase candidates (maximum
30 seconds plus boundary context); plans examine at most 64 candidate phrases
and at most 10 independent delay windows per relevant lane pair/phrase. The
coarse evidence runs at 8 kHz and source-decode temporaries are released after
each local pair measurement. Delay reads include the configured maximum lag and
shifted-null context, with the window's timeline origin passed to measurement.
Instrumentation on a two-hour source bounds a three-second local probe to at
most 32 decoded seconds per lane while checking copy, periodic, and unrelated
controls. Default echo profiling does not invoke long-delay measurement.
The alignment suite also checks manual per-clip locks after split/punch and scoped
override/reopen, competing batch footprints, preservation of both nearby phrases,
secondary-source transcript selection and word coverage, explicit unresolved
missing/suppressed/unmatched phrases through the default service, and safe abstention
on implicit full-media timelines. Operation counts verify one phrase-index build
per direct lane and termination once the 64-phrase budget is exhausted.
`test_retained_bleed_discovery.py` proves explicit finite lane/start/end discovery
recovers the identical complete -150 ms move after copy words are erased, with
stationary mixed PCM, preserved retained words, unchanged out-of-scope audio and
reopen convergence. Controls cover unrelated/periodic/weak audio, insufficient
null context, endpoints and active interiors, source-specific secondary/alias
transcripts, overlapping unknown sources, saved holds and recorder locks. Unknown
third lanes must agree or be measured quiet; conflicting, unrelated, unreadable
and crossfade lanes veto. A global budget charges every phrase attempt, pair
measurement and quiet read, with reservation before required peer checks. Tests
reject partial candidates, enforce the completed 30-second bound, forbid cold
whole-recording gate plans and bound whole-planner reads on a two-hour source.
The unbounded workflow remains transcript-seeded and retains its prior budget.
CLI and default-gate tests distinguish unbounded no-candidate reporting from
explicit scoped discovery. Actual-WAV ownership regressions add a local-only
237 Hz tone and retain explicitly foreign words: bleed status, foreign dominant
lane and foreign speaker match each forbid owner authorization through both
candidate origins, including manual unsuppression. Conflicting own-lane status
does not override a foreign speaker match. Unattributed, own-lane and manually
retained local-owner controls retain the supported 150 ms move without changing
text decisions. Interior and completion-margin foreign controls cover retained,
suppressed and ignored rows under both identity and shifted timeline placements;
other-recording and outside-source-interval positives remain supported. Synthetic
evidence does not replace artifact listening.

Additional regressions cover reciprocal batch dependencies with supported scoped
own-only proposals, reciprocal foreign-interval refusals, stationary secondary
references during another supported move and competing secondary-reference
dependencies, previous-evidence-revision plan rejection,
unsupported measured active interiors despite agreeing endpoints, distinct ASR
seeds expanding to one acoustic phrase, and declined choices after actual
move-away/back source pinning and workspace reopening. Identity controls cover
legacy decisions, relative/absolute aliases, another selected recording, and the
absence of plaintext paths from persisted recording digests.
Selected-source regressions also cover missing secondary transcripts in phrase
planning, quiet-trim authorization, ignored-word muting, and conversation tokens.
Actual gate plans must abstain for an untranscribed secondary recording while
relative/absolute primary aliases and exact secondary transcripts remain usable.
Secondary transcript suppression and dominant-source changes invalidate the gate
payload and rendered-stem hash; all consumed source identities and word evidence
are fingerprinted.

### Wordbar timing regression coverage

`test_transcript_timing.py` covers exact primary/extra source keys, primary aliases, unplaced words, no-op history, stale sequence/flags/neighbors/media, measured waveform duration, automatic evidence versus locked choices, and exact Undo. `test_word_timing_adapters.py` covers the host adapter and source audio boundary. Frontend Wordbar tests exercise one save per pointer release, cancellation, explicit keyboard/numeric Apply, exact raw preview identity, local waveform viewport, stale recovery and axe. Transport/session tests cover ownership, unchanged timeline position, player reuse and suppression of pending WebSocket fallback writes. Browser checks must verify actual saved timing and Undo, source URLs/clocks and populated local waveforms; an artifact trace does not certify perceptual listening.

### Captured fade regression coverage

`test_clip_fade_baseline.py` sends raw document commands, saves `(1, 0)`, undoes
to `(0, 0)`, and refuses stale `(1, 1)` without changing persisted project bytes,
history, redo, or journal sequence. It also checks accepted-command replay and a
fresh `(0, 1)` retry. `test_clip_fades.py` checks both edges, missing targets,
foreign-writer reload, unrelated changes, and required complete integer baselines.
Focused caller tests exercise captured pairs, visible refusal, and fresh gestures.
`e2e/fade-history-races.spec.ts` holds real server Undo's HTTP reply and WebSocket
messages, checks literal persisted refusal invariants, then retries successfully.
Both fade browser regressions use separate disposable projects and keep
WebSocket messages withheld through the fresh retry. `e2e/fade-peer-recovery.spec.ts` sends a real peer Undo, verifies visible
refusal and refreshed handle values, and saves `(0, 1)` with a fresh `(0, 0)`
baseline. `services/commandQueue.fadeRecovery.integration.test.ts` exercises the
canonical refresh for live and replay host/guest commands, refresh failure with
the original refusal retained, continued replay after permanent conflict, and
scope/generation guards for switched or reopened projects. It checks unchanged
rejected baselines and identities, dequeue and Needs attention records, and no
refresh for inactive projects or unrelated conflicts.
The existing history ordering and peer-head refusal tests remain required.
Shared touch fixtures also submit the saved fade pair from their project snapshot.

The responsive inspector's long-title test uses Playwright native `selectOption`
after pointer geometry admission because End/Enter did not commit the macOS
Chromium popup. Other keyboard-only inspector tests remain. The recording preview
fixture serves `/api/record/state` from the current injected fake-room snapshot
and waits for session initialization. It forwards document and session traffic.

### Sequenced browser fixtures

Browser fixtures that alter project view data intercept `/api/document/state` and
modify the envelope's `project` member or its detail `patch`. Bootstrap timing tests
hold this sequenced endpoint and suppress the document socket hello, so they exercise real loading chrome.

### Transcript boundary archive

`tests/test_transcript_archive.py` and `tests/test_edit_boundaries.py` exercise real cuts, source identity, complete-word restoration, metadata, source ordering, save/reload, and history. Run `uv run pytest -q --no-cov tests/test_transcript_archive.py tests/test_edit_boundaries.py` for focused feedback. `gui/web/e2e/edit-boundary-archive.spec.ts` drives a real cut and mouse roll, verifies the restored chip after reload, then checks undo and redo against the disposable project. Run it with `npm run test:e2e -- e2e/edit-boundary-archive.spec.ts` after the E2E build.
