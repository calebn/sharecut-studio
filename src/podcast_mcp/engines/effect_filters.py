"""FFmpeg filter formatters and the authoritative supported-effect registry."""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.model_assets import resolve_rnnoise_model

EffectFormatter = Callable[[Mapping[str, Any]], str]


@dataclass(frozen=True)
class _Number:
    low: float
    high: float
    integer: bool = False


@dataclass(frozen=True)
class _Choice:
    options: frozenset[str]


@dataclass(frozen=True)
class _Text:
    pass


_Param = _Number | _Choice | _Text

_EFFECT_PARAMS: Mapping[str, Mapping[str, _Param]] = MappingProxyType(
    {
        "highpass": {"frequency": _Number(1, 96_000, integer=True)},
        "acompressor": {
            "threshold_db": _Number(-60, 0),
            "ratio": _Number(1, 20),
            "attack_ms": _Number(0.01, 2000),
            "release_ms": _Number(0.01, 9000),
            "makeup_db": _Number(0, 64),
        },
        "loudnorm": {"integrated_lufs": _Number(-70, -5), "true_peak_db": _Number(-9, 0)},
        "afftdn": {"nr": _Number(0.01, 97), "nf": _Number(-80, -20)},
        "arnndn": {"model": _Text()},
        "bandreject": {"f": _Number(1, 96_000), "w": _Number(1, 96_000)},
        "deesser": {"intensity": _Number(0, 1), "frequency": _Number(0, 1)},
        "agate": {
            "threshold_db": _Number(-60, 0),
            "range_db": _Number(-90, 0),
            "attack_ms": _Number(0.01, 9000),
            "release_ms": _Number(0.01, 9000),
        },
        "equalizer": {
            "f": _Number(1, 96_000),
            "t": _Choice(frozenset("qhosk")),
            "w": _Number(0.01, 96_000),
            "g": _Number(-60, 60),
        },
    }
)


_FILTERGRAPH_SYNTAX = frozenset(",;[]")


def _invalid(effect: str, key: str, why: str) -> CodedValueError:
    return CodedValueError(
        f"invalid {effect} parameter {key!r}: {why}", code="invalid_effect_params"
    )


def _coerce(effect: str, key: str, spec: _Param, value: Any) -> int | float | str:
    if isinstance(spec, _Choice):
        if not isinstance(value, str) or value not in spec.options:
            raise _invalid(effect, key, f"must be one of {', '.join(sorted(spec.options))}")
        return value
    if isinstance(spec, _Text):
        if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
            raise _invalid(effect, key, "must be a non-empty single-line string")
        if any(c in _FILTERGRAPH_SYNTAX for c in value):
            raise _invalid(effect, key, "must not contain , ; [ or ]")
        return value
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        raise _invalid(effect, key, "must be a number")
    try:
        number = float(value)
    except ValueError:
        raise _invalid(effect, key, "must be a number") from None
    if not math.isfinite(number) or not spec.low <= number <= spec.high:
        raise _invalid(effect, key, f"must be between {spec.low:g} and {spec.high:g}")
    return int(number) if spec.integer or number.is_integer() else number


def validate_effect_params(effect: str, params: Mapping[str, Any] | None) -> dict[str, Any]:
    """The params coerced to their bounded types; unknown keys and unsafe values are refused.

    Effects this renderer does not know pass through: they are never rendered.
    """
    if params is not None and not isinstance(params, Mapping):
        raise CodedValueError(f"{effect} params must be an object", code="invalid_effect_params")
    schema = _EFFECT_PARAMS.get(effect)
    given = dict(params or {})
    if schema is None:
        return given
    unknown = sorted(set(given) - set(schema))
    if unknown:
        allowed = ", ".join(sorted(schema)) or "none"
        raise CodedValueError(
            f"unknown {effect} parameter {unknown[0]!r}; allowed: {allowed}",
            code="invalid_effect_params",
        )
    return {key: _coerce(effect, key, schema[key], value) for key, value in given.items()}


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


# Effects whose output depends on the audio before it (loudness, noise estimate, envelopes): a
# window rendered cold differs from the same window inside the whole track.
ADAPTIVE_EFFECTS = frozenset({"loudnorm", "afftdn", "arnndn", "acompressor", "agate", "deesser"})


def supported_effect_names() -> tuple[str, ...]:
    """Return the stable, sorted names this renderer can apply to an FX chain."""
    return tuple(sorted(_EFFECT_FORMATTERS))


def is_supported_effect(effect: str) -> bool:
    return effect in _EFFECT_FORMATTERS


def format_effect(effect: str, params: Mapping[str, Any]) -> str | None:
    """Format a supported effect; unknown saved names remain render-skipped."""
    formatter = _EFFECT_FORMATTERS.get(effect)
    if formatter is None:
        return None
    return formatter(validate_effect_params(effect, params))


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
