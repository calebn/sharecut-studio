"""Whole-track evidence is built at the 16 kHz waveform rate only for a tree that carries mute spans (#2359)."""

from __future__ import annotations

import dataclasses
import logging
import os
import threading
import time
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import track_evidence
from podcast_mcp.engines.audio import At, Audio, MixAudio, MuteEnvelope, SequenceAudio, SourceAudio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.track_evidence import Declined, EvidenceKey, _Entry, _Store
from podcast_mcp.util.batch_scope import batch_scope
from test_audio_eval import _ffmpeg_or_skip, _project
from test_retained_evidence import _bits, _tone, _tree
from test_track_evidence import _with_mutes, _with_off_speaker

JUMP, WAVEFORM = 8000, 16000
BOTH = (JUMP, WAVEFORM)
real_evaluate = track_evidence._evaluate


@pytest.fixture(autouse=True)
def _ffmpeg() -> None:
    _ffmpeg_or_skip()


@pytest.fixture(autouse=True)
def _aged_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(track_evidence, "_now_ns", lambda: time.time_ns() + 3600 * 10**9)
    track_evidence._RETAINED.clear()


def _muted(tree: Audio) -> Audio:
    """``tree`` with a mute span on its first leaf."""
    assert isinstance(tree, MixAudio) and isinstance(tree.head, At)
    sequence = tree.head.audio
    assert isinstance(sequence, SequenceAudio) and isinstance(sequence.head, SourceAudio)
    head = dataclasses.replace(sequence.head, mute_spans=(MuteEnvelope(0.5, 0.9, 0.01, 0.01),))
    return MixAudio(At(0.0, SequenceAudio(head, sequence.tail)), tree.tail)


