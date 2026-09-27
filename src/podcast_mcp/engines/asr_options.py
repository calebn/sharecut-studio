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
from dataclasses import dataclass
from typing import Any

from podcast_mcp.config import bounded_float
from podcast_mcp.util.dicts import get_by_path

DEFAULT_TEMPERATURE: tuple[float, ...] = (0.0, 0.2, 0.4)
FASTER_WHISPER_TEMPERATURE: tuple[float, ...] = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


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

    @classmethod
    def from_defaults(cls, defaults: Mapping[str, Any] | None = None) -> AsrOptions:
        if defaults is None:
            from podcast_mcp.config import load_defaults

            defaults = load_defaults()
        base = cls()
        vad = _section(defaults, "transcribe.vad")
        dec = _section(defaults, "transcribe.decode")
        sil = _section(defaults, "transcribe.silence_filter")
        hst = dec.get("hallucination_silence_threshold", base.hallucination_silence_threshold)
        return cls(
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
