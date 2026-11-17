"""An episode file's validation error names no key of the file (a speaker's name is one)."""

from __future__ import annotations

import copy
import enum
import json
import traceback
import types
import typing
from collections.abc import Mapping

import pytest
from pydantic import BaseModel, ValidationError

from podcast_mcp.models.episode import EpisodeProject, ProjectUnreadableError, load_project

MARK = "ZQKEYMARK4417"


def _write(path, data) -> None:
    path.write_text(json.dumps(data))


def test_a_damaged_dict_value_names_the_field_and_not_the_key(minimal_project):
    data = json.loads(minimal_project.read_text())
    data["meta"]["ingest_alignment"] = {MARK: {"align_method": 7}}
    _write(minimal_project, data)
    with pytest.raises(ProjectUnreadableError) as caught:
        load_project(minimal_project)
    assert "unexpected contents at meta.ingest_alignment.*.align_method" in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__
    text = "".join(traceback.format_exception(caught.value))
    assert MARK not in text
    assert "validation error" not in text


def _walk(ann, steps, out, seen):
    origin = typing.get_origin(ann)
    args = typing.get_args(ann)
    if origin is typing.Annotated:
        _walk(args[0], steps, out, seen)
    elif origin in (typing.Union, types.UnionType):
        for arg in args:
            if arg is not type(None):
                _walk(arg, steps, out, seen)
    elif isinstance(ann, type) and issubclass(ann, BaseModel):
        if ann in seen:
            return
        for name, field in ann.model_fields.items():
            _walk(field.annotation, [*steps, ("field", field.alias or name)], out, seen | {ann})
    elif origin in (list, set, frozenset, tuple, typing.Sequence):
        for arg in args:
            if arg is not Ellipsis:
                _walk(arg, [*steps, ("item",)], out, seen)
    elif origin is dict or (isinstance(origin, type) and issubclass(origin, Mapping)):
        if args and args[0] is str:
            out.append(steps)
        if len(args) == 2:
            _walk(args[1], [*steps, ("key",)], out, seen)


def dict_positions() -> list[list[tuple[str, ...]]]:
    found: list[list[tuple[str, ...]]] = []
    _walk(EpisodeProject, [], found, frozenset())
    return found


def _name(steps) -> str:
    return ".".join(s[1] if s[0] == "field" else "[]" if s[0] == "item" else "{}" for s in steps)


def _merge(base, over):
    if isinstance(base, dict) and isinstance(over, dict):
        merged = dict(base)
        for key, value in over.items():
            merged[key] = _merge(base.get(key), value)
        return merged
    return over


def _damage(base: dict, steps) -> dict:
    """``base`` with, at the dict position ``steps``, one marker key whose value is invalid."""

    def make(index: int):
        if index == len(steps):
            return {MARK: [MARK]}
        step = steps[index]
        if step[0] == "field":
            return {step[1]: make(index + 1)}
        if step[0] == "item":
            return [make(index + 1)]
        return {MARK: make(index + 1)}

    damaged = _merge(copy.deepcopy(base), make(0))
    _fill(EpisodeProject, damaged)
    return damaged


def _unwrap(ann):
    while True:
        origin = typing.get_origin(ann)
        args = typing.get_args(ann)
        if origin is typing.Annotated:
            ann = args[0]
        elif origin in (typing.Union, types.UnionType):
            rest = [a for a in args if a is not type(None)]
            if len(rest) != 1:
                return ann
            ann = rest[0]
        else:
            return ann


def _sample(ann):
    """Some valid value for ``ann``: enough to let a parent of the damaged dict validate."""
    ann = _unwrap(ann)
    origin = typing.get_origin(ann)
    if origin is typing.Literal:
        return typing.get_args(ann)[0]
    if origin in (list, set, frozenset, tuple, typing.Sequence):
        return []
    if origin is dict or (isinstance(origin, type) and issubclass(origin, Mapping)):
        return {}
    if isinstance(ann, type):
        if issubclass(ann, BaseModel):
            value: dict = {}
            _fill(ann, value)
            return value
        if issubclass(ann, enum.Enum):
            return next(iter(ann)).value
        if issubclass(ann, bool):
            return False
        if issubclass(ann, int):
            return 1
        if issubclass(ann, float):
            return 1.0
        if issubclass(ann, str):
            return "x"
    return None


