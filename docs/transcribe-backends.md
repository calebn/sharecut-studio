# Transcription backends benchmark

Podcast MCP transcribes with **faster-whisper** (CTranslate2) by default. This branch adds a **whisper.cpp** subprocess adapter for comparison and optional future use.

## Setup (whisper.cpp)

```bash
brew install whisper-cpp
mkdir -p ~/.cache/podcast_mcp/whisper-cpp/models
curl -L -o ~/.cache/podcast_mcp/whisper-cpp/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Override paths with `WHISPER_CPP_BIN` and `WHISPER_CPP_MODEL` if needed.

## Run benchmark

Uses the short `tests/fixtures/aligned_dialogue` clips (~60s per track):

```bash
python scripts/benchmark_transcribe_backends.py
```

Report: `tests/fixtures/aligned_dialogue/artifacts/transcribe_benchmark.json` (gitignored).

## Results (2026-06-09, Apple Silicon, `base` / `ggml-base.en.bin`)

| Track     | faster-whisper | whisper.cpp |
|-----------|----------------|-------------|
| reference | 7.25s          | 1.34s       |
| guest     | 1.19s          | 0.67s       |
| **Total** | **8.44s**      | **2.02s**   |

**~4.2× faster** with whisper.cpp on this fixture (Metal, cold run, no warmup).

Word counts differ because the fixture is mostly humming/music with sparse speech; the benchmark measures wall-clock time, not WER.

## Accuracy (WER)

The benchmark script also computes **word error rate** when ground truth is available:

```bash
# Real speech: use existing fixture transcripts as reference (90s clip)
python scripts/benchmark_transcribe_backends.py \
  --fixture /path/to/test_fixture_5min \
  --ground-truth-from-fixture \
  --max-duration 90
```

WER is measured on words inside speech time windows from the reference transcript (filters out-of-window hallucinations).

**Note:** `aligned_dialogue` + `canned_transcript_aligned.json` is **not** valid for accuracy — the canned text is seeded for e2e pipeline tests and does not match the humming/chime audio. Both backends score ~100% WER there.

### Results (2026-06-09, first 90s of `test_fixture_5min`, `base` / `ggml-base.en.bin`)

| Track  | faster-whisper WER | whisper.cpp WER |
|--------|--------------------|-----------------|
| rehana | 8.7%               | 35.9%           |
| vicky  | 2.7%               | 181.6%          |
| **Aggregate** | **5.2%**      | **121.6%**      |

Cross-backend agreement (mean symmetric WER): **93%** overall (rehana 33%, vicky 153%).

**Takeaway:** whisper.cpp is much faster on Apple Silicon but `ggml-base.en.bin` over-transcribes on this dialogue (especially vicky: 428 words vs 147 reference in 90s). faster-whisper `base` is far more accurate against the existing reference transcripts. A larger whisper.cpp model or tuning may close the gap; speed alone is not enough to swap backends.

## Code

- `src/podcast_mcp/engines/whisper_cpp.py` — `whisper-cli` wrapper + JSON parser
- `scripts/benchmark_transcribe_backends.py` — side-by-side timings + WER
- `src/podcast_mcp/util/wer.py` — windowed WER helpers
- `tests/test_wer.py` — WER unit tests
- `tests/test_whisper_cpp.py` — parser unit test + optional slow integration

Production pipeline still uses `TranscriptionEngine` (faster-whisper). Wiring whisper.cpp as a config-selectable backend is a follow-up after validating quality on real dialogue.
