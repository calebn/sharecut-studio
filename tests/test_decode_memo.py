"""The process-wide decode memo of raw recordings (#2359)."""

from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import decode_track
from podcast_mcp.engines import audio_audit, decode_memo
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.util import batch_scope

RATE = 8000


class Decoder:
    """Stands in for ``load_mono_full``; every call returns fresh samples and is counted."""

    def __init__(self) -> None:
        self.calls: list[tuple[Path, int]] = []
        self.lock = threading.Lock()
        self.gate: threading.Barrier | None = None
        self.fail = False
        self.fail_once = False
        self.hold: threading.Event | None = None
        self.active = 0
        self.peak = 0

    def __call__(self, path: Path, *, sample_rate: int = 8000, ffmpeg: str | None = None):  # type: ignore[no-untyped-def]
        with self.lock:
            self.calls.append((path, sample_rate))
            seed = len(self.calls)
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            if self.hold is not None:
                self.hold.wait(timeout=10)
            with self.lock:
                failing = self.fail or self.fail_once
                self.fail_once = False
            if failing:
                raise RuntimeError("decode failed")
        finally:
            with self.lock:
                self.active -= 1
        if self.gate is not None:
            self.gate.wait(timeout=5)
        rng = np.random.default_rng(seed)
        return (rng.standard_normal(sample_rate).astype(np.float32) * 0.1).copy()


@pytest.fixture
def decoder(monkeypatch: pytest.MonkeyPatch) -> Decoder:
    fake = Decoder()
    monkeypatch.setattr(audio_audit, "load_mono_full", fake)
    monkeypatch.setattr(decode_memo, "ffmpeg_build_id", lambda: ("ffmpeg", (1,), (0, 0)))
    # ctime cannot be set, so a test file always has a fresh one; run the clock an hour ahead
    monkeypatch.setattr(decode_memo, "_now_ns", lambda: time.time_ns() + 3600 * 10**9)
    monkeypatch.delenv("PODCAST_DECODE_MEMO_MB", raising=False)
    for env in decode_memo.VERIFY_ENVS:
        monkeypatch.delenv(env, raising=False)
    return fake


def _recording(directory: Path, name: str = "a.wav", body: bytes = b"x" * 100) -> Path:
    path = directory / name
    path.write_bytes(body)
    _age(path)
    return path


def _age(path: Path, seconds: float = 3600) -> None:
    then = time.time_ns() - int(seconds * 1e9)
    os.utime(path, ns=(then, then))


