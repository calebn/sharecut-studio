# Model and runtime inventory

Which features use a downloaded model or an optional runtime, where setup covers them today, and what is missing. This is the audit for [#1998](https://github.com/calebn/sharecut-studio/issues/1998) against `main`; update it in the same PR that changes a row. The single authoritative setup catalog it points at is the model registry, `engines/models/registry.py` (`MODELS`). `services/pipeline/bootstrap.py` (`component_status`, `run_bootstrap`) derives from it, and the GUI setup, `podcast bootstrap` and `podcast setup` share it.

"In GUI setup" means the component is a registry row (listed in `ALL_GUI_COMPONENTS`) and can be installed from the packaged app. The frozen sidecar is built with `--extra gui` only (no torch; see [desktop-packaging.md](desktop-packaging.md) § Frozen sidecar), so a feature whose runtime is a Python extra cannot work in a packaged app by downloading weights alone.

| Feature | Model or runtime | Download path | In GUI setup | Pinned and checked | Packaged app today |
| --- | --- | --- | --- | --- | --- |
| Transcription | Whisper tiers (`faster-whisper` / CTranslate2) | `bootstrap_whisper_model`, pinned HF snapshot | Yes, first-run default | Revision pin, `whisper_model_problem` | Works |
| Voice activity | Silero VAD ONNX, bundled with `faster-whisper` | None | Reported by `podcast doctor` only, not in bootstrap status | n/a | Works |
| Noise reduction | RNNoise `.rnnn` for FFmpeg `arnndn` | `bootstrap_rnnoise_model` | Yes, optional | sha256 and size_bytes pinned in contracts/bootstrap-assets.json; GitHub source is a commit-pinned raw URL (GregorR/rnnoise-models@3eee541); CDN copy not yet uploaded | Works |
| Precise word boundaries | Forced word aligner (ONNX, `onnxruntime` is a core dependency) | `bootstrap_word_aligner`, pinned HF snapshot | Yes, opt-in | Revision pin, `word_aligner_problem` | Works |
| Speaker recognition and split | ECAPA embedding network exported to ONNX (`engines/models/speaker_ecapa.py`), `onnxruntime` | `bootstrap_speaker_ecapa`, sha256-pinned file at a direct first-party CDN url | Yes, opt-in (`speaker-ecapa`) | sha256 pin, `speaker_ecapa_problem` | Works once downloaded |

## Findings

1. **Join quality has no model.** #2256 removed the WavLM and NISQA-named layer (it never ran in a default install; the bake-off had no real labelled fails to rank it against the numpy detector fusion). Continuity is the numpy detector fusion only, so there is nothing to download or set up for it.
2. **Speaker backends were the real gap.** The torch backends could not run in the packaged app; the ONNX ECAPA component (#1998, option A below) fixed that and is now the only speaker model. Whatever the fix is, it needs a runtime decision first (see below), then catalog entries, readiness checks and tests.
3. **(Fixed by #1999.) `resolve_speaker_backend()` with no argument fell back to `MockSpeakerBackend`** when neither real backend imports, so a packaged app silently scored speakers with the development mock. The default now raises `speaker_backend_unavailable` (or `model_needed` when the ECAPA ONNX file is the missing piece and no override is set) unless `PODCAST_SPEAKER_BACKEND=mock` is set, so the embedding commands report the missing backend instead of scoring. Setup must not present that as a working backend, and the status payload should say the speaker feature is unavailable rather than ready.
4. **Lazy, unpinned downloads.** ECAPA downloads at first use with no revision pin and no offline story. That bypasses the consent, progress, cancel and retry flow the catalog components get.
5. **Resolved: the RNNoise download is pinned.** The URL is commit-pinned and the sha256 and size are verified. Remaining gaps: the CDN object is not uploaded yet (issue item 1) and the live mirror check (item 3).

## Decision needed before building the speaker slice

The packaged runtime has no torch. Options, with the cost of each:

- **Ship an ONNX export of the ECAPA embedding** and run it on `onnxruntime` (already core, like the word aligner). Small, no torch, fits the existing pinned-snapshot component pattern. Needs an export that matches current embeddings closely enough that enrolled profiles keep scoring the same, which needs a Mac lab comparison.
- **Add torch to the frozen runtime** behind an opt-in download of a second runtime pack. Largest download (hundreds of MB per platform), new freeze and signing paths, and per-platform wheel handling.
- **Leave speaker features source-install only** and mark them unavailable in the app with an honest explanation.

Recommendation: the ONNX route, with the unavailable state (third option) as the interim behaviour so the app never claims a mock backend is working.

## Planned slices

1. This inventory, plus the speaker features as unavailable in packaged installs (status only, no new downloads).
2. (Done by #1999.) Replace the silent mock fallback in the app path with an explicit unavailable state.
3. Speaker backend component once the runtime decision is made.
