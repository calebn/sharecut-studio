# Model and runtime inventory

Which features use a downloaded model or an optional runtime, where setup covers them today, and what is missing. This is the audit for [#1998](https://github.com/calebn/sharecut-studio/issues/1998) against `main`; update it in the same PR that changes a row. The single authoritative setup catalog it points at is the model registry, `engines/models/registry.py` (`MODELS`). `services/pipeline/bootstrap.py` (`component_status`, `run_bootstrap`) derives from it, and the GUI setup, `podcast bootstrap` and `podcast setup` share it.

"In GUI setup" means the component is a registry row (listed in `ALL_GUI_COMPONENTS`) and can be installed from the packaged app. The frozen sidecar is built with `--extra gui` only (no torch, no joinqc, no speaker extras; see [desktop-packaging.md](desktop-packaging.md) § Frozen sidecar), so a feature whose runtime is a Python extra cannot work in a packaged app by downloading weights alone.

| Feature | Model or runtime | Download path | In GUI setup | Pinned and checked | Packaged app today |
| --- | --- | --- | --- | --- | --- |
| Transcription | Whisper tiers (`faster-whisper` / CTranslate2) | `bootstrap_whisper_model`, pinned HF snapshot | Yes, first-run default | Revision pin, `whisper_model_problem` | Works |
| Voice activity | Silero VAD ONNX, bundled with `faster-whisper` | None | Reported by `podcast doctor` only, not in bootstrap status | n/a | Works |
| Noise reduction | RNNoise `.rnnn` for FFmpeg `arnndn` | `bootstrap_rnnoise_model` | Yes, optional | sha256 when the CDN manifest has one; falls back to the unpinned GitHub raw URL otherwise | Works |
| Precise word boundaries | Forced word aligner (ONNX, `onnxruntime` is a core dependency) | `bootstrap_word_aligner`, pinned HF snapshot | Yes, opt-in | Revision pin, `word_aligner_problem` | Works |
| Speaker recognition and split (primary) | ECAPA embedding network exported to ONNX (`engines/models/speaker_ecapa.py`), `onnxruntime` | `bootstrap_speaker_ecapa`, sha256-pinned file mirrored on the CDN | Yes, opt-in (`speaker-ecapa`) | sha256 pin, `speaker_ecapa_problem` | Works once the file is published to the CDN and downloaded |
| Speaker recognition (torch, source installs) | SpeechBrain ECAPA (`speechbrain/spkrec-ecapa-voxceleb`) plus `torch` | Lazy `EncoderClassifier.from_hparams` on first use, `savedir=None` | No | No revision pin, no integrity check, no readiness state | Runtime absent; the ONNX backend replaces it |
| Speaker recognition and split (fallback) | Resemblyzer `VoiceEncoder` (its weights ship in the wheel) plus `numba`/`librosa` | Python extra `speaker-lite` | No | Wheel hash only | Runtime absent, so unavailable |
| Join quality, continuity | WavLM (`transformers`, revision pinned in `join_neural.py`) plus `torch` | Lazy `from_pretrained` on first use | No | Revision pinned; no readiness state | Runtime absent, so the STFT embedding fallback runs |
| Join quality, discontinuity | "NISQA" | None; weights are user-supplied via `PODCAST_MCP_NISQA_MODEL` | No (not a registry row) | No | The scoring in `join_neural.py` is a spectral proxy; real NISQA inference is not integrated |

## Findings

1. **NISQA is not a ready integration.** The join scorer falls back to a spectral proxy, so the registry has no NISQA row and `bootstrap` no longer fetches its placeholder weights. Only a user-supplied `PODCAST_MCP_NISQA_MODEL` directory is read, until real inference is separately scoped.
2. **Speaker backends were the real gap.** Neither torch backend can run in the packaged app; the ONNX ECAPA component (#1998, option A below) fixes that once its file is published. Whatever the fix is, it needs a runtime decision first (see below), then catalog entries, readiness checks and tests.
3. **(Fixed by #1999.) `resolve_speaker_backend()` with no argument fell back to `MockSpeakerBackend`** when neither real backend imports, so a packaged app silently scored speakers with the development mock. The default now raises `speaker_backend_unavailable` unless `PODCAST_SPEAKER_BACKEND=mock` is set, so the embedding commands report the missing backend instead of scoring. Setup must not present that as a working backend, and the status payload should say the speaker feature is unavailable rather than ready.
4. **Lazy, unpinned downloads.** ECAPA downloads at first use with no revision pin and no offline story; WavLM pins a revision but also downloads at first use. Both bypass the consent, progress, cancel and retry flow the catalog components get.
5. **The RNNoise fallback URL is unpinned.** When the CDN manifest has no sha256, the download uses a GitHub raw URL and is not verified.

## Decision needed before building the speaker slice

The packaged runtime has no torch. Options, with the cost of each:

- **Ship an ONNX export of the ECAPA embedding** and run it on `onnxruntime` (already core, like the word aligner). Small, no torch, fits the existing pinned-snapshot component pattern. Needs an export that matches current embeddings closely enough that enrolled profiles keep scoring the same, which needs a Mac lab comparison.
- **Add torch to the frozen runtime** behind an opt-in download of a second runtime pack. Largest download (hundreds of MB per platform), new freeze and signing paths, and per-platform wheel handling.
- **Leave speaker features source-install only** and mark them unavailable in the app with an honest explanation.

Recommendation: the ONNX route, with the unavailable state (third option) as the interim behaviour so the app never claims a mock backend is working.

## Planned slices

1. This inventory, plus the registry carrying no NISQA row (its weights are user-supplied) and the speaker features as unavailable in packaged installs (status only, no new downloads).
2. (Done by #1999.) Replace the silent mock fallback in the app path with an explicit unavailable state.
3. Speaker backend component once the runtime decision is made.
4. WavLM component, if a torch-free route exists; otherwise documented as source-only.
