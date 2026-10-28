"""A cached verdict equals a cold check for the inputs #2392 asked about.

Pause words (real gap): a pause reads the transcript with no source id. Contributor edits and
words in clip gaps (not real): the cache serves one edit at a time, and edges sit on clip ends.
The edit log (#2439): a pause check reads the pad records, hashed by ``_pad_records_seen`` with
the check's own sample validators; a sweep of record shapes pins the two read sets together.
"""

from __future__ import annotations

import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import cut_proof, verdict_cache
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

SR, DUR = 16_000, 120
PAUSE = (41.6, 41.79)


def _project(
    root: Path, *, sourced: bool, mutate: Callable[[EpisodeProject], None]
) -> EpisodeProject:
    audio = room(DUR)
    words = []
    for i, t in enumerate(np.arange(5.0, DUR - 5, 2.0)):
        t = round(float(t), 3)
        words.append(TranscriptWord(text=f"w{i}", start=t, end=round(t + 0.2, 3)))
        voice(audio, t, t + 0.2)
    path = root / "raw" / "host.wav"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setparams((1, 2, SR, 0, "NONE", "NONE"))
            handle.writeframes((audio * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("inputs", str(root))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=DUR, sample_rate=SR, channels=1),
        )
    ]
    sid = "s1" if sourced else None
    if sourced:
        project.sources = [SourceRecording(id="s1", path="raw/host.wav", duration_sec=DUR)]
    project.clips = [
        Clip(
            id="c0",
            track_id="host",
            source_id=sid,
            source_start=0,
            source_end=DUR,
            timeline_start=0,
        )
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    if sourced:
        project.transcripts.append(
            Transcript(track_id="host", source_id="s1", words=[w.model_copy() for w in words])
        )
    project.timeline.duration_sec = DUR
    project.edit_decisions = [
        EditDecision(
            id="e",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=PAUSE[0],
            end=PAUSE[1],
            reason="pause:0.19s",
            applied=False,
            boundary_mode="exact",
        )
    ]
    mutate(project)
    return project


def _outcome(project: EpisodeProject) -> Any:
    held: list = []
    applied = approve_edits(project, ["e"], defaults=load_defaults(), held_out=held, asked_out=[])
    clips = sorted(
        (c.timeline_start, c.source_start, c.source_end, c.fade_in_ms, c.fade_out_ms)
        for c in project.clips
    )
    return applied, [h.reason for h in held], clips


def _compare(tmp_path, monkeypatch, sourced, warm, change):
    hits: list[bool] = []
    lookup = verdict_cache.lookup

    def spy(key):
        found = lookup(key)
        hits.extend([True] if found else [])
        return found

    monkeypatch.setattr(verdict_cache, "lookup", spy)
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "0")
    cold_warm = _outcome(_project(tmp_path, sourced=sourced, mutate=warm))
    cold = _outcome(_project(tmp_path, sourced=sourced, mutate=change))
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    _outcome(_project(tmp_path, sourced=sourced, mutate=warm))
    _outcome(_project(tmp_path, sourced=sourced, mutate=warm))
    assert hits, "the unchanged project must hit the cache"
    cached = _outcome(_project(tmp_path, sourced=sourced, mutate=change))
    return cold_warm, cold, cached


def _no_source(p: EpisodeProject) -> Transcript:
    return next(t for t in p.transcripts if t.source_id is None)


def _drop_after(p: EpisodeProject) -> None:
    _no_source(p).words = [w for w in _no_source(p).words if w.start < PAUSE[1]]


def _drop_before(p: EpisodeProject) -> None:
    _no_source(p).words = [w for w in _no_source(p).words if w.start >= PAUSE[1]]


def _suppress_after(p: EpisodeProject) -> None:
    for w in _no_source(p).words:
        if w.start >= PAUSE[1]:
            w.suppressed = True


def _only_after(p: EpisodeProject) -> None:
    _no_source(p).words = [w for w in _no_source(p).words if w.start >= 90.0]


def _word_after(p: EpisodeProject) -> None:
    _no_source(p).words.append(TranscriptWord(text="zz", start=90.0, end=90.2))
    _no_source(p).words.sort(key=lambda w: w.start)