def test_a_second_call_is_a_hit(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    first = TrackRmsCache.from_recording(path, sample_rate=RATE)
    second = TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 1
    assert np.array_equal(first.samples, second.samples)
    assert not second.samples.flags.writeable
    with pytest.raises(ValueError):
        second.samples[0] = 1.0


def test_a_hit_is_a_fresh_wrapper(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    first = TrackRmsCache.from_recording(path, sample_rate=RATE)
    second = TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert first is not second
    second.timeline_offset_sec = 5.0
    assert TrackRmsCache.from_recording(path, sample_rate=RATE).timeline_offset_sec == 0.0


def _read_only(cache: TrackRmsCache) -> bool:
    return not cache.samples.flags.writeable


def test_every_miss_hands_back_read_only_samples(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _recording(tmp_path, "a.wav")
    stored = TrackRmsCache.from_recording(first, sample_rate=RATE)
    served = TrackRmsCache.from_recording(first, sample_rate=RATE)
    assert _read_only(stored) and _read_only(served)

    monkeypatch.setattr(decode_memo, "_now_ns", time.time_ns)
    racy = TrackRmsCache.from_recording(_recording(tmp_path, "b.wav"), sample_rate=RATE)
    assert _read_only(racy)

    monkeypatch.setattr(decode_memo, "_now_ns", lambda: time.time_ns() + 3600 * 10**9)
    monkeypatch.setattr(decode_memo, "cap_bytes", lambda: 1000)
    too_big = TrackRmsCache.from_recording(_recording(tmp_path, "c.wav"), sample_rate=RATE)
    assert _read_only(too_big)


def test_a_changed_during_the_decode_miss_hands_back_read_only_samples(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)
    inner = audio_audit.load_mono_full

    def racing(*args, **kwargs):  # type: ignore[no-untyped-def]
        out = inner(*args, **kwargs)
        path.write_bytes(b"w" * 300)
        return out

    monkeypatch.setattr(audio_audit, "load_mono_full", racing)
    assert _read_only(TrackRmsCache.from_recording(path, sample_rate=RATE))


def test_the_memo_off_hands_back_the_decoders_writable_array(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_DECODE_MEMO_MB", "0")
    assert TrackRmsCache.from_recording(
        _recording(tmp_path), sample_rate=RATE
    ).samples.flags.writeable


def test_a_changed_size_misses(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    path.write_bytes(b"y" * 200)
    _age(path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2


def test_a_changed_mtime_misses(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    _age(path, 7200)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2


def test_a_replaced_inode_with_the_same_size_and_mtime_misses(
    tmp_path: Path, decoder: Decoder
) -> None:
    path = _recording(tmp_path)
    stamp = path.stat().st_mtime_ns
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    other = tmp_path / "other.wav"
    other.write_bytes(b"z" * 100)
    os.utime(other, ns=(stamp, stamp))
    os.replace(other, path)
    assert path.stat().st_mtime_ns == stamp
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2


def test_a_rewrite_with_a_restored_mtime_misses_on_ctime(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    stamp = path.stat().st_mtime_ns
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    before = path.stat().st_ctime_ns
    for _ in range(100_000):  # rewrite until the filesystem's clock has moved on
        path.write_bytes(b"q" * 100)
        os.utime(path, ns=(stamp, stamp))
        if path.stat().st_ctime_ns != before:
            break
    assert path.stat().st_ctime_ns != before
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2


def test_a_copy_to_another_path_and_another_rate_miss(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    copy = tmp_path / "copy.wav"
    shutil.copy2(path, copy)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    TrackRmsCache.from_recording(copy, sample_rate=RATE)
    TrackRmsCache.from_recording(path, sample_rate=16000)
    assert len(decoder.calls) == 3


def test_a_recently_modified_file_is_not_stored(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(decode_memo, "_now_ns", time.time_ns)
    path = tmp_path / "fresh.wav"
    path.write_bytes(b"x" * 100)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2
    assert len(decode_memo._MEMO) == 0


def test_an_old_mtime_with_a_fresh_ctime_is_neither_stored_nor_served(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)  # mtime an hour old, ctime just now
    TrackRmsCache.from_recording(path, sample_rate=RATE)  # stored on the clock an hour ahead
    assert len(decode_memo._MEMO) == 1
    monkeypatch.setattr(decode_memo, "_now_ns", time.time_ns)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2  # not served
    assert len(decode_memo._MEMO) == 0  # and the earlier decode of the path is gone


def test_a_file_modified_within_two_seconds_is_neither_stored_nor_served(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)
    ctime = path.stat().st_ctime_ns
    monkeypatch.setattr(decode_memo, "_now_ns", lambda: ctime + 1_500_000_000)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2
    assert len(decode_memo._MEMO) == 0
    monkeypatch.setattr(decode_memo, "_now_ns", lambda: ctime + 2_500_000_000)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 3


def test_a_file_changed_during_the_decode_is_not_stored(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)
    inner = audio_audit.load_mono_full

    def racing(*args, **kwargs):  # type: ignore[no-untyped-def]
        out = inner(*args, **kwargs)
        path.write_bytes(b"w" * 300)
        _age(path, 100)
        return out

    TrackRmsCache.from_recording(path, sample_rate=RATE)  # an older generation is stored
    assert len(decode_memo._MEMO) == 1
    path.write_bytes(b"v" * 250)
    _age(path)
    monkeypatch.setattr(audio_audit, "load_mono_full", racing)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decode_memo._MEMO) == 0
    assert decode_memo._MEMO.held_bytes() == 0


def test_the_least_recently_used_entry_goes_first_when_the_cap_is_passed(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    # one entry is 8000 float32 = 32000 bytes; the cap holds two
    monkeypatch.setattr(decode_memo, "cap_bytes", lambda: 70_000)
    a, b, c = (_recording(tmp_path, f"{n}.wav") for n in "abc")
    for p in (a, b):
        TrackRmsCache.from_recording(p, sample_rate=RATE)
    TrackRmsCache.from_recording(a, sample_rate=RATE)  # refresh a
    TrackRmsCache.from_recording(c, sample_rate=RATE)  # evicts b
    assert decode_memo._MEMO.held_bytes() == 64_000
    before = len(decoder.calls)
    TrackRmsCache.from_recording(a, sample_rate=RATE)
    assert len(decoder.calls) == before
    TrackRmsCache.from_recording(b, sample_rate=RATE)
    assert len(decoder.calls) == before + 1


def test_an_entry_larger_than_the_cap_is_not_stored(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(decode_memo, "cap_bytes", lambda: 1000)
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert decode_memo._MEMO.held_bytes() == 0


def test_an_over_cap_rewrite_still_frees_the_older_generation(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decode_memo._MEMO) == 1
    path.write_bytes(b"n" * 150)
    _age(path)
    monkeypatch.setattr(decode_memo, "cap_bytes", lambda: 1000)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decode_memo._MEMO) == 0


def test_a_rewritten_file_frees_its_older_generation(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    path.write_bytes(b"n" * 150)
    _age(path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decode_memo._MEMO) == 1


def test_a_zero_cap_is_the_uncached_build(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_DECODE_MEMO_MB", "0")
    path = _recording(tmp_path)
    first = TrackRmsCache.from_recording(path, sample_rate=RATE)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2
    assert len(decode_memo._MEMO) == 0
    assert first.samples.flags.writeable
    plain = TrackRmsCache.from_timeline_stem(path, sample_rate=RATE)
    assert type(first) is type(plain) and first.sample_rate == plain.sample_rate


def test_concurrent_callers_of_one_key_decode_once(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    results: list[TrackRmsCache] = []

    def work() -> None:
        results.append(TrackRmsCache.from_recording(path, sample_rate=RATE))

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert len(results) == 8
    assert len(decoder.calls) == 1
    assert all(np.array_equal(r.samples, results[0].samples) for r in results)


def test_two_keys_decode_at_the_same_time(tmp_path: Path, decoder: Decoder) -> None:
    path = _recording(tmp_path)
    decoder.gate = threading.Barrier(2)  # both decodes must be in flight together
    jobs = [
        threading.Thread(
            target=TrackRmsCache.from_recording, args=(path,), kwargs={"sample_rate": r}
        )
        for r in (RATE, 16000)
    ]
    for t in jobs:
        t.start()
    for t in jobs:
        t.join(timeout=10)
    assert len(decoder.calls) == 2
    assert not decoder.gate.broken


def test_a_failed_decode_is_not_stored_and_the_next_call_retries(
    tmp_path: Path, decoder: Decoder
) -> None:
    path = _recording(tmp_path)
    decoder.fail = True
    with pytest.raises(RuntimeError):
        TrackRmsCache.from_recording(path, sample_rate=RATE)
    decoder.fail = False
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2  # the failed try and the retry
    assert len(decode_memo._MEMO) == 1


def test_waiters_after_a_failed_decode_retry_one_at_a_time(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    waiters = 6
    queued = threading.Event()

    class CountedFlight(decode_memo._Flight):
        """Sets ``queued`` once every caller holds or waits on the key's flight."""

        @property
        def users(self) -> int:
            return self._users

        @users.setter
        def users(self, value: int) -> None:
            self._users = value
            if value >= waiters:
                queued.set()

    monkeypatch.setattr(decode_memo, "_Flight", CountedFlight)
    path = _recording(tmp_path)
    decoder.fail_once = True  # the first decode fails, the retries succeed
    decoder.hold = threading.Event()
    outcomes: list[str] = []

    def work() -> None:
        try:
            TrackRmsCache.from_recording(path, sample_rate=RATE)
            outcomes.append("ok")
        except RuntimeError:
            outcomes.append("failed")

    threads = [threading.Thread(target=work) for _ in range(waiters)]
    for t in threads:
        t.start()
    assert queued.wait(timeout=10)  # one is decoding and the others are queued behind it
    decoder.hold.set()
    for t in threads:
        t.join(timeout=10)
    assert decoder.peak == 1
    assert sorted(outcomes) == ["failed"] + ["ok"] * (waiters - 1)
    assert len(decoder.calls) == 2  # the failure, then one retry whose result the rest hit
    assert len(decode_memo._MEMO) == 1
    assert not decode_memo._MEMO._building


def test_a_missing_file_raises_what_the_uncached_build_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(decode_memo, "ffmpeg_build_id", lambda: ("f",))
    missing = tmp_path / "gone.wav"
    with pytest.raises(Exception) as cached:
        TrackRmsCache.from_recording(missing, sample_rate=RATE)
    with pytest.raises(Exception) as plain:
        TrackRmsCache.from_timeline_stem(missing, sample_rate=RATE)
    assert type(cached.value) is type(plain.value)
    assert len(decode_memo._MEMO) == 0


def test_a_temp_render_through_from_timeline_stem_is_not_memoized(
    tmp_path: Path, decoder: Decoder
) -> None:
    path = _recording(tmp_path)
    TrackRmsCache.from_timeline_stem(path, sample_rate=RATE)
    TrackRmsCache.from_timeline_stem(path, sample_rate=RATE)
    assert len(decoder.calls) == 2
    assert len(decode_memo._MEMO) == 0


@pytest.mark.parametrize("env", decode_memo.VERIFY_ENVS)
def test_verify_rechecks_a_hit_and_a_poisoned_entry_raises(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch, env: str
) -> None:
    path = _recording(tmp_path)
    same = np.linspace(-0.5, 0.5, RATE, dtype=np.float32)
    monkeypatch.setattr(audio_audit, "load_mono_full", lambda *a, **k: same.copy())
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    monkeypatch.setenv(env, "1")
    TrackRmsCache.from_recording(path, sample_rate=RATE)  # equal: passes
    (entry,) = decode_memo._MEMO._entries.values()
    poisoned = entry.samples.copy()
    poisoned[7] += np.float32(1e-3)
    poisoned.flags.writeable = False
    entry.samples = poisoned
    with pytest.raises(AssertionError):
        TrackRmsCache.from_recording(path, sample_rate=RATE)


def test_verify_decodes_again_outside_the_batch_scope(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)
    scopes: list[bool] = []
    inner = audio_audit.load_mono_full

    def spy(*args, **kwargs):  # type: ignore[no-untyped-def]
        scopes.append(batch_scope._scope.get() is not None)
        return inner(*args, **kwargs)

    monkeypatch.setattr(audio_audit, "load_mono_full", spy)
    monkeypatch.setenv("PODCAST_VERDICT_VERIFY", "1")
    with batch_scope.batch_scope():
        TrackRmsCache.from_recording(path, sample_rate=RATE)
        assert scopes == [True]
        # the fake decoder is not deterministic, so the verify decode ends in AssertionError
        with pytest.raises(AssertionError):
            TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert scopes == [True, False]


def test_the_ffmpeg_build_is_part_of_the_key(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    monkeypatch.setattr(decode_memo, "ffmpeg_build_id", lambda: ("ffmpeg", (2,), (0, 0)))
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2


def test_a_stat_failure_falls_through_to_an_uncached_build(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)

    def broken(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise OSError("stat failed")

    monkeypatch.setattr(decode_memo, "file_stamp", broken)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2
    assert len(decode_memo._MEMO) == 0


def test_an_ffmpeg_id_failure_falls_through_to_an_uncached_build(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _recording(tmp_path)

    def broken() -> tuple[object, ...]:
        raise RuntimeError("no ffmpeg")

    monkeypatch.setattr(decode_memo, "ffmpeg_build_id", broken)
    result = TrackRmsCache.from_recording(path, sample_rate=RATE)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2
    assert len(decode_memo._MEMO) == 0
    assert _read_only(result)


@pytest.mark.parametrize("value", ["inf", "-inf", "nan", "1e400", "junk", ""])
def test_a_cap_that_is_not_a_finite_number_is_the_default(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("PODCAST_DECODE_MEMO_MB", value)
    assert decode_memo.cap_bytes() == decode_memo.DEFAULT_CAP_MB << 20
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 1


def test_a_second_decode_track_of_a_raw_file_does_not_decode_again(
    tmp_path: Path, decoder: Decoder
) -> None:
    path = _recording(tmp_path)
    first = decode_track(path)
    assert len(decoder.calls) == 2
    second = decode_track(path)
    assert len(decoder.calls) == 2
    assert np.array_equal(first.jump.samples, second.jump.samples)
    assert np.array_equal(first.waveform.samples, second.waveform.samples)
    assert second.jump is not first.jump


class Clock:
    """The idle clock, in seconds, moved by hand."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.now = 1000.0
        monkeypatch.setattr(decode_memo, "_monotonic", lambda: self.now)


def test_the_memo_is_released_after_it_sits_idle(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    TrackRmsCache.from_recording(_recording(tmp_path), sample_rate=RATE)
    memo = decode_memo._MEMO
    assert memo._timer is not None and memo._timer.daemon
    clock.now += decode_memo.DEFAULT_IDLE_S - 1
    memo._release_if_idle()
    assert len(memo) == 1 and memo._timer is not None
    clock.now += 1
    memo._release_if_idle()
    assert len(memo) == 0 and memo.held_bytes() == 0 and memo._timer is None


def test_no_release_while_a_decode_is_in_flight(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    TrackRmsCache.from_recording(_recording(tmp_path), sample_rate=RATE)
    memo = decode_memo._MEMO
    key = ("other", None, RATE, ())
    memo._building[key] = decode_memo._Flight()  # type: ignore[index]
    clock.now += 10 * decode_memo.DEFAULT_IDLE_S
    memo._release_if_idle()
    assert len(memo) == 1 and memo._timer is not None
    del memo._building[key]  # type: ignore[arg-type]
    memo._release_if_idle()
    assert len(memo) == 0


def test_activity_postpones_the_release(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    clock.now += 60
    TrackRmsCache.from_recording(path, sample_rate=RATE)  # a hit
    clock.now += 60
    decode_memo._MEMO._release_if_idle()
    assert len(decode_memo._MEMO) == 1
    assert len(decoder.calls) == 1
    clock.now += 30
    decode_memo._MEMO._release_if_idle()
    assert len(decode_memo._MEMO) == 0


@pytest.mark.parametrize("value", ["0", "-5"])
def test_an_idle_of_zero_or_less_never_arms_a_timer(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    clock = Clock(monkeypatch)
    monkeypatch.setenv(decode_memo.IDLE_ENV, value)
    TrackRmsCache.from_recording(_recording(tmp_path), sample_rate=RATE)
    assert decode_memo._MEMO._timer is None
    clock.now += 10**6
    decode_memo._MEMO._release_if_idle()
    assert len(decode_memo._MEMO) == 1


def test_clear_cancels_the_timer(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    Clock(monkeypatch)
    TrackRmsCache.from_recording(_recording(tmp_path), sample_rate=RATE)
    timer = decode_memo._MEMO._timer
    assert timer is not None
    decode_memo._MEMO.clear()
    assert decode_memo._MEMO._timer is None and timer.finished.is_set()


def test_an_empty_memo_arms_no_timer(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    Clock(monkeypatch)
    monkeypatch.setattr(decode_memo, "cap_bytes", lambda: 1000)
    TrackRmsCache.from_recording(_recording(tmp_path), sample_rate=RATE)  # over the cap
    assert len(decode_memo._MEMO) == 0 and decode_memo._MEMO._timer is None


@pytest.mark.parametrize("value", ["inf", "-inf", "nan", "1e400", "junk", ""])
def test_an_idle_that_is_not_a_finite_number_is_the_default(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv(decode_memo.IDLE_ENV, value)
    assert decode_memo.idle_seconds() == decode_memo.DEFAULT_IDLE_S


def test_a_hit_after_a_release_decodes_again_to_the_same_bits(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    monkeypatch.setattr(audio_audit, "load_mono_full", lambda *a, **k: _fixed(decoder, *a, **k))
    path = _recording(tmp_path)
    first = TrackRmsCache.from_recording(path, sample_rate=RATE)
    clock.now += decode_memo.DEFAULT_IDLE_S
    decode_memo._MEMO._release_if_idle()
    assert len(decode_memo._MEMO) == 0
    again = TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 2
    assert decode_memo._same_bits(again.samples, first.samples)
    assert len(decode_memo._MEMO) == 1 and decode_memo._MEMO._timer is not None


def test_a_store_postpones_the_release(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    TrackRmsCache.from_recording(_recording(tmp_path, "a.wav"), sample_rate=RATE)
    clock.now += 60
    TrackRmsCache.from_recording(_recording(tmp_path, "b.wav"), sample_rate=RATE)  # a store
    clock.now += 60
    decode_memo._MEMO._release_if_idle()
    assert len(decode_memo._MEMO) == 2
    clock.now += 30
    decode_memo._MEMO._release_if_idle()
    assert len(decode_memo._MEMO) == 0


def test_a_stale_timer_fire_does_nothing_and_leaves_one_timer_chain(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    memo = decode_memo._MEMO
    TrackRmsCache.from_recording(_recording(tmp_path, "a.wav"), sample_rate=RATE)
    stale = memo._timer
    assert stale is not None
    memo.clear()
    TrackRmsCache.from_recording(_recording(tmp_path, "b.wav"), sample_rate=RATE)
    current = memo._timer
    assert current is not None and current is not stale
    clock.now += 10
    stale.function()
    assert memo._timer is current and len(memo) == 1
    monkeypatch.setattr(decode_memo.threading, "current_thread", lambda: current)
    current.function()
    assert memo._timer is not None and memo._timer is not current and len(memo) == 1
    memo.clear()
    assert memo._timer is None


@pytest.mark.parametrize("value", ["1e300", "1e9"])
def test_a_huge_idle_is_a_day_and_arms_a_timer_that_can_run(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    Clock(monkeypatch)
    monkeypatch.setenv(decode_memo.IDLE_ENV, value)
    assert decode_memo.idle_seconds() == decode_memo.MAX_IDLE_S <= threading.TIMEOUT_MAX
    TrackRmsCache.from_recording(_recording(tmp_path), sample_rate=RATE)
    timer = decode_memo._MEMO._timer
    assert timer is not None and timer.interval == decode_memo.MAX_IDLE_S and timer.is_alive()


def test_a_timer_that_cannot_start_leaves_hits_and_stores_working(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    Clock(monkeypatch)

    def refuse(self: threading.Timer) -> None:
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading.Timer, "start", refuse)
    path = _recording(tmp_path)
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decode_memo._MEMO) == 1 and decode_memo._MEMO._timer is None
    TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert len(decoder.calls) == 1 and decode_memo._MEMO._timer is None


def _content_decode(
    monkeypatch: pytest.MonkeyPatch, link: Path, to: Path, back: Path, *, flip: bool
) -> None:
    def decode(path: Path, *, sample_rate: int = RATE, ffmpeg: str | None = None) -> np.ndarray:
        if flip:
            link.unlink()
            link.symlink_to(to)
        out = np.full(sample_rate, path.read_bytes()[0], dtype=np.float32)
        if flip:
            link.unlink()
            link.symlink_to(back)
        return out

    monkeypatch.setattr(audio_audit, "load_mono_full", decode)


def test_a_link_flipped_to_b_and_back_inside_the_build_stores_a(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _recording(tmp_path, "a.wav", b"A" * 100)
    second = _recording(tmp_path, "b.wav", b"B" * 100)
    link = tmp_path / "link.wav"
    link.symlink_to(first)
    _content_decode(monkeypatch, link, second, first, flip=True)
    cache = TrackRmsCache.from_recording(link, sample_rate=RATE)
    assert cache.samples[0] == ord("A")
    again = TrackRmsCache.from_recording(link, sample_rate=RATE)
    assert again.samples[0] == ord("A")
    assert len(decode_memo._MEMO) == 1


def test_verify_on_a_hit_decodes_the_resolved_file(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _recording(tmp_path, "a.wav", b"A" * 100)
    second = _recording(tmp_path, "b.wav", b"B" * 100)
    link = tmp_path / "link.wav"
    link.symlink_to(first)
    _content_decode(monkeypatch, link, second, first, flip=False)
    TrackRmsCache.from_recording(link, sample_rate=RATE)
    monkeypatch.setenv("PODCAST_VERDICT_VERIFY", "1")
    _content_decode(monkeypatch, link, second, first, flip=True)
    hit = TrackRmsCache.from_recording(link, sample_rate=RATE)
    assert hit.samples[0] == ord("A")


def test_a_symlink_retargeted_during_the_decode_stores_the_file_it_decoded(
    tmp_path: Path, decoder: Decoder, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _recording(tmp_path, "one.wav", b"x" * 100)
    second = _recording(tmp_path, "two.wav", b"y" * 100)
    link = tmp_path / "link.wav"
    link.symlink_to(first)
    seen: list[Path] = []

    def retargeting(
        path: Path, *, sample_rate: int = RATE, ffmpeg: str | None = None
    ) -> np.ndarray:
        seen.append(path)
        out = np.full(sample_rate, path.read_bytes()[0], dtype=np.float32)
        link.unlink()
        link.symlink_to(second)
        return out

    monkeypatch.setattr(audio_audit, "load_mono_full", retargeting)
    cache = TrackRmsCache.from_recording(link, sample_rate=RATE)
    assert cache.samples[0] == ord("x")
    assert _read_only(cache)
    assert len(decode_memo._MEMO) == 1
    assert seen == [first.resolve()]


def _boom() -> tuple[object, ...]:
    raise OSError("no ffmpeg")


@pytest.mark.parametrize(
    ("branch", "expect_resolved", "writable"),
    [("cap0", False, True), ("racy", True, False), ("exception", False, False)],
)
def test_uncached_branches_decode_the_given_path_and_racy_decodes_the_resolved_one(
    tmp_path: Path,
    decoder: Decoder,
    monkeypatch: pytest.MonkeyPatch,
    branch: str,
    expect_resolved: bool,
    writable: bool,
) -> None:
    target = _recording(tmp_path, "a.wav")
    link = tmp_path / "link.wav"
    link.symlink_to(target)
    if branch == "cap0":
        monkeypatch.setenv(decode_memo.CAP_ENV, "0")
    elif branch == "racy":
        monkeypatch.setattr(decode_memo, "_now_ns", time.time_ns)
    else:
        monkeypatch.setattr(decode_memo, "ffmpeg_build_id", _boom)
    cache = TrackRmsCache.from_recording(link, sample_rate=RATE)
    assert decoder.calls[0][0] == (link.resolve() if expect_resolved else link)
    assert cache.samples.flags.writeable is writable
    assert len(decode_memo._MEMO) == 0


def _fixed(decoder: Decoder, path: Path, *, sample_rate: int = 8000, ffmpeg: str | None = None):  # type: ignore[no-untyped-def]
    """Counts the call like ``Decoder`` but returns the same samples every time."""
    decoder.calls.append((path, sample_rate))
    return np.linspace(-0.5, 0.5, sample_rate, dtype=np.float32)