def _fill(ann, value) -> None:
    """Add, under ``value``, a sample for every required field of ``ann`` that it lacks."""
    ann = _unwrap(ann)
    origin = typing.get_origin(ann)
    args = typing.get_args(ann)
    if isinstance(ann, type) and issubclass(ann, BaseModel) and isinstance(value, dict):
        for name, field in ann.model_fields.items():
            key = field.alias or name
            if key in value:
                _fill(field.annotation, value[key])
            elif field.is_required():
                value[key] = _sample(field.annotation)
    elif origin in (list, set, frozenset, tuple, typing.Sequence) and isinstance(value, list):
        for item in value:
            _fill(args[0], item)
    elif origin is dict and isinstance(value, dict) and len(args) == 2:
        for item in value.values():
            _fill(args[1], item)


def test_the_walk_finds_the_dict_keyed_fields_of_the_episode_model():
    names = {_name(steps) for steps in dict_positions()}
    assert "meta.ingest_alignment" in names
    assert "editorial.session_suggestions.[].track_follows" in names
    assert "editorial.edit_decisions.[].exact_range.media_seals" in names
    assert "render.proxy_manifests.[].project_basis.render_hashes" in names
    assert len(names) >= 10


def _reachable(minimal_project):
    base = json.loads(minimal_project.read_text())
    for steps in dict_positions():
        data = _damage(base, steps)
        try:
            EpisodeProject.model_validate(data)
        except ValidationError as exc:
            hits = [e["loc"] for e in exc.errors() if MARK in map(str, e["loc"])]
            if hits:
                yield steps, data, hits[0]


def test_most_dict_positions_can_be_damaged_with_one_marker_key(minimal_project):
    reached = {_name(steps) for steps, _data, _loc in _reachable(minimal_project)}
    assert "meta.ingest_alignment" in reached
    assert len(reached) >= 3


def test_no_dict_key_of_the_episode_model_reaches_an_error_text(minimal_project):
    from podcast_mcp.models.episode import _safe_location

    checked = 0
    for steps, data, loc in _reachable(minimal_project):
        place = _safe_location(EpisodeProject, loc)
        assert MARK not in place, (_name(steps), place)
        assert "*" in place.split("."), (_name(steps), place)
        _write(minimal_project, data)
        with pytest.raises(ProjectUnreadableError) as caught:
            load_project(minimal_project)
        text = "".join(traceback.format_exception(caught.value))
        assert MARK not in text, (_name(steps), text)
        checked += 1
    assert checked >= 3


@pytest.mark.parametrize(
    ("loc", "expected"),
    [
        (("meta", "name"), "meta.name"),
        (("timeline", "clips", 3, "track_id"), "timeline.clips.3.track_id"),
        (
            ("meta", "ingest_alignment", "Zelda", "align_method"),
            "meta.ingest_alignment.*.align_method",
        ),
        (
            ("meta", "ingest_alignment", "12", "align_method"),
            "meta.ingest_alignment.*.align_method",
        ),
        (("meta", "ingest_alignment", "Zelda", "[key]"), "meta.ingest_alignment.*.*"),
        (("nothing", "here"), "*.*"),
        (("meta", "nothing", 4, "x"), "meta.*.4.*"),
    ],
)
def test_the_location_keeps_numbers_and_declared_names_only(loc, expected):
    from podcast_mcp.models.episode import _safe_location

    assert _safe_location(EpisodeProject, loc) == expected


def test_a_position_that_cannot_be_resolved_masks_every_later_word():
    from podcast_mcp.models.episode import _safe_location

    class Leaf(BaseModel):
        word: str

    class Other(BaseModel):
        word: int

    class Holder(BaseModel):
        either: Leaf | Other
        anything: typing.Any = None

    assert _safe_location(Holder, ("either", "Leaf", "word")) == "either.*.*"
    assert _safe_location(Holder, ("anything", 2, "word")) == "anything.2.*"


def test_a_field_with_only_a_validation_alias_keeps_its_declared_name(minimal_project):
    # ``EpisodeProject.transcript_data`` is read from ``transcripts`` and has no ``alias``.
    data = json.loads(minimal_project.read_text())
    data["transcripts"] = {
        "per_track": [{"track_id": "t", "words": [{"text": {"v": 1}, "start": "x"}]}]
    }
    _write(minimal_project, data)
    with pytest.raises(ProjectUnreadableError) as caught:
        load_project(minimal_project)
    assert "unexpected contents at transcripts.per_track.0.words.0.text" in str(caught.value)


def test_a_dict_key_under_a_validation_alias_field_is_still_a_star(minimal_project):
    data = json.loads(minimal_project.read_text())
    data["transcripts"] = {"per_track": {MARK: 1}}
    _write(minimal_project, data)
    with pytest.raises(ProjectUnreadableError) as caught:
        load_project(minimal_project)
    assert MARK not in str(caught.value)