def _nothing(p: EpisodeProject) -> None:
    return None


@pytest.mark.parametrize(
    ("warm", "change"),
    [
        pytest.param(_nothing, _drop_after, id="drop_every_word_after"),
        pytest.param(_nothing, _drop_before, id="drop_every_word_before"),
        pytest.param(_nothing, _suppress_after, id="suppress_every_word_after"),
        pytest.param(_drop_after, _word_after, id="a_word_appears_on_an_empty_side"),
        pytest.param(_nothing, _only_after, id="every_word_near_gone"),
    ],
)
def test_a_cached_pause_verdict_equals_a_cold_check_when_the_no_source_transcript_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    warm: Callable[[EpisodeProject], None],
    change: Callable[[EpisodeProject], None],
) -> None:
    before, cold, cached = _compare(tmp_path, monkeypatch, True, warm, change)
    assert before != cold, "the change must move the cold verdict"
    assert cached == cold


def _far_word(p: EpisodeProject) -> None:
    for w in _no_source(p).words:
        if 101.0 <= w.start <= 101.01:
            w.text = "changed"
            w.suppressed = True


def test_a_pause_verdict_stays_cached_when_a_no_source_word_beyond_its_neighbours_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    keys: list[str | None] = []
    real = verdict_cache.verdict_key

    def spy(*args: Any, **kwargs: Any) -> str | None:
        keys.append(real(*args, **kwargs))
        return keys[-1]

    monkeypatch.setattr(verdict_cache, "verdict_key", spy)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    verdict_cache._STORE.clear()
    _outcome(_project(tmp_path, sourced=True, mutate=_nothing))
    _outcome(_project(tmp_path, sourced=True, mutate=_far_word))
    assert keys[0] is not None
    assert keys[0] == keys[1]


# A filler cut on a host track; ``gap`` removes source [40, 44) from the clips.
CUT = 38.3


def _filler_project(
    root: Path, *, gap: bool, mutate: Callable[[EpisodeProject], None]
) -> EpisodeProject:
    audio = room(DUR)
    words = []
    for i, t in enumerate(np.arange(5.0, DUR - 5, 0.9)):
        t = round(float(t), 3)
        if abs(t - CUT) < 0.5:
            t = CUT
        words.append(
            TranscriptWord(text="um" if t == CUT else f"w{i}", start=t, end=round(t + 0.35, 3))
        )
        voice(audio, t, t + 0.35)
    path = root / "raw" / "host.wav"
    if not path.exists():
        write_wav(path, audio)
    project = EpisodeProject.create("inputs", str(root))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=DUR, sample_rate=SR, channels=1),
        )
    ]
    if gap:  # a previous cut removed source [40, 44)
        project.clips = [
            Clip(
                id="c0",
                track_id="host",
                source_start=0,
                source_end=40,
                timeline_start=0,
                fade_out_ms=50,
            ),
            Clip(
                id="c1",
                track_id="host",
                source_start=44,
                source_end=DUR,
                timeline_start=40,
                fade_in_ms=50,
            ),
        ]
        project.timeline.duration_sec = DUR - 4
    else:
        project.clips = [
            Clip(id="c0", track_id="host", source_start=0, source_end=DUR, timeline_start=0)
        ]
        project.timeline.duration_sec = DUR
    project.transcripts = [Transcript(track_id="host", words=words)]
    project.edit_decisions = [
        EditDecision(
            id="e",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=CUT,
            end=round(CUT + 0.35, 3),
            reason="filler:um",
            applied=False,
            boundary_mode="vocal_transcript_guided",
        )
    ]
    mutate(project)
    return project


def _cmp(tmp_path, monkeypatch, make, warm, change):
    hits: list[bool] = []
    lookup = verdict_cache.lookup

    def spy(key):
        found = lookup(key)
        hits.extend([True] if found else [])
        return found

    monkeypatch.setattr(verdict_cache, "lookup", spy)
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "0")
    cold_warm = _outcome(make(tmp_path, warm))
    cold = _outcome(make(tmp_path, change))
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    _outcome(make(tmp_path, warm))
    _outcome(make(tmp_path, warm))
    assert hits
    return cold_warm, cold, _outcome(make(tmp_path, change))


