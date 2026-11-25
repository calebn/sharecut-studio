from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import CrossfadeJoinsResult, FadeJoinsResult

FADE_KEYS = [
    "operation",
    "join_count",
    "fade_ms",
    "requested_fade_ms",
    "cap_ms",
    "kept_longer_joins",
    "dry_run",
    "affected_tracks",
]
CROSSFADE_KEYS = [
    "operation",
    "join_count",
    "fade_ms",
    "requested_fade_ms",
    "clamped_joins",
    "dry_run",
    "affected_tracks",
]


def _fade(**over):
    base = {
        "operation": "fade_joins",
        "join_count": 2,
        "fade_ms": 10,
        "requested_fade_ms": 10,
        "cap_ms": 40,
        "kept_longer_joins": 1,
        "dry_run": False,
        "affected_tracks": ["host"],
    }
    return {**base, **over}


def _crossfade(**over):
    base = {
        "operation": "crossfade_joins",
        "join_count": 2,
        "fade_ms": 25,
        "requested_fade_ms": None,
        "clamped_joins": 1,
        "dry_run": True,
        "affected_tracks": ["host", "guest"],
    }
    return {**base, **over}


MODELS = [
    pytest.param(FadeJoinsResult, _fade, FADE_KEYS, id="fade"),
    pytest.param(CrossfadeJoinsResult, _crossfade, CROSSFADE_KEYS, id="crossfade"),
]


@pytest.mark.parametrize(("model", "build", "keys"), MODELS)
def test_dump_key_order(model, build, keys):
    assert list(model(**build()).model_dump()) == keys


@pytest.mark.parametrize(("model", "build", "keys"), MODELS)
def test_dump_values(model, build, keys):
    assert model(**build()).model_dump() == build()


def test_fade_ms_none_kept_as_null():
    dumped = FadeJoinsResult(**_fade(fade_ms=None, requested_fade_ms=None)).model_dump()
    assert list(dumped) == FADE_KEYS
    assert dumped["fade_ms"] is None
    assert dumped["requested_fade_ms"] is None


def test_crossfade_requested_none_kept_as_null():
    dumped = CrossfadeJoinsResult(**_crossfade(requested_fade_ms=None)).model_dump()
    assert list(dumped) == CROSSFADE_KEYS
    assert dumped["requested_fade_ms"] is None


def test_crossfade_fade_ms_is_never_null():
    with pytest.raises(ValidationError):
        CrossfadeJoinsResult(**_crossfade(fade_ms=None))


@pytest.mark.parametrize(("model", "build", "keys"), MODELS)
def test_frozen(model, build, keys):
    result = model(**build())
    with pytest.raises(ValidationError):
        result.join_count = 9


@pytest.mark.parametrize(("model", "build", "keys"), MODELS)
def test_extra_forbidden(model, build, keys):
    with pytest.raises(ValidationError):
        model(**build(extra_key=1))


def test_fade_does_not_accept_crossfade_keys():
    with pytest.raises(ValidationError):
        FadeJoinsResult(**_fade(clamped_joins=0))


def test_crossfade_does_not_accept_fade_keys():
    with pytest.raises(ValidationError):
        CrossfadeJoinsResult(**_crossfade(cap_ms=40))


@pytest.mark.parametrize(("model", "build", "keys"), MODELS)
def test_operation_literal_rejected(model, build, keys):
    with pytest.raises(ValidationError):
        model(**build(operation="other"))


def test_operation_of_the_other_model_rejected():
    with pytest.raises(ValidationError):
        FadeJoinsResult(**_fade(operation="crossfade_joins"))
    with pytest.raises(ValidationError):
        CrossfadeJoinsResult(**_crossfade(operation="fade_joins"))


@pytest.mark.parametrize(("model", "build", "keys"), MODELS)
@pytest.mark.parametrize("field", ["join_count", "fade_ms", "dry_run", "affected_tracks"])
def test_wrong_type_rejected(model, build, keys, field):
    with pytest.raises(ValidationError):
        model(**build(**{field: [1]}))


@pytest.mark.parametrize(("model", "build", "keys"), MODELS)
def test_every_field_required(model, build, keys):
    for missing in keys:
        data = build()
        del data[missing]
        with pytest.raises(ValidationError):
            model(**data)
