"""ASR decode / VAD options for faster-whisper (issue #521).

Whisper hallucinates text over silence (typically low-volume bleed tracks).
Defaults run faster-whisper's built-in Silero VAD (the same bundled model as
``engines/vad_silero.py``) and hallucination-safe decode settings. The single
source of truth for defaults is ``.agents/defaults/pipeline.yaml`` ``transcribe``;
engines built without options read it via ``AsrOptions.from_defaults()``. The dataclass
values below are only the fallback for missing or invalid keys (a test keeps them equal
to the yaml).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from podcast_mcp.config import bounded_float
from podcast_mcp.util.dicts import get_by_path
from podcast_mcp.word_aligner_models import (
    DEFAULT_WORD_ALIGNER,
    WORD_ALIGNER_BOOTSTRAP,
    WordAlignerMissingError,
    WordAlignerPinMismatchError,
    word_aligner_installed,
    word_aligner_problem,
)

DEFAULT_TEMPERATURE: tuple[float, ...] = (0.0, 0.2, 0.4)
FASTER_WHISPER_TEMPERATURE: tuple[float, ...] = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


@dataclass(frozen=True)
class ForcedAlignment:
    """``transcribe.forced_alignment.enabled`` resolved against the installed word aligner (#780).

    ``requested`` is the config value: ``None`` (unset) follows the model, ``False`` keeps
    Whisper's times, ``True`` requires the aligner. ``installed`` is ``word_aligner_installed``
    at resolve time. Everything else derives from those two, so every reader (engine, step
    report, Studio toggle) sees one decision.
    """

    requested: bool | None
    installed: bool
    model: str = DEFAULT_WORD_ALIGNER

    @classmethod
    def resolve(cls, requested: object) -> ForcedAlignment:
        return cls(
            requested=None if requested is None else bool(requested),
            installed=word_aligner_installed(DEFAULT_WORD_ALIGNER),
        )

    @property
    def enabled(self) -> bool:
        return self.installed and self.requested is not False

    @property
    def blocked(self) -> bool:
        """Explicitly turned on without the model: a run must fail, never fall back silently."""
        return self.requested is True and not self.installed

    @property
    def reason(self) -> str:
        missing = f"word aligner {self.model!r} is not downloaded ({WORD_ALIGNER_BOOTSTRAP})"
        if self.requested is False:
            return "off: transcribe.forced_alignment.enabled is false"
        if self.requested is True:
            if self.installed:
                return "on: transcribe.forced_alignment.enabled is true"
            return f"blocked: transcribe.forced_alignment.enabled is true but {missing}"
        if self.installed:
            return f"on by default: word aligner {self.model!r} is installed"
        return f"unavailable: {missing}"

    def require(self) -> None:
        """An explicit ``true`` needs a verified model: raise the download or ``--upgrade`` hint.

        Only the explicit flag pays for the pin hash (seconds on the 360 MB ONNX); the default
        keeps the presence check and lets a corrupt snapshot fail at load, reported per job.
        """
        if self.requested is not True:
            return
        problem = word_aligner_problem(self.model)
        if problem is None:
            return
        if not self.installed or not isinstance(problem, WordAlignerPinMismatchError):
            raise WordAlignerMissingError(
                self.model,
                "transcribe.forced_alignment.enabled is true; unset it to follow the "
                "installed model or set it to false for Whisper's times",
            )
        raise problem

    def report(self) -> dict[str, Any]:
        """The ``forced_alignment`` block of ``artifacts/transcript_timing.json`` and the config payload."""
        return {
            "enabled": self.enabled,
            "model": self.model if self.enabled else None,
            "requested": self.requested,
            "installed": self.installed,
            "blocked": self.blocked,
            "reason": self.reason,
        }


def _section(defaults: Mapping[str, Any], path: str) -> Mapping[str, Any]:
    node = get_by_path(defaults, path)
    return node if isinstance(node, Mapping) else {}


def _temperatures(value: Any, default: tuple[float, ...]) -> tuple[float, ...]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = [value]
    if not isinstance(value, (list, tuple)) or not value:
        return default
    return tuple(bounded_float(v, 0.0, 0.0, 1.0) for v in value)


@dataclass(frozen=True)
class AsrOptions:
    language: str | None = "en"
    vad_enabled: bool = True
    vad_threshold: float = 0.4
    vad_min_silence_ms: int = 500
    vad_speech_pad_ms: int = 300
    temperature: tuple[float, ...] = DEFAULT_TEMPERATURE
    no_speech_threshold: float = 0.6
    log_prob_threshold: float = -1.0
    compression_ratio_threshold: float = 2.4
    condition_on_previous_text: bool = True
    hallucination_silence_threshold: float | None = 2.0
    silence_filter_enabled: bool = True
    silence_peak_dbfs: float = -60.0
    # Not part of decode_key(): alignment has its own cache beside the ASR cache,
    # so toggling it never re-runs Whisper. The default follows the installed model.
    forced_alignment: ForcedAlignment = field(default_factory=lambda: ForcedAlignment.resolve(None))
    # Flag-only threshold on TranscriptWord.alignment_score; not a decode_key input. A low
    # score flags a word only when its own track carries no speech over the aligned span
    # (below the noise floor + speech margin) or another dialogue track is louder there by
    # the bleed margin (#780).
    forced_alignment_min_word_score: float = 0.01
    forced_alignment_speech_margin_db: float = 12.0
    forced_alignment_bleed_margin_db: float = 3.0

    @property
    def forced_alignment_enabled(self) -> bool:
        return self.forced_alignment.enabled

    @classmethod
    def from_defaults(cls, defaults: Mapping[str, Any] | None = None) -> AsrOptions:
        if defaults is None:
            from podcast_mcp.config import load_defaults

            defaults = load_defaults()
        base = cls()
        vad = _section(defaults, "transcribe.vad")
        dec = _section(defaults, "transcribe.decode")
        sil = _section(defaults, "transcribe.silence_filter")
        fa = _section(defaults, "transcribe.forced_alignment")
        hst = dec.get("hallucination_silence_threshold", base.hallucination_silence_threshold)
        return cls(
            language=_section(defaults, "transcribe").get("language", base.language),
            vad_enabled=bool(vad.get("enabled", base.vad_enabled)),
            vad_threshold=bounded_float(vad.get("threshold"), base.vad_threshold, 0.0, 1.0),
            vad_min_silence_ms=int(
                bounded_float(
                    vad.get("min_silence_duration_ms"), base.vad_min_silence_ms, 0, 60_000
                )
            ),
            vad_speech_pad_ms=int(
                bounded_float(vad.get("speech_pad_ms"), base.vad_speech_pad_ms, 0, 10_000)
            ),
            temperature=_temperatures(dec.get("temperature"), base.temperature),
            no_speech_threshold=bounded_float(
                dec.get("no_speech_threshold"), base.no_speech_threshold, 0.0, 1.0
            ),
            log_prob_threshold=bounded_float(
                dec.get("log_prob_threshold"), base.log_prob_threshold, -10.0, 0.0
            ),
            compression_ratio_threshold=bounded_float(
                dec.get("compression_ratio_threshold"),
                base.compression_ratio_threshold,
                0.0,
                20.0,
            ),
            condition_on_previous_text=bool(
                dec.get("condition_on_previous_text", base.condition_on_previous_text)
            ),
            # None or 0 disables the hallucination skip.
            hallucination_silence_threshold=(
                None if hst is None else bounded_float(hst, 2.0, 0.0, 60.0) or None
            ),
            silence_filter_enabled=bool(sil.get("enabled", base.silence_filter_enabled)),
            silence_peak_dbfs=bounded_float(
                sil.get("peak_dbfs"), base.silence_peak_dbfs, -120.0, 0.0
            ),
            forced_alignment=ForcedAlignment.resolve(fa.get("enabled")),
            forced_alignment_min_word_score=bounded_float(
                fa.get("min_word_score"), base.forced_alignment_min_word_score, 0.0, 1.0
            ),
            forced_alignment_speech_margin_db=bounded_float(
                fa.get("evidence_speech_margin_db"),
                base.forced_alignment_speech_margin_db,
                0.0,
                60.0,
            ),
            forced_alignment_bleed_margin_db=bounded_float(
                fa.get("evidence_bleed_margin_db"),
                base.forced_alignment_bleed_margin_db,
                0.0,
                60.0,
            ),
        )

    @classmethod
    def faster_whisper_defaults(cls) -> AsrOptions:
        """What ``WhisperModel.transcribe`` does with no options (pre-#521 behaviour)."""
        return cls(
            vad_enabled=False,
            temperature=FASTER_WHISPER_TEMPERATURE,
            hallucination_silence_threshold=None,
        )

    @property
    def is_faster_whisper_default(self) -> bool:
        """True when decode settings match faster-whisper's own (legacy cache is valid)."""
        return self.decode_key() == type(self).faster_whisper_defaults().decode_key()

    def _vad_parameters(self) -> dict[str, Any]:
        return {
            "threshold": self.vad_threshold,
            "min_silence_duration_ms": self.vad_min_silence_ms,
            "speech_pad_ms": self.vad_speech_pad_ms,
        }

    def _decode_kwargs(self) -> dict[str, Any]:
        return {
            "temperature": list(self.temperature),
            "no_speech_threshold": self.no_speech_threshold,
            "log_prob_threshold": self.log_prob_threshold,
            "compression_ratio_threshold": self.compression_ratio_threshold,
            "condition_on_previous_text": self.condition_on_previous_text,
            "hallucination_silence_threshold": self.hallucination_silence_threshold,
        }

    def decode_key(self) -> dict[str, Any]:
        """JSON-safe cache-key input; VAD params only count when VAD is on."""
        return {
            "vad": self._vad_parameters() if self.vad_enabled else None,
            **self._decode_kwargs(),
        }

    def transcribe_kwargs(self, initial_prompt: str | None = None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"vad_filter": self.vad_enabled, **self._decode_kwargs()}
        if self.vad_enabled:
            kwargs["vad_parameters"] = self._vad_parameters()
        if initial_prompt:
            # Without conditioning, initial_prompt only reaches the first window;
            # hotwords is applied to every window.
            kwargs["initial_prompt" if self.condition_on_previous_text else "hotwords"] = (
                initial_prompt
            )
        return kwargs
