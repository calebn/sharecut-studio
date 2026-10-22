"""The audio a track is heard as, evaluated from its tree and shared across a batch (#1958)."""

from __future__ import annotations

import copy
import dataclasses
import inspect
import logging
import os
import typing
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import audio, audio_audit, audio_eval, timeline_render, track_evidence
from podcast_mcp.engines.audio import (
    At,
    CrossfadeAudio,
    MaskAudio,
    MixAudio,
    SequenceAudio,
    SourceAudio,
)
from podcast_mcp.engines.track_evidence import Declined
from podcast_mcp.engines.ungated_audio import load_mono_full, resample_stream, resample_streams
from podcast_mcp.models import (
    ClipBleedRestore,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    EpisodeProject,
)
from podcast_mcp.models.episode import SourceSpan
from podcast_mcp.util import batch_scope as scope_module
from podcast_mcp.util.batch_scope import batch_scope
from test_audio_eval import (
    CLIP_LAYOUTS,
    FRAME_DB_TOLERANCE,
    LIVE_FLOOR_DB,
    SAMPLE_TOLERANCE,
    _chained,
    _ffmpeg_or_skip,
    _project,
    _with_envelope,
    _with_gate_fill,
    _with_second_source,
)

JUMP, WAVEFORM = 8000, 16000


def _render_reference(project: EpisodeProject, tmp_path: Path) -> dict[int, np.ndarray]:
    """What the render of the track, gate off and chain left out, decodes to at each rate."""
    snapshot = project.model_copy(deep=True)
    track = snapshot.track_by_id("caleb")
    track.transcript_gate = False
    snapshot.processing_chains = []
    path = tmp_path / "reference.wav"
    timeline_render.render_track_from_timeline(snapshot, track, path, load_defaults())
    return {rate: load_mono_full(path, sample_rate=rate) for rate in (JUMP, WAVEFORM)}


def _frame_db(samples: np.ndarray, rate: int) -> np.ndarray:
    frame = rate // 10
    frames = samples[: samples.size // frame * frame].reshape(-1, frame)
    return 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)