def _mk(gap):
    return lambda root, mutate: _filler_project(root, gap=gap, mutate=mutate)


def _words(p):
    return p.transcripts[0].words


def test_a_contributor_edit_never_reaches_the_cut_check(tmp_path, monkeypatch):
    from podcast_mcp.edits import cut_safety

    seen = []
    orig = cut_safety._contributor_ends_in_valley

    def spy(project, ids, effect, cache):
        seen.append(set(ids))
        return orig(project, ids, effect, cache)

    monkeypatch.setattr(cut_safety, "_contributor_ends_in_valley", spy)

    def add(reason, end):
        def mutate(p):
            p.edit_decisions.append(
                EditDecision(
                    id="f",
                    track_id="host",
                    type=EditDecisionType.REMOVE,
                    start=CUT + 0.35,
                    end=end,
                    reason=reason,
                    applied=False,
                    boundary_mode="vocal_transcript_guided",
                )
            )

        return mutate

    _cw, cold, cached = _cmp(
        tmp_path,
        monkeypatch,
        _mk(False),
        add("filler:um", CUT + 0.5),
        add("filler:acoustic", CUT + 0.9),
    )
    assert seen
    assert cached == cold
    assert all(s == {"e"} for s in seen)


def _interior(fn):
    def mutate(p):
        fn(p.transcripts[0].words)

    return mutate


def _drop_interior(words):
    words[:] = [w for w in words if not (41.2 <= w.start < 42.9)]


def _suppress_interior(words):
    for w in words:
        if 41.2 <= w.start < 42.9:
            w.suppressed = True


def _ignore_interior(words):
    for w in words:
        if 41.2 <= w.start < 42.9:
            w.ignored = True


def _long_interior(words):
    words[:] = [w for w in words if not (41.2 <= w.start < 42.9)]
    words.append(TranscriptWord(text="long", start=41.3, end=42.7))
    words.sort(key=lambda w: w.start)


@pytest.mark.parametrize("cut", [36.0, 38.3, 39.2])
@pytest.mark.parametrize(
    "fn", [_drop_interior, _suppress_interior, _ignore_interior, _long_interior]
)
def test_a_cached_verdict_equals_a_cold_check_when_words_inside_a_clip_gap_change(
    tmp_path, monkeypatch, fn, cut
):
    import sys

    monkeypatch.setattr(sys.modules[__name__], "CUT", cut)
    _cw, cold, cached = _cmp(tmp_path, monkeypatch, _mk(True), lambda p: None, _interior(fn))
    assert cached == cold


def _early_clip(
    fade_out_ms: int = 0,
    *,
    thin: bool = False,
    moved_by: float = 0.0,
    reason: str | None = None,
) -> Callable[[EpisodeProject], None]:
    """Splits off a clip ending far before the cut, whose fade is the longest in the project.

    ``thin`` leaves one word 5.6 s before the pause (so its span is clamped there on the left)
    and one 0.1 s after it (so the right end of the span follows the fade). ``moved_by`` slides
    the early clip later on the timeline, in the hole left before the main clip, which moves the
    word it plays without touching any clip near the cut. ``reason`` replaces the edit's reason.
    """

    def mutate(p: EpisodeProject) -> None:
        head = p.clips[0]
        early = head.model_copy(
            update={
                "id": "c_early",
                "source_end": 10.0,
                "fade_out_ms": fade_out_ms,
                "timeline_start": moved_by,
            }
        )
        head.source_start = 10.0
        head.timeline_start = 10.0 + (2.0 if moved_by else 0.0)
        p.clips = [early, head]
        if thin:
            _no_source(p).words = [
                TranscriptWord(text="far", start=36.0, end=36.2),
                TranscriptWord(text="near", start=41.9, end=42.1),
            ]
        if reason is not None:
            p.edit_decisions[0].reason = reason

    return mutate


