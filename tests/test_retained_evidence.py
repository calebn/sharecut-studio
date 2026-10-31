"""Track evidence kept between batches as read-only maps of unlinked temp files, exact and bounded."""

from __future__ import annotations

import errno
import gc
import mmap
import os
import threading
import time
import types
import wave
import weakref
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import decoded_source, track_evidence
from podcast_mcp.engines.audio import At, Audio, MixAudio, SequenceAudio, SourceAudio
from podcast_mcp.engines.track_evidence import Declined, Evidence, EvidenceKey, _Entry
from podcast_mcp.util.batch_scope import batch_scope
from test_audio_eval import _ffmpeg_or_skip, _project
from test_windowed_approve import _approve, _Counts
from test_windowed_approve import _project as _windowed_project

JUMP, WAVEFORM = 8000, 16000
RETAINED = track_evidence._RETAINED
real_evaluate = track_evidence._evaluate
posix_only = pytest.mark.skipif(os.name == "nt", reason="evidence is kept on POSIX only")


@pytest.fixture(autouse=True)
def _aged_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fixtures written a moment ago are racy for the store; read the clock an hour on."""
    monkeypatch.setattr(track_evidence, "_now_ns", lambda: time.time_ns() + 3600 * 10**9)


@pytest.fixture(autouse=True)
def _ffmpeg() -> None:
    _ffmpeg_or_skip()


def _tone(path: Path, frequency: float = 330.0) -> Path:
    t = np.arange(5 * 48000) / 48000
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(
            (0.3 * np.sin(2 * np.pi * frequency * t) * 32767).astype("<i2").tobytes()
        )
    return path


def _tree(path: Path, start: float = 0.2) -> Audio:
    first = SourceAudio(path, start, start + 2.0, 0.02, 0.03)
    second = SourceAudio(path, start + 2.3, start + 4.3, 0.02, 0.03)
    return MixAudio(At(0.0, SequenceAudio(first, (second,))), ())


class Calls:
    """Counts the evaluations a store asks for."""

    def __init__(self) -> None:
        self.trees: list[Audio] = []

    def get(
        self, tree: Audio, *, before: Callable[[], None] | None = None
    ) -> Evidence | Declined | _Entry:
        key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))

        def build() -> Evidence | Declined:
            self.trees.append(tree)
            if before is not None:
                before()
            return real_evaluate(tree, "tri")

        return RETAINED.get_or_build(key, tree, build)


def _bits(array: np.ndarray) -> np.ndarray:
    return array.view(np.uint32)


def _fresh(tree: Audio) -> Evidence:
    evidence = real_evaluate(tree, "tri")
    assert not isinstance(evidence, Declined)
    return evidence


def _fds() -> int:
    return len(os.listdir("/dev/fd"))


def _spool_files() -> list[Path]:
    return [p for p in decoded_source._spool_directory().rglob("*.f32")]


@posix_only
def test_a_later_read_gets_the_kept_evidence_as_plain_read_only_arrays_of_the_same_bits(
    tmp_path: Path,
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    calls = Calls()

    first = calls.get(tree)
    again = calls.get(tree)

    assert isinstance(first, _Entry) and again is first
    assert len(calls.trees) == 1 and len(RETAINED) == 1 and RETAINED.held_bytes() == first.nbytes
    fresh = _fresh(tree)
    for rate, array in first.samples.items():
        assert type(array) is np.ndarray and not array.flags.writeable
        np.testing.assert_array_equal(_bits(array), _bits(fresh[rate]))
    assert _spool_files() == []


def _cap_of_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(track_evidence.KEEP_ENV, "0")


def _ram_backed_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(decoded_source, "_in_memory_filesystem", lambda directory: True)


def _little_free_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    low = types.SimpleNamespace(free=decoded_source.SPILL_HEADROOM_BYTES)
    monkeypatch.setattr(decoded_source.shutil, "disk_usage", lambda directory: low)


def _windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(track_evidence, "os", types.SimpleNamespace(name="nt"))


@pytest.mark.parametrize(
    "unsuitable", [_cap_of_zero, _ram_backed_directory, _little_free_disk, _windows]
)
def test_where_nothing_may_be_kept_every_read_evaluates_and_nothing_is_held(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, unsuitable: Callable[..., None]
) -> None:
    unsuitable(monkeypatch)
    calls = Calls()
    tree = _tree(_tone(tmp_path / "a.wav"))

    first = calls.get(tree)
    calls.get(tree)

    assert isinstance(first, dict) and len(calls.trees) == 2 and len(RETAINED) == 0


def test_the_cap_is_read_live_and_a_drop_to_zero_releases_what_was_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    calls = Calls()
    calls.get(tree)
    assert len(RETAINED) == 1

    monkeypatch.setenv(track_evidence.KEEP_ENV, "0")
    calls.get(tree)

    assert len(RETAINED) == 0 and RETAINED.held_bytes() == 0 and RETAINED._timer is None


def test_the_defaults_and_unusable_values(monkeypatch: pytest.MonkeyPatch) -> None:
    assert track_evidence.keep_bytes() == 3072 << 20
    assert track_evidence.idle_seconds() == 2700
    for value in ("inf", "nan", "1e400", "junk"):
        monkeypatch.setenv(track_evidence.KEEP_ENV, value)
        monkeypatch.setenv(track_evidence.IDLE_ENV, value)
        assert track_evidence.keep_bytes() == 3072 << 20
        assert track_evidence.idle_seconds() == 2700
    monkeypatch.setenv(track_evidence.KEEP_ENV, "-4")
    monkeypatch.setenv(track_evidence.IDLE_ENV, "1e9")
    assert track_evidence.keep_bytes() == 0
    assert track_evidence.idle_seconds() == track_evidence.MAX_IDLE_S


def test_a_source_modified_in_the_last_two_seconds_is_built_but_not_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(track_evidence, "_now_ns", time.time_ns)
    tree = _tree(_tone(tmp_path / "a.wav"))
    calls = Calls()

    first = calls.get(tree)
    calls.get(tree)

    assert isinstance(first, dict) and len(calls.trees) == 2 and len(RETAINED) == 0


@posix_only
def test_a_source_overwritten_in_place_with_its_size_and_mtime_misses_and_reads_fresh_bytes(
    tmp_path: Path,
) -> None:
    path = _tone(tmp_path / "a.wav", 330)
    tree = _tree(path)
    calls = Calls()
    first = calls.get(tree)
    stat = path.stat()
    kept = {rate: array.copy() for rate, array in first.samples.items()}

    other = _tone(tmp_path / "b.wav", 770)
    with path.open("r+b") as handle:
        handle.write(other.read_bytes())
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert (path.stat().st_ino, path.stat().st_size, path.stat().st_mtime_ns) == (
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
    )
    second = calls.get(tree)

    assert len(calls.trees) == 2 and isinstance(second, _Entry) and second is not first
    assert not np.array_equal(_bits(second.samples[JUMP]), _bits(kept[JUMP]))
    expected = _fresh(_tree(other))
    for rate in (JUMP, WAVEFORM):
        np.testing.assert_array_equal(_bits(second.samples[rate]), _bits(expected[rate]))


def test_a_source_touched_during_the_build_is_not_kept(tmp_path: Path) -> None:
    path = _tone(tmp_path / "a.wav")
    tree = _tree(path)
    calls = Calls()

    built = calls.get(tree, before=lambda: os.utime(path, ns=(1, 1)))

    assert isinstance(built, dict) and len(RETAINED) == 0
    assert _fresh(tree)[JUMP].size == built[JUMP].size


@posix_only
def test_a_full_disk_serves_the_ram_arrays_and_keeps_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    real = os.write

    def full(fd: int, data: object) -> int:
        if fd > 2:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real(fd, data)  # type: ignore[arg-type]

    _fresh(tree)  # the decode spool keeps its own descriptor for the source
    before = _fds()
    with monkeypatch.context() as patch:
        patch.setattr(decoded_source.os, "write", full)
        built = Calls().get(tree)

    assert isinstance(built, dict) and len(RETAINED) == 0
    assert _fds() == before and _spool_files() == []
    for rate, array in _fresh(tree).items():
        np.testing.assert_array_equal(_bits(built[rate]), _bits(array))


@posix_only
def test_a_full_disk_inside_a_batch_still_dedupes_in_the_batch_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "fade joins")
    defaults = load_defaults()
    evaluated: list[Audio] = []
    monkeypatch.setattr(
        track_evidence,
        "_evaluate",
        lambda tree, curve, *rates: evaluated.append(tree) or real_evaluate(tree, curve, *rates),
    )

    def full(array: np.ndarray) -> np.ndarray:
        raise OSError("full")

    monkeypatch.setattr(track_evidence, "spill", full)

    with batch_scope():
        first = track_evidence.rms(project, "caleb", defaults)
        again = track_evidence.rms(project, "caleb", defaults)

    assert len(evaluated) == 1 and len(RETAINED) == 0
    np.testing.assert_array_equal(_bits(first.samples), _bits(again.samples))


@posix_only
def test_an_entry_held_by_a_reader_stays_readable_after_eviction_and_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    one, two = _tree(_tone(tmp_path / "a.wav", 330)), _tree(_tone(tmp_path / "b.wav", 550))
    calls = Calls()
    held = calls.get(one)
    expected = {rate: array.copy() for rate, array in held.samples.items()}
    size = held.nbytes
    monkeypatch.setenv(track_evidence.KEEP_ENV, str(size * 1.5 / (1 << 20)))

    reader = held.cache(JUMP)
    calls.get(two)
    assert len(RETAINED) == 1 and RETAINED.held_bytes() <= size * 1.5
    RETAINED.clear()
    del held
    gc.collect()

    np.testing.assert_array_equal(_bits(reader.samples), _bits(expected[JUMP]))
    calls.get(one)
    assert len(calls.trees) == 3


@posix_only
def test_the_maps_are_freed_with_the_last_array_and_no_temp_file_is_left(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    maps: list[weakref.ref] = []

    class Tracked(mmap.mmap):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__()  # type: ignore[call-arg]
            maps.append(weakref.ref(self))

    monkeypatch.setattr(decoded_source.mmap, "mmap", Tracked)
    tree = _tree(_tone(tmp_path / "a.wav"))
    entry = Calls().get(tree)
    assert len(maps) == 2 and all(ref() is not None for ref in maps)
    assert _spool_files() == []

    RETAINED.clear()
    assert all(ref() is not None for ref in maps)
    del entry
    gc.collect()

    assert all(ref() is None for ref in maps)
    assert _spool_files() == []


class Clock:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.now = 1000.0
        monkeypatch.setattr(track_evidence, "_monotonic", lambda: self.now)


@posix_only
def test_idle_release_drops_entries_and_declines_and_the_next_read_builds_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    tree = _tree(_tone(tmp_path / "a.wav"))
    calls = Calls()
    first = {rate: a.copy() for rate, a in calls.get(tree).samples.items()}
    declined_key = EvidenceKey(tree, "other", ())
    RETAINED._declined[declined_key] = Declined.EVALUATOR
    assert RETAINED._timer is not None

    clock.now += 2000
    RETAINED._release_if_idle()
    assert len(RETAINED) == 1
    clock.now += 700
    RETAINED._release_if_idle()
    assert len(RETAINED) == 0 and declined_key not in RETAINED._declined
    assert RETAINED.held_bytes() == 0 and RETAINED._timer is None

    again = calls.get(tree)
    assert len(calls.trees) == 2 and RETAINED._timer is not None
    for rate, array in first.items():
        np.testing.assert_array_equal(_bits(again.samples[rate]), _bits(array))


@posix_only
def test_a_hit_and_a_store_postpone_the_release_and_a_build_in_flight_defers_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    one, two = _tree(_tone(tmp_path / "a.wav", 330)), _tree(_tone(tmp_path / "b.wav", 440))
    calls = Calls()
    calls.get(one)
    clock.now += 2000
    calls.get(one)  # a hit
    clock.now += 2000
    RETAINED._release_if_idle()
    assert len(RETAINED) == 1
    calls.get(two)  # a store
    clock.now += 2000
    RETAINED._release_if_idle()
    assert len(RETAINED) == 2

    clock.now += 1000
    RETAINED._building[EvidenceKey(one, "x", ())] = threading.Lock()
    RETAINED._release_if_idle()
    assert len(RETAINED) == 2 and RETAINED._timer is not None
    RETAINED._building.clear()
    RETAINED._release_if_idle()
    assert len(RETAINED) == 0


@posix_only
def test_the_idle_timer_is_armed_with_the_configured_idle_seconds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    Clock(monkeypatch)
    monkeypatch.setenv(track_evidence.IDLE_ENV, "123")
    assert track_evidence.DEFAULT_IDLE_S != 123
    tree = _tree(_tone(tmp_path / "a.wav"))

    Calls().get(tree)

    timer = RETAINED._timer
    try:
        assert timer is not None and len(RETAINED) == 1
        assert timer.interval == 123
    finally:
        if timer is not None:
            timer.cancel()


@pytest.mark.parametrize("value", ["0", "-5"])
def test_an_idle_of_zero_or_less_never_arms_a_timer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    clock = Clock(monkeypatch)
    monkeypatch.setenv(track_evidence.IDLE_ENV, value)
    Calls().get(_tree(_tone(tmp_path / "a.wav")))
    assert RETAINED._timer is None
    clock.now += 10**6
    RETAINED._release_if_idle()
    assert len(RETAINED) == 1


@posix_only
def test_the_least_recently_used_entry_goes_first_past_the_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    trees = [_tree(_tone(tmp_path / f"{n}.wav", 300 + n)) for n in range(3)]
    calls = Calls()
    size = calls.get(trees[0]).nbytes
    monkeypatch.setenv(track_evidence.KEEP_ENV, str(size * 2.5 / (1 << 20)))
    calls.get(trees[1])
    calls.get(trees[0])  # trees[1] is now the oldest
    calls.get(trees[2])
    assert len(RETAINED) == 2

    calls.trees.clear()
    calls.get(trees[0])
    calls.get(trees[2])
    assert calls.trees == []
    calls.get(trees[1])
    assert calls.trees == [trees[1]]


@posix_only
def test_a_key_kept_twice_by_racing_builders_is_counted_once(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
    cap = track_evidence.keep_bytes()

    def build() -> Evidence | Declined:
        return real_evaluate(tree, "tri")

    RETAINED._keep(key, tree, build, cap)
    kept = RETAINED._keep(key, tree, build, cap)

    assert isinstance(kept, _Entry)
    assert len(RETAINED) == 1 and RETAINED.held_bytes() == kept.nbytes


@posix_only
def test_an_entry_over_the_cap_is_not_kept(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(track_evidence.KEEP_ENV, "0.1")
    built = Calls().get(_tree(_tone(tmp_path / "a.wav")))

    assert isinstance(built, dict) and len(RETAINED) == 0


@posix_only
def test_threads_that_ask_together_share_one_build(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    calls = Calls()
    barrier = threading.Barrier(5)
    results: list[object] = []

    def ask() -> None:
        barrier.wait()
        results.append(calls.get(tree))

    threads = [threading.Thread(target=ask) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert len(calls.trees) == 1 and len(results) == 5
    assert all(result is results[0] for result in results)


@posix_only
def test_a_changed_ffmpeg_build_drops_what_was_kept_and_a_hit_resolves_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ids = [("ffmpeg", "6")]
    resolved: list[int] = []

    def build_id() -> tuple[object, ...]:
        resolved.append(1)
        return ids[0]

    monkeypatch.setattr(track_evidence, "ffmpeg_build_id", build_id)
    one, two = _tree(_tone(tmp_path / "a.wav", 330)), _tree(_tone(tmp_path / "b.wav", 440))
    calls = Calls()
    calls.get(one)
    calls.get(one)
    assert len(resolved) == 2  # before and after the one build; the hit added none

    ids[0] = ("ffmpeg", "7")
    calls.get(two)

    assert len(RETAINED) == 1 and len(resolved) == 4
    calls.get(one)
    assert len(calls.trees) == 3


@posix_only
def test_an_ffmpeg_that_cannot_be_resolved_keeps_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unresolved() -> tuple[object, ...]:
        raise OSError("no ffmpeg")

    monkeypatch.setattr(track_evidence, "ffmpeg_build_id", unresolved)
    built = Calls().get(_tree(_tone(tmp_path / "a.wav")))

    assert isinstance(built, dict) and len(RETAINED) == 0


def test_declines_are_remembered_up_to_a_bound_first_in_first_out(tmp_path: Path) -> None:
    path = _tone(tmp_path / "a.wav")
    trees = [_tree(path, start=n / 1000) for n in range(track_evidence.MAX_DECLINED + 5)]
    built = 0

    def build_for(tree: Audio) -> Callable[[], Evidence | Declined]:
        def build() -> Declined:
            nonlocal built
            built += 1
            return Declined.EVALUATOR

        return build

    for tree in trees:
        key = EvidenceKey(tree, "tri", track_evidence._stamps(tree))
        assert RETAINED.get_or_build(key, tree, build_for(tree)) is Declined.EVALUATOR
    assert len(RETAINED._declined) == track_evidence.MAX_DECLINED

    last = trees[-1]
    RETAINED.get_or_build(
        EvidenceKey(last, "tri", track_evidence._stamps(last)), last, build_for(last)
    )
    assert built == len(trees)
    first = trees[0]
    RETAINED.get_or_build(
        EvidenceKey(first, "tri", track_evidence._stamps(first)), first, build_for(first)
    )
    assert built == len(trees) + 1


@posix_only
def test_verify_mode_evaluates_every_hit_and_compares_the_mapped_bits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    calls = Calls()
    entry = calls.get(tree)
    monkeypatch.setenv(track_evidence.VERIFY_ENV, "1")

    assert calls.get(tree) is entry
    assert len(calls.trees) == 2

    poisoned = entry.samples[JUMP].copy()
    poisoned[100] += 0.5
    poisoned.flags.writeable = False
    entry.samples[JUMP] = poisoned
    with pytest.raises(AssertionError, match="evidence"):
        calls.get(tree)


def test_verify_tells_minus_zero_from_zero() -> None:
    stored = _Entry({JUMP: np.zeros(4, dtype=np.float32)})
    rebuilt = {JUMP: np.zeros(4, dtype=np.float32)}
    track_evidence._verify(stored, rebuilt)
    rebuilt[JUMP][2] = -0.0

    with pytest.raises(AssertionError):
        track_evidence._verify(stored, rebuilt)


@posix_only
def test_the_batch_store_stays_in_front_and_holds_what_a_batch_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "mixed joins and pads")
    defaults = load_defaults()
    evaluated: list[Audio] = []
    monkeypatch.setattr(
        track_evidence,
        "_evaluate",
        lambda tree, curve, *rates: evaluated.append(tree) or real_evaluate(tree, curve, *rates),
    )

    with batch_scope():
        first = track_evidence.heard(project, "caleb", defaults)
        store = track_evidence._store()
        assert len(store._entries) == 1
    with batch_scope():
        again = track_evidence.heard(project, "caleb", defaults)
        track_evidence.rms(project, "caleb", defaults)
        assert len(track_evidence._store()._entries) == 1
    outside = track_evidence.rms(project, "caleb", defaults)

    assert len(evaluated) == 1
    np.testing.assert_array_equal(_bits(first.jump.samples), _bits(again.jump.samples))
    np.testing.assert_array_equal(_bits(first.waveform.samples), _bits(again.waveform.samples))
    np.testing.assert_array_equal(_bits(first.jump.samples), _bits(outside.samples))
    assert again.jump.recording_profile == first.jump.recording_profile


def _check_then_approve(root: Path) -> tuple[dict, dict]:
    """What ``propose_tighten`` does: check on a scratch copy, then the real approval."""
    import copy

    project = _windowed_project(root)
    checked = _approve(copy.deepcopy(project))
    return checked, _approve(project)


def _digest(outcome: dict) -> str:
    import hashlib
    import json

    return hashlib.sha256(json.dumps(outcome, sort_keys=True, default=str).encode()).hexdigest()


@posix_only
def test_check_and_approve_with_retention_decide_as_without_it_and_build_nothing_the_second_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with monkeypatch.context() as without:
        without.setenv(track_evidence.KEEP_ENV, "0")
        off_counts = _Counts(without)
        off = _check_then_approve(tmp_path / "off")
    on_counts = _Counts(monkeypatch)
    on = _check_then_approve(tmp_path / "on")

    assert _digest(on[0]) == _digest(off[0]) and _digest(on[1]) == _digest(off[1])
    assert on[1]["held"] == off[1]["held"] and on[1]["clips"] == off[1]["clips"]
    assert len(off_counts.whole) == 2 + 2
    assert len(on_counts.whole) == 2
    assert len(RETAINED) == 2
    assert on_counts.windows == off_counts.windows


@posix_only
def test_a_check_that_reads_outside_its_window_decides_the_same_with_retention_and_evaluates_less(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits import verdict_cache

    monkeypatch.setattr(verdict_cache, "check_reach_sec", lambda *args, **kwargs: 2.0)
    with monkeypatch.context() as without:
        without.setenv(track_evidence.KEEP_ENV, "0")
        off_counts = _Counts(without)
        off = _check_then_approve(tmp_path / "off")
    RETAINED.clear()

    on_counts = _Counts(monkeypatch)
    on = _check_then_approve(tmp_path / "on")

    assert off_counts.fell_back > 0 and on_counts.fell_back == off_counts.fell_back
    assert _digest(on[0]) == _digest(off[0]) and _digest(on[1]) == _digest(off[1])
    assert len(on_counts.whole) < len(off_counts.whole)


@posix_only
def test_check_and_approve_are_clean_under_evidence_verify(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _check_then_approve(tmp_path / "plain")
    RETAINED.clear()
    monkeypatch.setenv(track_evidence.VERIFY_ENV, "1")

    verified = _check_then_approve(tmp_path / "verified")

    assert _digest(verified[1]) == _digest(expected[1])


def _key(tree: Audio) -> EvidenceKey:
    return EvidenceKey(tree, "tri", track_evidence._stamps(tree))


@posix_only
def test_the_racy_rule_is_read_at_the_clock_before_the_build_not_after_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _tone(tmp_path / "a.wav")
    tree = _tree(path)
    modified = max(path.stat().st_mtime_ns, path.stat().st_ctime_ns)
    building: list[bool] = []
    monkeypatch.setattr(
        track_evidence,
        "_now_ns",
        lambda: modified + 3600 * 10**9 if building else modified + 10**6,
    )

    built = Calls().get(tree, before=lambda: building.append(True))

    assert isinstance(built, dict) and len(RETAINED) == 0


@posix_only
@pytest.mark.parametrize(
    ("age_ns", "kept"),
    [
        (int(track_evidence.RACY_SECONDS * 1e9), 1),
        (int(track_evidence.RACY_SECONDS * 1e9) - 1, 0),
    ],
    ids=["exactly-racy-seconds-old-is-kept", "a-nanosecond-younger-is-not"],
)
def test_the_racy_boundary_keeps_a_source_exactly_racy_seconds_old(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, age_ns: int, kept: int
) -> None:
    path = _tone(tmp_path / "a.wav")
    tree = _tree(path)
    stat = path.stat()
    modified = max(stat.st_mtime_ns, stat.st_ctime_ns)
    monkeypatch.setattr(track_evidence, "_now_ns", lambda: modified + age_ns)

    Calls().get(tree)

    assert len(RETAINED) == kept


@posix_only
def test_entries_are_bounded_in_number_and_so_in_descriptors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(track_evidence, "MAX_ENTRIES", 2)
    path = _tone(tmp_path / "a.wav")  # one source, so the decode spool adds no descriptors
    trees = [_tree(path, start=n / 10) for n in range(4)]
    calls = Calls()
    calls.get(trees[0])
    calls.get(trees[1])
    two_held = _fds()

    for tree in trees[2:]:
        calls.get(tree)

    assert len(RETAINED) == 2 and _fds() <= two_held
    calls.trees.clear()
    calls.get(trees[3])
    assert calls.trees == []
    calls.get(trees[0])
    assert calls.trees == [trees[0]]


@posix_only
def test_an_ffmpeg_swapped_during_the_build_is_not_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ids = iter([("ffmpeg", "6"), ("ffmpeg", "7")])
    monkeypatch.setattr(track_evidence, "ffmpeg_build_id", lambda: next(ids))

    built = Calls().get(_tree(_tone(tmp_path / "a.wav")))

    assert isinstance(built, dict) and len(RETAINED) == 0


@posix_only
def test_a_finished_build_leaves_a_newer_builders_lock_in_place(tmp_path: Path) -> None:
    tree = _tree(_tone(tmp_path / "a.wav"))
    newer = threading.Lock()

    def another_builder_arrives() -> None:
        RETAINED._building[_key(tree)] = newer

    Calls().get(tree, before=another_builder_arrives)

    assert RETAINED._building[_key(tree)] is newer


@posix_only
def test_a_kept_entry_drops_the_entry_of_the_same_tree_over_older_revisions(
    tmp_path: Path,
) -> None:
    path = _tone(tmp_path / "a.wav")
    tree = _tree(path)
    calls = Calls()
    first = calls.get(tree)
    os.utime(path, ns=(1, 2))

    second = calls.get(tree)

    assert len(calls.trees) == 2 and second is not first
    assert list(RETAINED._entries) == [_key(tree)]
    assert RETAINED.held_bytes() == second.nbytes