def _resample_rates(monkeypatch: pytest.MonkeyPatch) -> list[list[int]]:
    calls: list[list[int]] = []
    real = FFmpegEngine.resample_streams

    def spy(chunks, source_rate, rates, *args, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(sorted(rates))
        return real(chunks, source_rate, rates, *args, **kwargs)

    monkeypatch.setattr(FFmpegEngine, "resample_streams", staticmethod(spy))
    return calls


def test_the_rate_set_is_both_only_for_a_tree_with_a_mute_span(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    assert track_evidence._rates(tree) == (JUMP,)
    assert track_evidence._rates(_muted(tree)) == BOTH


def test_the_rate_set_follows_the_tree_not_the_clip_regions(tmp_path: Path) -> None:
    plain = _project(tmp_path / "plain", "mixed joins and pads")
    muted = _project(tmp_path / "muted", "mixed joins and pads")
    _with_mutes(muted, tmp_path / "muted" / "project")
    off_speaker = _project(tmp_path / "off", "mixed joins and pads")
    _with_off_speaker(off_speaker, tmp_path / "off" / "project")
    defaults = load_defaults()

    rates = {}
    for name, project in (("plain", plain), ("muted", muted), ("off", off_speaker)):
        planned = track_evidence._plan(project, "caleb", defaults)
        assert not isinstance(planned, Declined)
        rates[name] = track_evidence._rates(planned[1])

    assert rates == {"plain": (JUMP,), "muted": BOTH, "off": (JUMP,)}


@pytest.mark.parametrize("rates", [(JUMP,), (WAVEFORM,), BOTH])
def test_a_rate_set_builds_exactly_those_rates_with_the_two_rate_samples(
    rates: tuple[int, ...], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    both = real_evaluate(tree, "tri", BOTH)
    assert not isinstance(both, Declined)
    calls = _resample_rates(monkeypatch)

    got = real_evaluate(tree, "tri", rates)

    assert not isinstance(got, Declined) and sorted(got) == sorted(rates)
    assert calls == [sorted(rates)]
    for rate in rates:
        np.testing.assert_array_equal(_bits(got[rate]), _bits(both[rate]))


def test_a_ripple_project_builds_one_8khz_entry_and_no_16khz_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "mixed joins and pads")
    defaults = load_defaults()
    calls = _resample_rates(monkeypatch)

    with batch_scope():
        track_evidence.rms(project, "caleb", defaults)
        track_evidence.rms_readers(project, ["caleb"], defaults)["caleb"]()
        entries = list(track_evidence._store()._entries.values())

    assert calls == [[JUMP]]
    assert [sorted(entry.samples) for entry in entries] == [[JUMP]]
    assert track_evidence._RETAINED.held_bytes() == entries[0].nbytes


def test_a_mute_project_builds_both_rates_once_and_heard_hits_after_rms(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "mixed joins and pads")
    _with_mutes(project, tmp_path / "project")
    defaults = load_defaults()
    calls = _resample_rates(monkeypatch)

    with batch_scope():
        rms = track_evidence.rms(project, "caleb", defaults)
        heard = track_evidence.heard(project, "caleb", defaults)

    assert calls == [[JUMP, WAVEFORM]]
    assert heard.jump.samples is rms.samples and heard.waveform.samples.size


def test_rms_after_a_wider_build_is_a_hit_and_a_narrower_hold_is_not(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    store = _Store()
    assert not store.holds(key, (JUMP,))

    store.get_or_build(key, lambda: real_evaluate(tree, "tri", (JUMP,)), (JUMP,))
    assert store.holds(key, (JUMP,)) and not store.holds(key, BOTH)

    store.get_or_build(key, lambda: real_evaluate(tree, "tri", BOTH), BOTH)
    assert store.holds(key, BOTH) and store.holds(key, (JUMP,))


def test_heard_on_a_narrower_key_rebuilds_every_rate_in_one_pass_and_keeps_the_old_holder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    project = _project(tmp_path, "mixed joins and pads")
    defaults = load_defaults()
    calls = _resample_rates(monkeypatch)

    with batch_scope(), caplog.at_level(logging.INFO, logger=track_evidence.__name__):
        narrow = track_evidence.rms(project, "caleb", defaults)
        held = narrow.samples.copy()
        store = track_evidence._store()
        heard = track_evidence.heard(project, "caleb", defaults)
        again = track_evidence.heard(project, "caleb", defaults)
        entries = list(store._entries.values())

    assert calls == [[JUMP], [JUMP, WAVEFORM]]
    assert len(entries) == 1 and sorted(entries[0].samples) == [JUMP, WAVEFORM]
    assert store._bytes == entries[0].nbytes
    assert again.waveform.samples is heard.waveform.samples
    np.testing.assert_array_equal(_bits(narrow.samples), _bits(held))
    np.testing.assert_array_equal(_bits(heard.jump.samples), _bits(held))
    assert any(
        r.levelno == logging.WARNING and "narrower" in r.getMessage() for r in caplog.records
    )
    assert track_evidence._RETAINED.held_bytes() == sum(
        e.nbytes for e in track_evidence._RETAINED._entries.values()
    )


def test_every_build_logs_the_rates_it_asked_for(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    with caplog.at_level(logging.INFO, logger=track_evidence.__name__):
        real_evaluate(tree, "tri", (JUMP,))
        real_evaluate(tree, "tri", BOTH)

    lines = [r.getMessage() for r in caplog.records if "evidence build" in r.getMessage()]
    assert lines == ["evidence build rates=(8000,)", "evidence build rates=(8000, 16000)"]


def _entry(tree: Audio, rates: tuple[int, ...]) -> _Entry:
    built = real_evaluate(tree, "tri", rates)
    assert not isinstance(built, Declined)
    for array in built.values():
        array.flags.writeable = False
    return _Entry(built)


def test_a_replaced_store_entry_gives_back_its_bytes_and_moves_to_the_end(
    tmp_path: Path,
) -> None:
    first = _tree(_tone(tmp_path / "a.wav"))
    other = _tree(_tone(tmp_path / "b.wav", 440.0))
    store = _Store()
    key = EvidenceKey(first, "tri", track_evidence._stamps(first))
    other_key = EvidenceKey(other, "tri", track_evidence._stamps(other))
    narrow, wide, unrelated = _entry(first, (JUMP,)), _entry(first, BOTH), _entry(other, (JUMP,))

    store._put(key, narrow)
    store._put(other_key, unrelated)
    store._put(key, wide)

    assert store._bytes == wide.nbytes + unrelated.nbytes
    assert list(store._entries) == [other_key, key]


def test_a_replacing_entry_is_not_evicted_by_its_own_trim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    store = _Store()
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    narrow, wide = _entry(tree, (JUMP,)), _entry(tree, BOTH)
    monkeypatch.setattr(track_evidence, "EVIDENCE_CACHE_BYTES", wide.nbytes + 1)

    store._put(key, narrow)
    store._put(key, wide)

    assert store._entries == {key: wide} and store._bytes == wide.nbytes


def test_a_woken_waiter_does_not_drop_a_newer_builders_lock(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    store = _Store()
    newer = threading.Lock()

    def build():  # type: ignore[no-untyped-def]
        store._building[key] = newer
        return real_evaluate(tree, "tri", (JUMP,))

    store.get_or_build(key, build, (JUMP,))

    assert store._building == {key: newer}


def test_rms_returns_while_a_wider_build_of_its_key_is_blocked(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    store = _Store()
    store.get_or_build(key, lambda: real_evaluate(tree, "tri", (JUMP,)), (JUMP,))
    started, release = threading.Event(), threading.Event()

    def wide():  # type: ignore[no-untyped-def]
        started.set()
        assert release.wait(30)
        return real_evaluate(tree, "tri", BOTH)

    worker = threading.Thread(target=store.get_or_build, args=(key, wide, BOTH))
    worker.start()
    try:
        assert started.wait(30)
        got = store.get_or_build(key, lambda: pytest.fail("rms rebuilt"), (JUMP,))
        assert isinstance(got, _Entry) and sorted(got.samples) == [JUMP]
    finally:
        release.set()
        worker.join(30)
    assert sorted(store._entries[key].samples) == [JUMP, WAVEFORM]


def test_two_wider_requests_for_a_narrow_key_build_once(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    store = _Store()
    store.get_or_build(key, lambda: real_evaluate(tree, "tri", (JUMP,)), (JUMP,))
    inside, release = threading.Event(), threading.Event()
    builds: list[int] = []

    def wide():  # type: ignore[no-untyped-def]
        builds.append(1)
        inside.set()
        assert release.wait(30)
        return real_evaluate(tree, "tri", BOTH)

    results: list[object] = []
    threads = [
        threading.Thread(target=lambda: results.append(store.get_or_build(key, wide, BOTH)))
        for _ in range(2)
    ]
    threads[0].start()
    assert inside.wait(30)
    threads[1].start()
    release.set()
    for thread in threads:
        thread.join(30)

    assert builds == [1] and results[0] is results[1]
    assert store._bytes == store._entries[key].nbytes


def test_verify_raises_assertion_error_for_a_rate_the_stored_entry_lacks(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    narrow = _entry(tree, (JUMP,))
    wide = real_evaluate(tree, "tri", BOTH)

    with pytest.raises(AssertionError):
        track_evidence._verify(narrow, wide)
    track_evidence._verify(_entry(tree, BOTH), real_evaluate(tree, "tri", (JUMP,)))


def test_verify_checks_the_whole_waveform_array(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    stored = _entry(tree, BOTH)
    rebuilt = real_evaluate(tree, "tri", BOTH)
    assert not isinstance(rebuilt, Declined)
    rebuilt[WAVEFORM] = rebuilt[WAVEFORM].copy()
    rebuilt[WAVEFORM][-1] += 1e-3

    with pytest.raises(AssertionError):
        track_evidence._verify(stored, rebuilt)


def test_a_retained_entry_is_a_hit_only_for_the_rates_it_holds(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    retained = track_evidence._RETAINED
    builds: list[tuple[int, ...]] = []

    def get(rates: tuple[int, ...]):  # type: ignore[no-untyped-def]
        def build():  # type: ignore[no-untyped-def]
            builds.append(rates)
            return real_evaluate(tree, "tri", rates)

        return retained.get_or_build(key, tree, build, rates)

    narrow = get((JUMP,))
    assert isinstance(narrow, _Entry) and get((JUMP,)) is narrow
    wide = get(BOTH)
    assert isinstance(wide, _Entry) and sorted(wide.samples) == [JUMP, WAVEFORM]
    assert get((JUMP,)) is wide and get(BOTH) is wide
    assert builds == [(JUMP,), BOTH]
    assert retained.held_bytes() == wide.nbytes and len(retained) == 1
    assert wide._profiles is not narrow._profiles
    assert narrow.samples[JUMP].shape == wide.samples[JUMP].shape


def test_a_wider_build_over_the_cap_is_served_and_the_held_entry_is_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    retained = track_evidence._RETAINED
    narrow = retained.get_or_build(key, tree, lambda: real_evaluate(tree, "tri", (JUMP,)), (JUMP,))
    assert isinstance(narrow, _Entry)
    monkeypatch.setenv(track_evidence.KEEP_ENV, str((narrow.nbytes + 1) / (1 << 20)))

    wide = retained.get_or_build(key, tree, lambda: real_evaluate(tree, "tri", BOTH), BOTH)

    assert not isinstance(wide, Declined) and sorted(
        wide.samples if isinstance(wide, _Entry) else wide
    ) == [JUMP, WAVEFORM]
    assert retained.get_or_build(key, tree, lambda: pytest.fail("rebuilt"), (JUMP,)) is narrow
    assert retained.held_bytes() == narrow.nbytes


def test_a_source_rewritten_during_a_wider_build_is_served_in_one_pass_and_not_kept(
    tmp_path: Path,
) -> None:
    path = _tone(tmp_path / "a.wav")
    tree = _tree(path)
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    retained = track_evidence._RETAINED
    narrow = retained.get_or_build(key, tree, lambda: real_evaluate(tree, "tri", (JUMP,)), (JUMP,))
    assert isinstance(narrow, _Entry)
    stat = path.stat()
    passes: list[int] = []

    def rewrite_then_build():  # type: ignore[no-untyped-def]
        passes.append(1)
        built = real_evaluate(tree, "tri", BOTH)
        _tone(path, 550.0)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        return built

    got = retained.get_or_build(key, tree, rewrite_then_build, BOTH)

    assert passes == [1] and not isinstance(got, (_Entry, Declined)) and sorted(got) == list(BOTH)
    assert retained.held_bytes() == narrow.nbytes and len(retained) == 1


def test_a_changed_ffmpeg_build_between_keeps_leaves_no_mixed_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    retained = track_evidence._RETAINED
    monkeypatch.setattr(track_evidence, "_build_id", lambda: ("old",))
    retained.get_or_build(key, tree, lambda: real_evaluate(tree, "tri", (JUMP,)), (JUMP,))
    monkeypatch.setattr(track_evidence, "_build_id", lambda: ("new",))

    wide = retained.get_or_build(key, tree, lambda: real_evaluate(tree, "tri", BOTH), BOTH)

    assert isinstance(wide, _Entry) and sorted(wide.samples) == [JUMP, WAVEFORM]
    assert len(retained) == 1 and retained.held_bytes() == wide.nbytes