def _keys_and_spans(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    variants: list[Callable[[EpisodeProject], None]],
    *,
    clear: bool = True,
) -> tuple[list[str | None], list[tuple[float, float]]]:
    from podcast_mcp.edits import cut_safety

    keys: list[str | None] = []
    spans: list[tuple[float, float]] = []
    real_key, real_assess = verdict_cache.verdict_key, cut_safety.assess_held_pause

    def spy_key(*args: Any, **kwargs: Any) -> str | None:
        keys.append(real_key(*args, **kwargs))
        return keys[-1]

    def spy_assess(*args: Any, **kwargs: Any) -> Any:
        held = real_assess(*args, **kwargs)
        if not isinstance(held, cut_safety.CutRejected):
            spans.append(held.peer_observation_span)
        return held

    monkeypatch.setattr(verdict_cache, "verdict_key", spy_key)
    monkeypatch.setattr(cut_safety, "assess_held_pause", spy_assess)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    verdict_cache._STORE.clear()
    for mutate in variants:
        if clear:
            verdict_cache._STORE.clear()
        _outcome(_project(tmp_path, sourced=True, mutate=mutate))
    return keys, spans


def test_a_pause_key_moves_with_a_fade_before_the_window_that_widens_its_observation_span(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#2433: the span reads the longest fade in the project, even on a clip far before the cut."""
    keys, spans = _keys_and_spans(tmp_path, monkeypatch, [_early_clip(20), _early_clip(800)])
    assert len(spans) == 2
    assert spans[0] != spans[1], "the fade must move the cold observation span"
    assert keys[0] != keys[1]


def test_a_pause_key_moves_with_the_right_end_of_the_span_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    keys, spans = _keys_and_spans(
        tmp_path, monkeypatch, [_early_clip(130, thin=True), _early_clip(800, thin=True)]
    )
    assert spans[0][0] == spans[1][0], "the left end is clamped at the far word"
    assert spans[0][1] != spans[1][1]
    assert keys[0] != keys[1]


def test_a_pause_key_moves_when_a_clip_outside_the_window_moves_the_far_word(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The far word's place comes from a clip the window does not hold; the gap needs no entry."""
    keys, spans = _keys_and_spans(
        tmp_path, monkeypatch, [_early_clip(thin=True), _early_clip(thin=True, moved_by=1.0)]
    )
    assert spans[0] != spans[1]
    assert keys[0] != keys[1]


def test_a_pause_verdict_stays_cached_when_a_far_fade_changes_nothing_the_span_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """130 and 400 ms both pass the 120 ms floor and differ, yet the word gap bounds the span.

    The base-profile stamp is held fixed here: a fade on any clip changes the track's samples, so
    it changes the stamp by design (it is a digest of the track's inputs, not of what the span reads).
    """
    monkeypatch.setattr(cut_proof.BatchBase, "stamp", lambda self, *, defaults: "fixed")
    variants = [_early_clip(130), _early_clip(400)]
    keys, spans = _keys_and_spans(tmp_path, monkeypatch, variants)
    assert spans[0] == spans[1]
    assert keys[0] is not None
    assert keys[0] == keys[1]
    # And the entry the first approval stored is served to the second.
    verdict_cache._STORE.clear()
    keys, _ = _keys_and_spans(tmp_path, monkeypatch, variants, clear=False)
    assert verdict_cache.lookup(keys[1]) is not None
    hits: list[bool] = []
    real = verdict_cache.lookup

    def spy(key: str | None) -> Any:
        found = real(key)
        hits.extend([True] if found else [])
        return found

    monkeypatch.setattr(verdict_cache, "lookup", spy)
    _outcome(_project(tmp_path, sourced=True, mutate=variants[1]))
    assert hits


def test_only_a_pause_key_carries_an_observation_span(tmp_path: Path) -> None:
    """Any other edit hashes no span: a far fade would otherwise miss for nothing it reads."""
    parts = {}
    for reason in ("pause:0.19s", "noise"):
        project = _project(
            tmp_path, sourced=True, mutate=_early_clip(130, thin=True, reason=reason)
        )
        edit = project.edit_decisions[0]
        found = verdict_cache.key_parts(
            project,
            edit,
            defaults=load_defaults(),
            manual=False,
            batch=[],
            span=(PAUSE[0], PAUSE[1]),
            base_profile="test-base",
        )
        assert found is not None
        parts[reason] = found["pause_span"]
    assert parts["noise"] == verdict_cache._digest(None)
    assert parts["pause:0.19s"] != parts["noise"]


TILE = (40.9, 43.3)  # between the words either side of the pause, which sit at 41.0 and 43.0


# The edit log (#2439): a pause check reads its pad records.
def _legacy_pad_in_log(p: EpisodeProject) -> None:
    p.editorial.edit_log.append(
        AppliedEditRecord(id="far", applied_at="2026-01-01", operation="insert_room_tone_pad")
    )


def _pad(p: EpisodeProject, lo: float, hi: float, **extra: Any) -> None:
    sample = {"track_id": "host", "source_id": None, "source_start": lo, "source_end": hi}
    sample.update(extra)
    _pad_record(p, [sample])


def _pad_record(p: EpisodeProject, samples: Any) -> None:
    p.editorial.edit_log.append(
        AppliedEditRecord(
            id="pad",
            applied_at="2026-01-01",
            operation="insert_room_tone_pad",
            params={"pad_samples": samples},
        )
    )


def _tile_the_pause(p: EpisodeProject) -> None:
    """The pause is its own clip, so a pad whose samples span it makes it a copy."""
    lo, hi = TILE
    p.clips = [
        Clip(
            id="a", track_id="host", source_id=None, source_start=0, source_end=lo, timeline_start=0
        ),
        Clip(
            id="b",
            track_id="host",
            source_id=None,
            source_start=lo,
            source_end=hi,
            timeline_start=lo,
        ),
        Clip(
            id="c",
            track_id="host",
            source_id=None,
            source_start=hi,
            source_end=DUR,
            timeline_start=hi,
        ),
    ]


def _pad_over_pause(p: EpisodeProject) -> None:
    _tile_the_pause(p)
    _pad(p, *TILE)


def test_a_cached_pause_verdict_equals_a_cold_check_after_a_legacy_pad_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before, cold, cached = _compare(tmp_path, monkeypatch, True, _nothing, _legacy_pad_in_log)
    assert before != cold, "cold verdict must move"
    assert cached == cold


def test_a_cached_pause_verdict_equals_a_cold_check_after_a_pad_over_the_pause(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before, cold, cached = _compare(tmp_path, monkeypatch, False, _tile_the_pause, _pad_over_pause)
    assert before != cold, "cold verdict must move"
    assert cached == cold


def _key_of(tmp_path: Path, mutate: Callable[[EpisodeProject], None]) -> str | None:
    project = _project(tmp_path, sourced=True, mutate=mutate)
    edit = project.edit_decisions[0]
    return verdict_cache.verdict_key(
        project,
        edit,
        defaults=load_defaults(),
        manual=False,
        batch=[],
        span=(edit.start, edit.end),
        base_profile="test-base",
    )


def _ordinary_cut(p: EpisodeProject) -> None:
    p.editorial.edit_log.append(
        AppliedEditRecord(id="cut", applied_at="2026-01-02", operation="remove", params={"x": 1})
    )


def _far_pad(p: EpisodeProject) -> None:
    _pad(p, 1.0, 2.0)


def _far_pad_moved(p: EpisodeProject) -> None:
    _pad(p, 1.0, 3.0)


@pytest.mark.parametrize(
    "unrelated", [_ordinary_cut, _far_pad, _far_pad_moved], ids=["cut", "far_pad", "far_pad_moved"]
)
def test_unrelated_edit_log_records_leave_the_pause_key_alone(
    tmp_path: Path, unrelated: Callable[[EpisodeProject], None]
) -> None:
    assert _key_of(tmp_path, _nothing) is not None
    assert _key_of(tmp_path, _nothing) == _key_of(tmp_path, unrelated)


def _far_pad_unresolved(p: EpisodeProject) -> None:
    _pad(p, 1.0, 2.0, track_id="nobody")


def _pad_moved(p: EpisodeProject) -> None:
    _tile_the_pause(p)
    _pad(p, TILE[0], TILE[1] + 0.1)


def _pad_other_track(p: EpisodeProject) -> None:
    _tile_the_pause(p)
    _pad(p, *TILE, track_id="other")


def _pad_malformed(p: EpisodeProject) -> None:
    _tile_the_pause(p)
    _pad(p, *TILE, source_id=7)


def _pad_samples_not_a_list(p: EpisodeProject) -> None:
    _tile_the_pause(p)
    _pad_record(p, "oops")


def _pad_sample_not_a_dict(p: EpisodeProject) -> None:
    _tile_the_pause(p)
    _pad_record(p, ["oops"])


def _gap_pad_without_samples(p: EpisodeProject) -> None:
    p.editorial.edit_log.append(
        AppliedEditRecord(
            id="gap", applied_at="x", operation="remove", params={"replace_gap_sec": 0.5}
        )
    )


def _muted_gap_without_samples(p: EpisodeProject) -> None:
    p.editorial.edit_log.append(
        AppliedEditRecord(
            id="gap",
            applied_at="x",
            operation="remove",
            params={"replace_gap_sec": 0.5, "mute": True},
        )
    )


@pytest.mark.parametrize(
    ("base", "changed"),
    [
        pytest.param(_tile_the_pause, _pad_over_pause, id="pad_over_pause_added"),
        pytest.param(_pad_over_pause, _pad_moved, id="source_range"),
        pytest.param(_pad_over_pause, _pad_other_track, id="sample_track"),
        pytest.param(_pad_over_pause, _pad_malformed, id="sample_shape"),
        pytest.param(_tile_the_pause, _pad_samples_not_a_list, id="samples_not_a_list"),
        pytest.param(_tile_the_pause, _pad_sample_not_a_dict, id="sample_not_a_dict"),
        pytest.param(_far_pad, _far_pad_unresolved, id="far_pad_unresolved_recording"),
        pytest.param(_nothing, _legacy_pad_in_log, id="pad_without_samples"),
        pytest.param(_nothing, _gap_pad_without_samples, id="gap_purpose_without_samples"),
        pytest.param(_gap_pad_without_samples, _muted_gap_without_samples, id="mute_flag"),
    ],
)
def test_each_pad_field_the_pause_check_reads_moves_the_key(
    tmp_path: Path,
    base: Callable[[EpisodeProject], None],
    changed: Callable[[EpisodeProject], None],
) -> None:
    assert _key_of(tmp_path, base) != _key_of(tmp_path, changed)


def test_a_pause_verdict_is_reused_after_an_unrelated_log_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    verdict_cache._STORE.clear()
    hits: list[bool] = []
    lookup = verdict_cache.lookup

    def spy(key: str | None) -> Any:
        found = lookup(key)
        hits.append(found is not None)
        return found

    monkeypatch.setattr(verdict_cache, "lookup", spy)
    _outcome(_project(tmp_path, sourced=True, mutate=_nothing))
    assert hits == [False]
    _outcome(_project(tmp_path, sourced=True, mutate=_far_pad))
    assert hits == [False, True]


# Far samples the check rejects: invalid ranges on the pause's own recording, and recordings it
# cannot resolve. Nothing about them is near the pause, so only the validity test puts them in the key.
def _far_inverted(p: EpisodeProject) -> None:
    _pad(p, 500.0, 400.0)


def _far_negative(p: EpisodeProject) -> None:
    _pad(p, -50.0, -10.0)


def _far_zero_length(p: EpisodeProject) -> None:
    _pad(p, 2.0, 2.0)


def _far_bool_start(p: EpisodeProject) -> None:
    _pad(p, True, 2.0)


def _far_non_finite(p: EpisodeProject) -> None:
    _pad(p, 500.0, float("inf"))


def _far_missing_file(p: EpisodeProject) -> None:
    p.sources.append(SourceRecording(id="gone", path="raw/gone.wav", duration_sec=DUR))
    _pad(p, 1.0, 2.0, source_id="gone")


def test_a_far_pad_sample_on_a_recording_that_vanishes_from_disk_moves_the_key(
    tmp_path: Path,
) -> None:
    gone = tmp_path / "raw" / "gone.wav"
    gone.parent.mkdir(parents=True, exist_ok=True)
    gone.write_bytes(b"x")
    present = _key_of(tmp_path, _far_missing_file)
    gone.unlink()
    assert present != _key_of(tmp_path, _far_missing_file)


def _far_tuple_samples(p: EpisodeProject) -> None:
    _pad_record(
        p, ({"track_id": "host", "source_id": None, "source_start": 1.0, "source_end": 2.0},)
    )


def _not_a_pause(p: EpisodeProject) -> None:
    p.edit_decisions[0].reason = "silence"


def _reach_of(tmp_path: Path) -> float:
    project = _project(tmp_path, sourced=True, mutate=_nothing)
    edit = project.edit_decisions[0]
    return verdict_cache.check_reach_sec(project, edit, (edit.start, edit.end), load_defaults())


@pytest.mark.parametrize(
    "invalid",
    [_far_inverted, _far_negative, _far_zero_length],
    ids=["inverted", "negative", "zero_length"],
)
def test_a_cached_pause_verdict_equals_a_cold_check_after_a_far_invalid_pad_range(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, invalid: Callable[[EpisodeProject], None]
) -> None:
    before, cold, cached = _compare(tmp_path, monkeypatch, True, _nothing, invalid)
    assert before != cold, "cold verdict must move"
    assert cached == cold


@pytest.mark.parametrize(
    "invalid",
    [
        _far_inverted,
        _far_negative,
        _far_zero_length,
        _far_bool_start,
        _far_non_finite,
        _far_missing_file,
    ],
    ids=["inverted", "negative", "zero_length", "bool", "non_finite", "missing_file"],
)
def test_a_far_pad_sample_the_check_rejects_moves_the_key(
    tmp_path: Path, invalid: Callable[[EpisodeProject], None]
) -> None:
    assert _key_of(tmp_path, _far_pad) != _key_of(tmp_path, invalid)


def test_a_far_valid_pad_sample_in_a_tuple_leaves_the_key_alone(tmp_path: Path) -> None:
    assert _key_of(tmp_path, _nothing) == _key_of(tmp_path, _far_tuple_samples)


def _near_pad(p: EpisodeProject) -> None:
    _pad(p, *TILE)


@pytest.mark.parametrize("pad", [_legacy_pad_in_log, _near_pad, _far_inverted])
def test_an_edit_that_is_not_a_pause_ignores_the_pad_records(
    tmp_path: Path, pad: Callable[[EpisodeProject], None]
) -> None:
    def alone(p: EpisodeProject) -> None:
        _not_a_pause(p)

    def with_pad(p: EpisodeProject) -> None:
        _not_a_pause(p)
        pad(p)

    assert _key_of(tmp_path, alone) == _key_of(tmp_path, with_pad)


def test_a_pad_sample_moves_the_key_only_within_the_check_reach_of_the_pause(
    tmp_path: Path,
) -> None:
    reach = _reach_of(tmp_path)
    lo, hi = PAUSE[0] - reach, PAUSE[1] + reach
    base = _key_of(tmp_path, _nothing)

    def key(a: float, b: float) -> str | None:
        return _key_of(tmp_path, lambda p: _pad(p, a, b))

    assert key(lo - 5.0, lo) != base, "a range ending on the near edge is in reach"
    assert key(hi, hi + 5.0) != base, "a range starting on the far edge is in reach"
    assert key(lo - 5.0, lo - 1e-6) == base
    assert key(hi + 1e-6, hi + 5.0) == base
    assert key(lo - 5.0, lo + 1e-6) != base
    assert key(hi - 1e-6, hi + 5.0) != base


def _record_shapes() -> dict[str, Callable[[EpisodeProject], None]]:
    def one(**sample: Any) -> Callable[[EpisodeProject], None]:
        def build(p: EpisodeProject) -> None:
            extra = {k: v for k, v in sample.items() if k not in ("lo", "hi")}
            _pad(p, sample.get("lo", 1.0), sample.get("hi", 2.0), **extra)

        return build

    def whole(samples: Any) -> Callable[[EpisodeProject], None]:
        return lambda p: _pad_record(p, samples)

    return {
        "no_samples": _legacy_pad_in_log,
        "not_a_list": whole("oops"),
        "empty_list": whole([]),
        "sample_not_a_dict": whole(["oops"]),
        "far_valid": one(),
        "near_valid_over_pause": _pad_over_pause,
        "far_inverted": _far_inverted,
        "far_negative": _far_negative,
        "far_zero_length": _far_zero_length,
        "far_bool": _far_bool_start,
        "far_non_finite": _far_non_finite,
        "far_missing_file": _far_missing_file,
        "far_unknown_track": one(track_id="nobody"),
        "far_empty_track_id": one(track_id=""),
        "far_int_source_id": one(source_id=7),
        "far_empty_source_id": one(source_id=""),
        "far_no_source_key": whole([{"track_id": "host", "source_start": 1.0, "source_end": 2.0}]),
        "far_string_range": one(lo="1", hi="2"),
        "far_tuple": _far_tuple_samples,
        "gap_without_samples": _gap_pad_without_samples,
        "muted_gap_without_samples": _muted_gap_without_samples,
        "ordinary_cut": _ordinary_cut,
    }


@pytest.mark.parametrize("shape", list(_record_shapes()))
def test_a_cached_pause_verdict_equals_a_cold_check_for_every_pad_record_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shape: str
) -> None:
    """The check's read set and ``_pad_records_seen`` must not drift apart."""
    _, cold, cached = _compare(tmp_path, monkeypatch, True, _nothing, _record_shapes()[shape])
    assert cached == cold


def test_a_pad_record_key_hashes_every_sample_not_only_the_first(tmp_path: Path) -> None:
    near = [
        {"track_id": "host", "source_id": None, "source_start": a, "source_end": b}
        for a, b in (TILE, (TILE[0] + 0.1, TILE[1]))
    ]
    moved = [near[0], {**near[1], "source_end": TILE[1] - 0.05}]
    base = _key_of(tmp_path, lambda p: _pad_record(p, near))
    assert base != _key_of(tmp_path, _nothing)
    assert base == _key_of(tmp_path, lambda p: _pad_record(p, [dict(s) for s in near]))
    assert base != _key_of(tmp_path, lambda p: _pad_record(p, moved))


def _far_outside_workspace(p: EpisodeProject) -> None:
    p.sources.append(SourceRecording(id="out", path="../outside.wav", duration_sec=DUR))
    _pad(p, 1.0, 2.0, source_id="out")


def test_a_far_pad_sample_on_a_recording_outside_the_workspace_moves_the_key(
    tmp_path: Path,
) -> None:
    key = _key_of(tmp_path, _far_outside_workspace)
    assert key is not None
    assert key != _key_of(tmp_path, _far_pad)
    assert key != _key_of(tmp_path, _nothing)


@pytest.mark.parametrize("start", [float("nan"), float("-inf")], ids=["nan", "negative_infinity"])
def test_a_far_pad_sample_with_a_non_finite_start_moves_the_key(
    tmp_path: Path, start: float
) -> None:
    assert _key_of(tmp_path, lambda p: _pad(p, start, 2.0)) != _key_of(tmp_path, _far_pad)


def test_a_far_pad_sample_starting_at_zero_is_valid_and_leaves_the_key_alone(
    tmp_path: Path,
) -> None:
    assert _key_of(tmp_path, lambda p: _pad(p, 0.0, 2.0)) == _key_of(tmp_path, _nothing)


@pytest.mark.parametrize(
    "other", [{"track_id": "other"}, {"source_id": "alt"}], ids=["track_id", "source_id"]
)
def test_an_invalid_range_pad_sample_is_hashed_with_the_recording_it_names(
    tmp_path: Path, other: dict[str, str]
) -> None:
    base = _key_of(tmp_path, _far_inverted)
    assert base != _key_of(tmp_path, lambda p: _pad(p, 500.0, 400.0, **other))


def test_an_unexpected_error_resolving_a_far_pad_sample_propagates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, sourced=True, mutate=_far_pad)
    edit = project.edit_decisions[0]

    def broken(*_: Any) -> None:
        raise RuntimeError("bug")

    monkeypatch.setattr(verdict_cache, "pad_sample_recording", broken)
    with pytest.raises(RuntimeError, match="bug"):
        verdict_cache._pad_records_seen(project, edit, edit.start - 1.0, edit.end + 1.0)
