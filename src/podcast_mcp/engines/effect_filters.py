"""FFmpeg filter formatters and the authoritative supported-effect registry."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Any

from podcast_mcp.util.model_assets import resolve_rnnoise_model

EffectFormatter = Callable[[Mapping[str, Any]], str]


def _compressor(params: Mapping[str, Any]) -> str:
    rendered = (
        f"acompressor=threshold={params.get('threshold_db', -18)}dB"
        f":ratio={params.get('ratio', 3)}"
        f":attack={params.get('attack_ms', 15)}"
        f":release={params.get('release_ms', 150)}"
    )
    makeup = float(params.get("makeup_db", 0))
    return f"{rendered}:makeup={makeup}" if makeup != 0.0 else rendered


def _escape_filter_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def require_rnnoise_model() -> Path:
    """The ready RNNoise model; ``ModelMissing`` (no path) when it is not downloaded."""
    from podcast_mcp.engines.models.registry import require_model

    require_model("rnnoise")
    return resolve_rnnoise_model()


def _arnndn(params: Mapping[str, Any]) -> str:
    model = params.get("model") or str(require_rnnoise_model())
    return f"arnndn=m={_escape_filter_value(model)}"


_EFFECT_FORMATTERS: Mapping[str, EffectFormatter] = MappingProxyType(
    {
        "highpass": lambda p: f"highpass=f={int(p.get('frequency', 80))}",
        "acompressor": _compressor,
        "loudnorm": lambda p: (
            f"loudnorm=I={p.get('integrated_lufs', -16)}:TP={p.get('true_peak_db', -1.5)}:LRA=11"
        ),
        "afftdn": lambda p: f"afftdn=nr={p.get('nr', 12)}:nf={p.get('nf', -25)}",
        "arnndn": _arnndn,
        "bandreject": lambda p: (
            f"bandreject=f={p.get('f', 6500)}:width_type=h:w={p.get('w', 3000)}"
        ),
        "deesser": lambda p: f"deesser=i={p.get('intensity', 0.5)}:f={p.get('frequency', 0.5)}",
        "agate": lambda p: (
            f"agate=threshold={p.get('threshold_db', -30)}dB"
            f":range={p.get('range_db', -20)}dB"
            f":attack={p.get('attack_ms', 5)}"
            f":release={p.get('release_ms', 50)}"
        ),
        "equalizer": lambda p: (
            f"equalizer=f={p.get('f', 1000)}:t={p.get('t', 'q')}"
            f":w={p.get('w', 1.0)}:g={p.get('g', 0)}"
        ),
    }
)


def supported_effect_names() -> tuple[str, ...]:
    """Return the stable, sorted names this renderer can apply to an FX chain."""
    return tuple(sorted(_EFFECT_FORMATTERS))


def is_supported_effect(effect: str) -> bool:
    return effect in _EFFECT_FORMATTERS


def format_effect(effect: str, params: Mapping[str, Any]) -> str | None:
    """Format a supported effect; unknown saved names remain render-skipped."""
    formatter = _EFFECT_FORMATTERS.get(effect)
    return formatter(params) if formatter is not None else None


# Filters that run at one sample rate only and change what a window and the stem share. FFmpeg
# negotiates that rate back through the whole graph, so a render resamples each recording to it
# before ``atrim`` and every piece, fade and join runs at it (#2456). ``loudnorm`` (192 kHz) is
# left out: a sample there is 5 microseconds, and its restore paths place the mix before the
# final resample on purpose.
_FORCED_RATE_FILTERS = {"arnndn": 48_000}
_FORCED_RATE_FILTER = re.compile(rf"(?:^|,)({'|'.join(_FORCED_RATE_FILTERS)})(?:=|,|$)")


def graph_rate(af: str) -> int | None:
    """The rate a render's pieces run at when ``af`` holds a one-rate filter, else None."""
    found = _FORCED_RATE_FILTER.search(af)
    return _FORCED_RATE_FILTERS[found.group(1)] if found else None
