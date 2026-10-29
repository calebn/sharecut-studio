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
        self.delay = 0.0
        self.active = 0
        self.peak = 0

    def __call__(self, path: Path, *, sample_rate: int = 8000, ffmpeg: str | None = None):  # type: ignore[no-untyped-def]
        with self.lock:
            self.calls.append((path, sample_rate))
            seed = len(self.calls)
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            time.sleep(self.delay)
            if self.fail:
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
    time.sleep(0.01)
    path.write_bytes(b"q" * 100)
    os.utime(path, ns=(stamp, stamp))
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
    tmp_path: Path, decoder: Decoder
) -> None:
    path = _recording(tmp_path)
    decoder.fail = True
    decoder.delay = 0.1
    outcomes: list[str] = []

    def work(late: float) -> None:
        time.sleep(late)
        try:
            TrackRmsCache.from_recording(path, sample_rate=RATE)
            outcomes.append("ok")
        except RuntimeError:
            outcomes.append("failed")

    def heal() -> None:
        time.sleep(0.15)  # the first decode has failed, the waiters are queued
        decoder.fail = False

    threads = [threading.Thread(target=work, args=(0.02 * n,)) for n in range(6)]
    threads.append(threading.Thread(target=heal))
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert decoder.peak == 1
    assert outcomes.count("ok") >= 4
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
