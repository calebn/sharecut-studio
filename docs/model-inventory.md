# Model and runtime inventory

Which features use a downloaded model or an optional runtime, where setup covers them today, and what is missing. This is the audit for [#1998](https://github.com/calebn/sharecut-studio/issues/1998) against `develop`; update it in the same PR that changes a row. The single authoritative setup catalog it points at is the model registry, `engines/models/registry.py` (`MODELS`). `services/pipeline/bootstrap.py` (`component_status`, `run_bootstrap`) derives from it.

"In GUI setup" means the component is a registry row (listed in `ALL_GUI_COMPONENTS`) and can be installed from the packaged app. The frozen sidecar is built with `--extra gui` only (no torch; see [desktop-packaging.md](desktop-packaging.md) § Frozen sidecar), so a feature whose runtime is a Python extra cannot work in a packaged app by downloading weights alone.

| Feature | Model or runtime | Download path | In GUI setup | Pinned and checked | Packaged app today |
| --- | --- | --- | --- | --- | --- |
| Transcription | Whisper tiers (`faster-whisper` / CTranslate2) | `bootstrap_whisper_model`, pinned HF snapshot | Yes, first-run default | Revision pin, `whisper_model_problem` | Works |
| Voice activity | Silero VAD ONNX, bundled with `faster-whisper` | None | Reported by `podcast doctor` only, not in bootstrap status | n/a | Works |
| Noise reduction | RNNoise `.rnnn` for FFmpeg `arnndn` | `bootstrap_rnnoise_model` | Yes, recommended | `podcast doctor` prints one line for the row; sha256 and size_bytes pinned in contracts/bootstrap-assets.json; GitHub source is a commit-pinned raw URL (GregorR/rnnoise-models@3eee541); CDN copy not yet uploaded | Works |
| Precise word boundaries | Forced word aligner (ONNX, `onnxruntime` is a core dependency) | `bootstrap_word_aligner`, pinned HF snapshot | Yes, recommended (installed by Get ready while the Setup card shows, and by `podcast bootstrap`) | Revision pin, `word_aligner_problem`; `podcast doctor` prints one line for the row (`installed`, not downloaded with the bootstrap command, or the pin or load message); `installed` means the pin matches; a failed load check (`engines/models/load_probe.py`) makes it `unsupported`, remembered per running process, run after a download that changed the file or to retry a remembered failure, and when a loader first uses the model, cleared when the file or `onnxruntime` changes; never refuses a run (the loader retries); retry after an unloadable download is `podcast bootstrap --component <id>` (Studio hides Get on `unsupported`), which prints a `[warn]` line | Works |
| Speaker recognition and split | ECAPA embedding network exported to ONNX (`engines/models/speaker_ecapa.py`), `onnxruntime` | `bootstrap_speaker_ecapa`, sha256-pinned file served from the first-party CDN origin that official builds embed (none in a source build) | Yes, recommended (`speaker-ecapa`; installed by Get ready while the Setup card shows, and by `podcast bootstrap`) | sha256 pin and size_bytes pin (checked after download), `speaker_ecapa_problem`; `podcast doctor` prints one line for the row; `installed` means the pin matches; a failed load check (`engines/models/load_probe.py`) makes it `unsupported`, remembered per running process, run after a download that changed the file or to retry a remembered failure, and when a loader first uses the model, cleared when the file or `onnxruntime` changes; never refuses a run (the loader retries); retry after an unloadable download is `podcast bootstrap --component <id>` (Studio hides Get on `unsupported`), which prints a `[warn]` line | Works once downloaded |

## What a registry row does, row by row

Setup tiers come from `ModelSpec.setup` in `engines/models/registry.py`: Whisper is required; RNNoise, the word aligner and the speaker model are recommended. GUI first run and the MCP and GUI bootstrap jobs install through `run_bootstrap` (`services/pipeline/bootstrap.py`), which reads `component_status` when it finishes; `podcast bootstrap` loops over the rows in `cli/setup_cmd.py` (through `install_and_report`, which calls `install_model`) and passes no `cancel_check`.

Every row has the same shape: `model_status` reports it as `installed`, `update_needed` or `missing` without downloading, and every install runs inside `_ByteRelay`, which publishes a `bootstrap.bytes` child task on the first progress tick (a cached RNNoise, word aligner or speaker model ticks nothing, so no task appears; Whisper always ticks once). The rows differ below that.

| Row | Status check at rest | Install progress | Cancel | Pin checked |
| --- | --- | --- | --- | --- |
| Whisper, catalog size | Pinned snapshot; a mismatch is `update_needed` | Bytes, about every 1 MiB | Via the progress callback; `test_pinned_download_stops_when_the_sink_raises` shows the exception propagates out of a faked hub download, and `tests/test_hf_cancel.py` stops a real download over plain HTTP against a local hub within a couple of MiB (Studio asks the library for byte updates about every 1 MiB) | At status time and after download |
| Whisper, size outside the pinned catalog | Weights present on disk | One start tick, no byte count | Only before the download starts | No |
| RNNoise | Default file is sha256-checked and a wrong or truncated one is `update_needed`; an override file via `PODCAST_MCP_RNNOISE_MODEL` is never hashed; set a custom model you want to keep there, because a different file at the default path shows `update_needed` and is refused until replaced | Bytes per 1 MiB | Per 1 MiB chunk | sha256 at status time and at download; a bare bootstrap re-downloads a default file that fails it |
| Word aligner | Pinned snapshot; a mismatch is `update_needed` | Bytes, about every 1 MiB | Via the progress callback; `test_pinned_download_stops_when_the_sink_raises` shows the exception propagates out of a faked hub download, and `tests/test_hf_cancel.py` stops a real download over plain HTTP against a local hub within a couple of MiB (Studio asks the library for byte updates about every 1 MiB) | At status time and after download; an override directory skips `verify_word_aligner_snapshot` |
| Speaker model | Default file is sha256-checked; an override file via `PODCAST_MCP_SPEAKER_ECAPA_MODEL` is not | Bytes per 1 MiB | Per 1 MiB chunk | sha256 at status time and at download; with an override set no download is attempted |

Between rows, `run_bootstrap` checks `cancel_check` before each component.

Silero VAD has no row (see the table above).

See [setup.md](setup.md) for the user-facing description of the same path.

Still open on #1998:

- Running the speaker model download from inside a packaged app. A fresh freeze proves `onnxruntime` and the bundled Silero VAD run, and every freeze (fresh or reused) checks that the packaged FFmpeg has `arnndn`; the download itself is still a manual check.
- A look at Split speakers (the Source card in Prepare) in a real browser and on a device.
- Cancelling a snapshot download over the XET transport (`hf_xet`, a default dependency) and the overrun of a multi-file snapshot, which runs up to eight files at once: `tests/test_hf_cancel.py` covers one file over plain HTTP only.

## Findings

1. **Join quality has no model.** The WavLM and NISQA-named layer was removed (it never ran in a default install; the bake-off had no real labelled fails to rank it against the numpy detector fusion). Continuity is the numpy detector fusion only, so there is nothing to download or set up for it.
2. **Speaker backends were the real gap.** The torch backends could not run in the packaged app; the ONNX ECAPA component (#1998) fixed that and is now the only speaker model.
3. **(Fixed by #1999.) `resolve_speaker_backend()` with no argument fell back to `MockSpeakerBackend`** when neither real backend imports, so a packaged app silently scored speakers with the development mock. The default raises `speaker_backend_unavailable` (or `model_needed` when the ECAPA ONNX file is the missing piece and no override is set) unless `PODCAST_SPEAKER_BACKEND=mock` is set, so the embedding commands report the missing backend instead of scoring. Setup does not present that as a working backend, and the status payload reports the speaker model as a registry row, so until it is downloaded the feature reads as missing, with a Get row (unavailable only for the mock and override cases).
4. **Resolved: the speaker model is a pinned row.** `speaker-ecapa` is a sha256-pinned registry row, so the lazy first-use download is gone.
5. **Resolved: the RNNoise download is pinned.** The URL is commit-pinned and the sha256 and size are verified. The CDN object upload remains operator work (issue item 1). The read-only [public mirror check](setup.md#check-a-public-bootstrap-mirror) covers item 3 and reports availability without verifying integrity. It resolves the manifest's exact Hugging Face repositories anonymously before any CDN HEAD; the declared turbo metadata endpoint returned HTTP 401 on 2026-11-04, so the current complete inventory fails closed. Runtime pins and fallbacks remain unchanged.

## Decisions (closed)

- The ONNX ECAPA embedding on `onnxruntime` was chosen and shipped (#1998); torch is not in the packaged runtime.
- The silent mock fallback was replaced by an explicit unavailable state (#1999).