def _assert_equals_render(
    evidence: dict[int, np.ndarray], reference: dict[int, np.ndarray], *, exact_length: bool
) -> None:
    for rate, rendered in reference.items():
        evaluated = evidence[rate]
        assert abs(evaluated.size - rendered.size) <= (0 if exact_length else 3 * rate // JUMP)
        common = min(evaluated.size, rendered.size)
        assert np.abs(evaluated[:common] - rendered[:common]).max() < SAMPLE_TOLERANCE
        expected, actual = _frame_db(rendered[:common], rate), _frame_db(evaluated[:common], rate)
        live = expected > LIVE_FLOOR_DB
        assert live.sum() > 10
        assert np.abs(expected - actual)[live].max() < FRAME_DB_TOLERANCE


def _heard_arrays(project: EpisodeProject) -> dict[int, np.ndarray]:
    heard = track_evidence.heard(project, "caleb", load_defaults())
    return {JUMP: heard.jump.samples, WAVEFORM: heard.waveform.samples}


@pytest.mark.parametrize("layout", CLIP_LAYOUTS)
def test_heard_evidence_equals_the_render_at_both_rates(layout: str, tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, layout)

    _assert_equals_render(
        _heard_arrays(project),
        _render_reference(project, tmp_path),
        exact_length="8 kHz" in layout,
    )


def _with_mutes(project: EpisodeProject, workspace: Path) -> None:
    clips = [c for c in project.clips if c.track_id == "caleb"]
    clips[0].mute_regions = [
        ClipMuteRegion(start_s=clips[0].source_start + 0.5, end_s=clips[0].source_start + 0.9),
        ClipMuteRegion(
            start_s=clips[0].source_start + 1.5,
            end_s=clips[0].source_start + 1.51,
            fade_out_ms=40,
            fade_in_ms=40,
        ),
    ]
    clips[2].mute_regions = [
        ClipMuteRegion(
            start_s=clips[2].source_start + 0.2,
            end_s=clips[2].source_start + 1.0,
            fade_out_ms=30,
            fade_in_ms=60,
            gain_db=-12.0,
        )
    ]


def _with_off_speaker(project: EpisodeProject, workspace: Path) -> None:
    for clip in [c for c in project.clips if c.track_id == "caleb"][:3]:
        clip.off_speaker_mute_regions = [
            ClipOffSpeakerMuteRegion(
                start_s=clip.source_start + 0.4, end_s=clip.source_start + 1.1, fade_out_ms=30
            ),
            ClipOffSpeakerMuteRegion(
                start_s=clip.source_start + 1.6, end_s=clip.source_start + 1.65
            ),
        ]


def _with_gate_on(project: EpisodeProject, workspace: Path) -> None:
    project.track_by_id("caleb").transcript_gate = True


SETUPS = {
    "mutes": _with_mutes,
    "off-speaker": _with_off_speaker,
    "gate fill": _with_gate_fill,
    "second source": lambda project, workspace: _with_second_source(project, workspace),
    "chain kept in the project": lambda project, workspace: _chained(project),
    "gate on in the project": _with_gate_on,
}


@pytest.mark.parametrize("setup", SETUPS)
def test_heard_evidence_equals_the_render_with(setup: str, tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    SETUPS[setup](project, tmp_path / "project")

    _assert_equals_render(
        _heard_arrays(project), _render_reference(project, tmp_path), exact_length=False
    )


@pytest.mark.parametrize("rate", [44100, 48000, 16000])
def test_heard_evidence_equals_the_render_of_a_mono_track_at(rate: int, tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads", mono_rate=rate)

    _assert_equals_render(
        _heard_arrays(project), _render_reference(project, tmp_path), exact_length=False
    )


def test_rms_evidence_is_the_heard_8khz_array(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "crossfade joins")
    defaults = load_defaults()

    heard = track_evidence.heard(project, "caleb", defaults)
    rms = track_evidence.rms(project, "caleb", defaults)

    np.testing.assert_array_equal(rms.samples, heard.jump.samples)
    assert rms.sample_rate == JUMP
    assert rms.recording_profile is not None


def test_rms_evidence_equals_the_render(tmp_path: Path, render_calls: list[str]) -> None:
    _ffmpeg_or_skip()
    project = _chained(_project(tmp_path, "mixed joins and pads"))
    reference = _render_reference(project, tmp_path)
    render_calls.clear()

    rms = track_evidence.rms(project, "caleb", load_defaults())

    assert render_calls == []
    _assert_equals_render({JUMP: rms.samples}, {JUMP: reference[JUMP]}, exact_length=False)


def test_one_chunk_stream_feeds_every_rate_as_a_resample_of_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ffmpeg_or_skip()
    rng = np.random.default_rng(7)
    source = (rng.standard_normal(44100 * 3) * 0.1).astype(np.float32)
    pieces = [source[i : i + 30011] for i in range(0, source.size, 30011)]

    together = resample_streams(iter(pieces), 44100, (JUMP, WAVEFORM, 44100))

    np.testing.assert_array_equal(together[JUMP], resample_stream(iter(pieces), 44100, JUMP))
    np.testing.assert_array_equal(
        together[WAVEFORM], resample_stream(iter(pieces), 44100, WAVEFORM)
    )
    np.testing.assert_array_equal(together[44100], source)


def test_no_render_runs_when_an_effect_overlaps_an_accepted_mute(
    tmp_path: Path, render_calls: list[str]
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    _with_mutes(project, tmp_path / "project")

    track_evidence.heard(project, "caleb", load_defaults())

    assert render_calls == []


def _declines(project: EpisodeProject) -> Declined | tuple:
    return track_evidence._plan(project, "caleb", load_defaults(), (JUMP,))


def _with_bleed_restore(project: EpisodeProject, workspace: Path) -> None:
    _with_off_speaker(project, workspace)
    for clip in [c for c in project.clips if c.track_id == "caleb"]:
        clip.bleed_restore = ClipBleedRestore(
            source_sha256="0" * 64,
            regions=[SourceSpan(start_s=clip.source_start + 0.2, end_s=clip.source_start + 0.3)],
        )


def test_bleed_restore_declines_to_the_render(tmp_path: Path) -> None:
    project = _project(tmp_path, "mixed joins and pads")
    _with_bleed_restore(project, tmp_path / "project")

    assert _declines(project) is Declined.BLEED_RESTORE
    # With the gate off and no off-speaker region the render adds no restore step.
    plain = _project(tmp_path / "plain", "mixed joins and pads")
    for clip in [c for c in plain.clips if c.track_id == "caleb"]:
        clip.bleed_restore = ClipBleedRestore(
            source_sha256="0" * 64, regions=[SourceSpan(start_s=0.2, end_s=0.3)]
        )
    assert not isinstance(_declines(plain), Declined)
    # The render's own test for the step agrees with the planner's.
    track = project.track_by_id("caleb")
    assert timeline_render.restore_applies(project, track, gated=False)
    assert (
        timeline_render.unfiltered_track_audio(project, track, load_defaults(), bare=True) is None
    )


def test_a_volume_envelope_declines_to_the_render(tmp_path: Path) -> None:
    project = _project(tmp_path, "fade joins")
    _with_envelope(project)

    assert _declines(project) is Declined.ENVELOPE


def test_a_non_triangular_curve_declines_to_the_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "crossfade joins")
    defaults = copy.deepcopy(load_defaults())
    defaults["render"]["crossfade_curve"] = "qsin"
    planned = track_evidence._plan(project, "caleb", defaults, (JUMP,))
    assert not isinstance(planned, Declined)

    assert track_evidence._evaluate(planned[1], "qsin", (JUMP,)) is Declined.EVALUATOR


def test_masks_and_mixed_rates_decline_to_the_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    leaf = SourceAudio(Path("a"), 0.0, 0.5)
    assert track_evidence._evaluate(MaskAudio(leaf, 0.0, ((0.1, 0.2),)), "tri", (JUMP,)) is (
        Declined.MASK
    )
    project = _project(tmp_path, "mixed joins and pads")
    _with_second_source(project, tmp_path / "project", rate=44100)
    planned = track_evidence._plan(project, "caleb", load_defaults(), (JUMP,))
    assert not isinstance(planned, Declined)

    assert track_evidence._evaluate(planned[1], "tri", (JUMP,)) is Declined.MIXED_RATE


@pytest.mark.parametrize("which", ["heard", "rms"])
def test_a_decline_renders_and_logs_why(
    which: str,
    tmp_path: Path,
    render_calls: list[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    _with_envelope(project)
    caplog.set_level(logging.INFO, logger=track_evidence.__name__)

    result = getattr(track_evidence, which)(project, "caleb", load_defaults())

    assert render_calls == ["caleb"]
    assert Declined.ENVELOPE.value in caplog.text
    assert (result.jump if which == "heard" else result).samples.size > 0


def test_a_render_fallback_leaves_no_entry_under_its_temp_path(
    tmp_path: Path, render_calls: list[str]
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    _with_envelope(project)

    with batch_scope():
        track_evidence.heard(project, "caleb", load_defaults())
        track_evidence.rms(project, "caleb", load_defaults())
        keys = [repr(key) for key in scope_module._scope.get()]

    assert render_calls == ["caleb", "caleb"]
    assert not [key for key in keys if track_evidence.RENDER_PREFIX in key]


def _count_evaluations(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, ...]]:
    calls: list[tuple[int, ...]] = []
    real = track_evidence._evaluate

    def counting(tree, curve, rates):  # type: ignore[no-untyped-def]
        calls.append(tuple(rates))
        return real(tree, curve, rates)

    monkeypatch.setattr(track_evidence, "_evaluate", counting)
    return calls


def test_a_held_cut_builds_its_evidence_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    defaults = load_defaults()
    calls = _count_evaluations(monkeypatch)

    with batch_scope():
        first = track_evidence.heard(project, "caleb", defaults)
        again = track_evidence.heard(project, "caleb", defaults)
        # A held cut leaves the project's content as it was, in a copy of its own.
        copied = track_evidence.heard(project.model_copy(deep=True), "caleb", defaults)
        track_evidence.rms(project, "caleb", defaults)

    assert calls == [(JUMP, WAVEFORM)]
    np.testing.assert_array_equal(first.jump.samples, again.jump.samples)
    np.testing.assert_array_equal(first.waveform.samples, copied.waveform.samples)


def test_evidence_is_built_afresh_outside_a_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    calls = _count_evaluations(monkeypatch)

    track_evidence.rms(project, "caleb", load_defaults())
    track_evidence.rms(project, "caleb", load_defaults())

    assert calls == [(JUMP,), (JUMP,)]


def test_a_changed_track_misses(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    defaults = load_defaults()
    calls = _count_evaluations(monkeypatch)

    with batch_scope():
        track_evidence.rms(project, "caleb", defaults)
        _with_mutes(project, tmp_path / "project")
        track_evidence.rms(project, "caleb", defaults)
        os.utime(tmp_path / "project" / "raw" / "caleb.flac", ns=(1, 1))
        track_evidence.rms(project, "caleb", defaults)

    assert len(calls) == 3


def test_stored_arrays_cannot_be_written(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    defaults = load_defaults()

    with batch_scope():
        heard = track_evidence.heard(project, "caleb", defaults)
        rms = track_evidence.rms(project, "caleb", defaults)

    for samples in (heard.jump.samples, heard.waveform.samples, rms.samples):
        assert not samples.flags.writeable
        with pytest.raises(ValueError):
            samples[0] = 1.0


def test_the_store_holds_to_its_byte_cap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    defaults = load_defaults()
    one = _project(tmp_path / "one", "fade joins")
    two = _project(tmp_path / "two", "crossfade joins")
    size = track_evidence.rms(one, "caleb", defaults).samples.nbytes
    calls = _count_evaluations(monkeypatch)

    monkeypatch.setattr(track_evidence, "EVIDENCE_CACHE_BYTES", int(size * 1.5))
    with batch_scope():
        track_evidence.rms(one, "caleb", defaults)
        track_evidence.rms(two, "caleb", defaults)  # evicts the first
        track_evidence.rms(two, "caleb", defaults)
        track_evidence.rms(one, "caleb", defaults)
    assert len(calls) == 3

    calls.clear()
    monkeypatch.setattr(track_evidence, "EVIDENCE_CACHE_BYTES", size // 2)
    with batch_scope():
        track_evidence.rms(one, "caleb", defaults)
        track_evidence.rms(one, "caleb", defaults)  # larger than the cap: never stored
    assert len(calls) == 2


def _audio_node_types() -> list[type]:
    return [
        *typing.get_args(audio.Audio),
        At,
        audio.MuteEnvelope,
        audio.SourceMuteEnvelope,
    ]


# The evaluator never reads these: they name the clip and recording a leaf came from.
UNREAD_FIELDS = {("SourceAudio", "clip_id"), ("SourceAudio", "source_id")}


def test_the_key_covers_every_field_the_evaluator_reads() -> None:
    evaluator = inspect.getsource(audio_eval)
    for node_type in _audio_node_types():
        for field in dataclasses.fields(node_type):
            if (node_type.__name__, field.name) in UNREAD_FIELDS:
                assert not field.compare
                assert f".{field.name}" not in evaluator, (node_type.__name__, field.name)
            else:
                # A field outside equality would leave the key blind to it.
                assert field.compare, (node_type.__name__, field.name)
                assert field.hash is not False, (node_type.__name__, field.name)
    assert dataclasses.is_dataclass(track_evidence.EvidenceKey)
    assert {f.name for f in dataclasses.fields(track_evidence.EvidenceKey)} == {
        "tree",
        "curve",
        "rates",
        "revisions",
    }


def _key(project: EpisodeProject, defaults=None, rates=(JUMP,)):  # type: ignore[no-untyped-def]
    planned = track_evidence._plan(project, "caleb", defaults or load_defaults(), rates)
    assert not isinstance(planned, Declined), planned
    return planned[0]


def test_the_key_moves_with_every_input_of_the_tree(tmp_path: Path) -> None:
    project = _project(tmp_path, "mixed joins and pads")
    workspace = tmp_path / "project"
    base = _key(project)
    assert _key(project.model_copy(deep=True)) == base
    assert hash(_key(project.model_copy(deep=True))) == hash(base)
    clips = [c for c in project.clips if c.track_id == "caleb"]

    moved: dict[str, object] = {}
    moved["rates"] = _key(project, rates=(JUMP, WAVEFORM))
    curved = copy.deepcopy(load_defaults())
    curved["render"]["crossfade_curve"] = "qsin"
    moved["curve"] = _key(project, curved)
    for name, change in {
        "fade": lambda: setattr(clips[0], "fade_out_ms", clips[0].fade_out_ms + 5),
        "offset": lambda: setattr(clips[1], "timeline_start", clips[1].timeline_start + 0.5),
        "source range": lambda: setattr(clips[2], "source_end", clips[2].source_end - 0.25),
        "mute": lambda: _with_mutes(project, workspace),
        "off-speaker": lambda: _with_off_speaker(project, workspace),
        "fill": lambda: _with_gate_fill(project, workspace),
    }.items():
        change()
        moved[name] = _key(project)
    stat = (workspace / "raw" / "caleb.flac").stat()
    os.utime(workspace / "raw" / "caleb.flac", ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
    moved["file revision"] = _key(project)

    keys = [base, *moved.values()]
    assert len(set(keys)) == len(keys), [n for n, k in moved.items() if keys.count(k) > 1]


def test_no_defaults_value_but_the_crossfade_curve_reaches_the_key(tmp_path: Path) -> None:
    project = _project(tmp_path, "crossfade joins")
    defaults = load_defaults()
    base = _key(project, defaults)

    def leaves(node: dict, prefix: tuple[str, ...] = ()):  # type: ignore[type-arg]
        for name, value in node.items():
            if isinstance(value, dict):
                yield from leaves(value, (*prefix, name))
            else:
                yield (*prefix, name)

    checked = 0
    for path in leaves(defaults):
        changed = copy.deepcopy(defaults)
        parent = changed
        for name in path[:-1]:
            parent = parent[name]
        parent[path[-1]] = ["tripwire", parent[path[-1]]]
        if path == ("render", "crossfade_curve"):
            assert _key(project, changed) != base
        else:
            assert _key(project, changed) == base, path
        checked += 1
    assert checked > 50


def test_verify_mode_recomputes_every_hit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    defaults = load_defaults()
    monkeypatch.setenv("SHARECUT_EVIDENCE_VERIFY", "1")
    calls = _count_evaluations(monkeypatch)

    with batch_scope():
        track_evidence.rms(project, "caleb", defaults)
        track_evidence.rms(project, "caleb", defaults)
        assert len(calls) == 2

        store = next(v for v in scope_module._scope.get().values() if hasattr(v, "get_or_build"))
        entry = next(iter(store._entries.values()))
        poisoned = entry.samples[JUMP].copy()
        poisoned[100] += 0.5
        poisoned.flags.writeable = False
        entry.samples[JUMP] = poisoned
        with pytest.raises(AssertionError, match="evidence"):
            track_evidence.rms(project, "caleb", defaults)


def test_a_lazy_set_builds_a_track_when_it_is_first_read() -> None:
    built: list[str] = []
    sentinel = {"host": object(), "guest": object()}

    def build(track_id: str):  # type: ignore[no-untyped-def]
        built.append(track_id)
        return None if track_id == "gone" else sentinel[track_id]

    lazy = track_evidence.LazyRmsSet(build, ("host", "guest", "gone"))

    assert built == []
    assert lazy.get("host") is sentinel["host"]
    assert lazy.get("host") is sentinel["host"]
    assert built == ["host"]
    assert lazy.get("gone") is None
    assert lazy.get("absent") is None
    assert sorted(lazy.caches) == ["guest", "host"]
    assert built == ["host", "gone", "guest"]
    assert lazy.caches["guest"] is sentinel["guest"]


def test_the_tree_is_hashable_for_every_plain_shape(tmp_path: Path) -> None:
    leaf = SourceAudio(Path("a"), 0.0, 1.0)
    tree = MixAudio(At(0.0, SequenceAudio(leaf, (CrossfadeAudio(leaf, leaf, 0.1),))), ())
    assert hash(tree) == hash(copy.deepcopy(tree))


def test_from_samples_measures_no_profile_until_it_is_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    measured: list[int] = []
    real = audio_audit.track_profile

    def counting(samples, rate):  # type: ignore[no-untyped-def]
        measured.append(rate)
        return real(samples, rate)

    monkeypatch.setattr(audio_audit, "track_profile", counting)
    cache = audio_audit.TrackRmsCache.from_samples(np.zeros(JUMP, dtype=np.float32))

    assert measured == []
    cache.profile  # noqa: B018
    cache.profile  # noqa: B018
    assert measured == [JUMP]


def test_an_entry_keeps_the_tree_it_was_built_from(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    key = _key(project)

    with batch_scope():
        track_evidence.rms(project, "caleb", load_defaults())
        store = next(v for v in scope_module._scope.get().values() if hasattr(v, "get_or_build"))
        entry = store._entries[key]

    assert entry.tree == key.tree


@pytest.mark.skip(reason="PR-B")
def test_a_resampler_restarted_mid_stream_matches_a_continuous_run() -> None:
    _ffmpeg_or_skip()
    rng = np.random.default_rng(11)
    source = (rng.standard_normal(48000 * 6) * 0.1).astype(np.float32)
    middle = 48000 * 3 + 17
    continuous = resample_streams(iter([source]), 48000, (JUMP, WAVEFORM))

    first = resample_streams(iter([source[:middle]]), 48000, (JUMP, WAVEFORM))
    rest = resample_streams(iter([source[middle:]]), 48000, (JUMP, WAVEFORM))

    for rate in (JUMP, WAVEFORM):
        np.testing.assert_array_equal(np.concatenate([first[rate], rest[rate]]), continuous[rate])
