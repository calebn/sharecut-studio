"""Track evidence recorded under the project's artifacts, so a fresh process reads it instead of rebuilding it (#2359)."""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import shutil
import sys
import threading
import time
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import evidence_records, track_evidence
from podcast_mcp.engines.audio import Audio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.track_evidence import Declined, Evidence
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.clip_timing import ClipTiming
from podcast_mcp.util.fingerprint import FileStamp
from test_audio_eval import _ffmpeg_or_skip, _project

JUMP, WAVEFORM = 8000, 16000
RETAINED = track_evidence._RETAINED
real_evaluate = track_evidence._evaluate


@pytest.fixture(autouse=True)
def _setup(monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    # Fixtures written a moment ago are racy for a record; read the clock an hour on.
    monkeypatch.setattr(track_evidence, "_now_ns", lambda: time.time_ns() + 3600 * 10**9)
    # The sandbox's free space is a fact about the machine, not about the record.
    monkeypatch.setattr(evidence_records, "SPILL_HEADROOM_BYTES", 0)
    RETAINED.clear()


class Evaluations:
    """Counts the evaluations the store asks for."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.rates: list[tuple[int, ...]] = []

        def counted(
            tree: Audio, curve: str, rates: tuple[int, ...] = (JUMP, WAVEFORM)
        ) -> Evidence | Declined:
            self.rates.append(tuple(rates))
            return real_evaluate(tree, curve, rates)

        monkeypatch.setattr(track_evidence, "_evaluate", counted)

    @property
    def count(self) -> int:
        return len(self.rates)


def _clear_retained() -> None:
    RETAINED.clear()


def _records(project: EpisodeProject) -> list[Path]:
    return sorted((project.artifacts_dir() / evidence_records.RECORD_DIR).glob("*.evd"))


def _samples(project: EpisodeProject) -> np.ndarray:
    return track_evidence.rms(project, "caleb", load_defaults()).samples


def _bits(array: np.ndarray) -> np.ndarray:
    return array.view(np.uint32)


def _fresh(project: EpisodeProject) -> np.ndarray:
    plain = track_evidence._plan(project, "caleb", load_defaults())
    assert not isinstance(plain, Declined)
    evidence = real_evaluate(plain[1], plain[0].curve, track_evidence._rates(plain[1]))
    assert not isinstance(evidence, Declined)
    return evidence[JUMP]


def test_clearing_retained_evidence_reads_the_record_with_the_same_bits_and_evaluates_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    calls = Evaluations(monkeypatch)
    built = _samples(project)
    assert calls.count == 1 and len(_records(project)) == 1
    _clear_retained()

    read = _samples(project)

    assert calls.count == 1
    assert read.dtype == np.float32 and read.shape == built.shape
    np.testing.assert_array_equal(_bits(read), _bits(built))
    np.testing.assert_array_equal(_bits(read), _bits(_fresh(project)))


def test_both_rates_are_recorded_and_read_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    calls = Evaluations(monkeypatch)
    built = track_evidence.heard(project, "caleb", load_defaults())
    _clear_retained()

    read = track_evidence.heard(project, "caleb", load_defaults())

    assert calls.count == 1
    np.testing.assert_array_equal(_bits(read.jump.samples), _bits(built.jump.samples))
    np.testing.assert_array_equal(_bits(read.waveform.samples), _bits(built.waveform.samples))


def test_the_project_file_is_not_touched(tmp_path: Path) -> None:
    project = _project(tmp_path, "crossfade joins")
    project_file = project.workspace_path() / "episode.sharecut"
    before = (project_file.read_bytes(), project_file.stat().st_mtime_ns)

    _samples(project)

    assert (project_file.read_bytes(), project_file.stat().st_mtime_ns) == before
    assert [p.parent.name for p in _records(project)] == [evidence_records.RECORD_DIR]


def _damage_garbage(path: Path) -> None:
    path.write_bytes(b"\x00garbage" * 40)


def _damage_empty(path: Path) -> None:
    path.write_bytes(b"")


def _damage_truncated(path: Path) -> None:
    path.write_bytes(path.read_bytes()[:-4])


def _damage_extended(path: Path) -> None:
    path.write_bytes(path.read_bytes() + b"\x00\x00\x00\x00")


def _damage_half(path: Path) -> None:
    data = path.read_bytes()
    path.write_bytes(data[: len(data) // 2])


def _rewrite_header(path: Path, header: bytes) -> None:
    data = path.read_bytes()
    body = data[data.index(b"\n") + 1 :]
    path.write_bytes(data[: len(evidence_records._MAGIC)] + header + b"\n" + body)


@pytest.mark.parametrize(
    "header",
    [
        b"null",
        b"[]",
        b'"text"',
        b"12",
        b"{}",
        b'{"key": "x", "rates": [8000], "sizes": [1]}',
        b'{"rates": [8000], "sizes": [1]}',
        b"[" * 4000 + b"]" * 4000,
        b"{not json",
    ],
    ids=["null", "list", "text", "number", "empty-object", "other-key", "no-key", "deep", "broken"],
)
def test_a_record_whose_header_is_not_the_records_is_evaluated_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, header: bytes
) -> None:
    project = _project(tmp_path, "crossfade joins")
    built = _samples(project)
    (record,) = _records(project)
    _clear_retained()
    _rewrite_header(record, header)
    calls = Evaluations(monkeypatch)

    read = _samples(project)

    assert calls.count == 1
    np.testing.assert_array_equal(_bits(read), _bits(built))
    _clear_retained()
    assert _samples(project).shape == built.shape and calls.count == 1


@pytest.mark.parametrize(
    "damage",
    [_damage_garbage, _damage_empty, _damage_truncated, _damage_extended, _damage_half],
    ids=lambda f: f.__name__.removeprefix("_damage_"),
)
def test_a_damaged_record_is_evaluated_again_and_replaced_whole(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage: Callable[[Path], None]
) -> None:
    project = _project(tmp_path, "crossfade joins")
    built = _samples(project)
    (record,) = _records(project)
    whole = record.read_bytes()
    _clear_retained()
    damage(record)
    calls = Evaluations(monkeypatch)

    read = _samples(project)

    assert calls.count == 1
    np.testing.assert_array_equal(_bits(read), _bits(built))
    assert record.read_bytes() == whole
    _clear_retained()
    _samples(project)
    assert calls.count == 1


def test_a_record_copied_to_another_key_s_name_is_not_read(tmp_path: Path) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    (record,) = _records(project)
    other = evidence_records.record_key(("another tree",))
    assert other is not None
    evidence_records.record_path(record.parent, other).write_bytes(record.read_bytes())

    assert evidence_records.read_record(record.parent, other, (JUMP,)) is None


def test_a_record_read_at_other_rates_is_not_a_record(tmp_path: Path) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    (record,) = _records(project)
    key = _full_key(record)

    assert evidence_records.read_record(record.parent, key, (JUMP,)) is not None
    assert evidence_records.read_record(record.parent, key, (JUMP, WAVEFORM)) is None
    assert evidence_records.read_record(record.parent, key, (WAVEFORM,)) is None
    assert evidence_records.read_record(record.parent, key[::-1], (JUMP,)) is None


def _full_key(record: Path) -> str:
    data = record.read_bytes()
    line = data[len(evidence_records._MAGIC) : data.index(b"\n")]
    return str(json.loads(line)["key"])


def test_a_source_that_changed_gets_a_new_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    source = project.workspace_path() / "raw" / "caleb.flac"
    _clear_retained()
    calls = Evaluations(monkeypatch)

    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
    _samples(project)

    assert calls.count == 1 and len(_records(project)) == 2


def test_a_changed_track_gets_a_new_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = _project(tmp_path, "crossfade joins")
    before = _samples(project)
    _clear_retained()
    calls = Evaluations(monkeypatch)
    clip = next(c for c in project.clips if c.track_id == "caleb")
    clip.source_end -= 0.5

    changed = _samples(project)

    assert calls.count == 1 and len(_records(project)) == 2
    assert changed.shape != before.shape or not np.array_equal(changed, before)


def test_a_code_revision_bump_makes_the_old_record_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    _clear_retained()
    calls = Evaluations(monkeypatch)
    monkeypatch.setattr(evidence_records, "RECORD_REV", evidence_records.RECORD_REV + 1)

    _samples(project)

    assert calls.count == 1 and len(_records(project)) == 2


def test_a_timing_map_change_gets_a_new_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    before = _samples(project)
    _clear_retained()
    calls = Evaluations(monkeypatch)
    clip = next(c for c in project.clips if c.track_id == "caleb")
    clip.timing = ClipTiming.model_validate(
        {"steps": [{"at": (clip.source_start + clip.source_end) / 2, "delta_sec": 0.1}]}
    )

    changed = _samples(project)

    assert calls.count == 1 and len(_records(project)) == 2
    assert changed.shape != before.shape or not np.array_equal(changed, before)
    np.testing.assert_array_equal(_bits(changed), _bits(_fresh(project)))


def test_another_ffmpeg_build_makes_the_old_record_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    _clear_retained()
    calls = Evaluations(monkeypatch)
    real = track_evidence._build_id()
    assert real is not None
    monkeypatch.setattr(track_evidence, "_build_id", lambda: (*real, "another build"))

    _samples(project)

    assert calls.count == 1 and len(_records(project)) == 2


def test_a_source_too_recent_to_trust_is_not_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    monkeypatch.setattr(track_evidence, "_now_ns", time.time_ns)
    source = project.workspace_path() / "raw" / "caleb.flac"
    os.utime(source)

    _samples(project)

    assert _records(project) == []


def test_a_source_rewritten_during_the_build_is_not_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    source = project.workspace_path() / "raw" / "caleb.flac"

    def rewritten(
        tree: Audio, curve: str, rates: tuple[int, ...] = (JUMP, WAVEFORM)
    ) -> Evidence | Declined:
        evidence = real_evaluate(tree, curve, rates)
        stat = source.stat()
        os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
        return evidence

    monkeypatch.setattr(track_evidence, "_evaluate", rewritten)

    _samples(project)

    assert _records(project) == []


def test_a_zero_keep_cap_writes_and_reads_no_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    monkeypatch.setenv(track_evidence.KEEP_ENV, "0")
    calls = Evaluations(monkeypatch)

    _samples(project)
    _clear_retained()
    _samples(project)

    assert _records(project) == [] and calls.count == 2


def test_verify_mode_compares_a_record_with_a_fresh_evaluation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    (record,) = _records(project)
    _clear_retained()
    monkeypatch.setenv(track_evidence.VERIFY_ENV, "1")
    _samples(project)
    _clear_retained()
    wrong = evidence_records.read_record(record.parent, _full_key(record), (JUMP,))
    assert wrong is not None
    wrong[JUMP][0] += 1.0
    assert evidence_records.write_record(record.parent, _full_key(record), wrong)

    with pytest.raises(AssertionError, match="differs from a rebuild"):
        _samples(project)


def test_the_newest_records_are_kept(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(evidence_records, "RECORDS_KEPT", 3)
    directory = tmp_path / "records"
    evidence: Evidence = {JUMP: np.arange(16, dtype=np.float32)}
    keys = [evidence_records.record_key(("tree", n)) for n in range(6)]
    for age, key in enumerate(keys):
        assert key is not None
        assert evidence_records.write_record(directory, key, evidence)
        os.utime(evidence_records.record_path(directory, key), ns=(10**9 * age, 10**9 * age))

    last = evidence_records.record_key(("tree", 6))
    assert last is not None
    evidence_records.write_record(directory, last, evidence)

    kept = {p.name for p in directory.glob("*.evd")}
    assert kept == {evidence_records.record_path(directory, k).name for k in (*keys[4:], last)}
    assert evidence_records.read_record(directory, last, (JUMP,)) is not None


def test_records_past_the_byte_cap_go_oldest_first_but_never_the_one_just_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(evidence_records, "RECORDS_KEPT_BYTES", 150)
    directory = tmp_path / "records"
    evidence: Evidence = {JUMP: np.arange(16, dtype=np.float32)}
    keys = [evidence_records.record_key(("tree", n)) for n in range(3)]
    for age, key in enumerate(keys):
        assert key is not None
        evidence_records.write_record(directory, key, evidence)
        path = evidence_records.record_path(directory, key)
        os.utime(path, ns=(10**9 * (age + 1), 10**9 * (age + 1)))
    newest = keys[2]
    assert newest is not None

    kept = list(directory.glob("*.evd"))

    assert [p.name for p in kept] == [evidence_records.record_path(directory, newest).name]


def test_a_key_that_prints_a_memory_address_names_no_record() -> None:
    assert evidence_records.record_key((object(),)) is None
    assert evidence_records.record_key(("a", 1)) == evidence_records.record_key(("a", 1))
    assert evidence_records.record_key(("a", 1)) != evidence_records.record_key(("a", 2))


def test_evidence_that_is_not_float32_is_not_recorded(tmp_path: Path) -> None:
    key = evidence_records.record_key(("x",))
    assert key is not None
    assert not evidence_records.write_record(tmp_path, key, {JUMP: np.zeros(4, dtype=np.float64)})
    assert not evidence_records.write_record(tmp_path, key, {JUMP: np.zeros(0, dtype=np.float32)})
    assert list(tmp_path.glob("*.evd")) == []


def test_a_body_corrupted_to_the_same_length_is_evaluated_again_and_restored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    built = _samples(project)
    (record,) = _records(project)
    whole = record.read_bytes()
    _clear_retained()
    data = bytearray(whole)
    data[-8] ^= 0x40
    record.write_bytes(bytes(data))
    assert len(data) == len(whole)
    calls = Evaluations(monkeypatch)

    read = _samples(project)

    assert calls.count == 1
    np.testing.assert_array_equal(_bits(read), _bits(built))
    assert record.read_bytes() == whole


def test_a_record_without_its_checksum_is_not_read(tmp_path: Path) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    (record,) = _records(project)
    key = _full_key(record)
    data = record.read_bytes()
    head = data[len(evidence_records._MAGIC) : data.index(b"\n")]
    stripped = {k: v for k, v in json.loads(head).items() if k != "sum"}
    body = data[data.index(b"\n") + 1 :]
    record.write_bytes(evidence_records._MAGIC + json.dumps(stripped).encode() + b"\n" + body)

    assert evidence_records.read_record(record.parent, key, (JUMP,)) is None


def test_the_full_stamp_of_the_ffmpeg_binary_is_in_the_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    binary = tmp_path / "fake-ffmpeg"
    binary.write_bytes(b"one")
    os.utime(binary, ns=(10**9, 10**9))
    real = track_evidence._build_id()
    assert real is not None
    monkeypatch.setattr(track_evidence, "_build_id", lambda: (str(binary), *real[1:]))
    _samples(project)
    _clear_retained()
    # Same size and mtime, so only the change time tells the rewrite.
    binary.write_bytes(b"two")
    os.utime(binary, ns=(10**9, 10**9))
    calls = Evaluations(monkeypatch)

    _samples(project)

    assert calls.count == 1 and len(_records(project)) == 2


def test_no_record_is_written_when_the_disk_would_be_left_under_the_headroom(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    monkeypatch.setattr(evidence_records, "SPILL_HEADROOM_BYTES", 1 << 60)
    calls = Evaluations(monkeypatch)

    _samples(project)
    _clear_retained()
    _samples(project)

    assert _records(project) == [] and calls.count == 2


def test_a_record_that_fits_with_the_headroom_is_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    free = shutil.disk_usage(tmp_path).free
    monkeypatch.setattr(evidence_records, "SPILL_HEADROOM_BYTES", max(0, free - 1_000_000))
    key = evidence_records.record_key(("x",))
    assert key is not None

    assert evidence_records.write_record(tmp_path / "r", key, {JUMP: np.ones(16, np.float32)})


def test_a_record_that_vanishes_while_pruning_is_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = tmp_path / "records"
    evidence: Evidence = {JUMP: np.arange(16, dtype=np.float32)}
    keys = [evidence_records.record_key(("tree", n)) for n in range(3)]
    for age, key in enumerate(keys):
        assert key is not None
        evidence_records.write_record(directory, key, evidence)
        os.utime(evidence_records.record_path(directory, key), ns=(10**9 * (age + 1),) * 2)
    assert keys[0] is not None and keys[2] is not None
    gone = evidence_records.record_path(directory, keys[0])
    real_stamp = evidence_records.file_stamp

    def stamp(path: Path | os.stat_result) -> FileStamp:
        if path == gone:
            raise FileNotFoundError(path)
        return real_stamp(path)

    monkeypatch.setattr(evidence_records, "file_stamp", stamp)
    newest = evidence_records.record_path(directory, keys[2])

    monkeypatch.setattr(evidence_records, "RECORDS_KEPT", 1)
    evidence_records._prune(directory, keep=newest)

    assert sorted(p.name for p in directory.glob("*.evd")) == sorted([gone.name, newest.name])


def test_stale_temporary_files_of_an_interrupted_write_are_removed_and_fresh_ones_kept(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "records"
    directory.mkdir()
    old = directory / ".abc.evd.0123.tmp"
    fresh = directory / ".def.evd.4567.tmp"
    other = directory / ".notes.txt"
    for path in (old, fresh, other):
        path.write_bytes(b"x")
    long_ago = time.time_ns() - 3600 * 10**9
    os.utime(old, ns=(long_ago, long_ago))
    os.utime(other, ns=(long_ago, long_ago))
    key = evidence_records.record_key(("x",))
    assert key is not None

    assert evidence_records.write_record(directory, key, {JUMP: np.ones(16, np.float32)})

    assert not old.exists() and fresh.exists() and other.exists()


def test_a_record_that_is_read_is_the_newest_and_outlives_an_unread_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(evidence_records, "RECORDS_KEPT", 2)
    directory = tmp_path / "records"
    evidence: Evidence = {JUMP: np.arange(16, dtype=np.float32)}
    keys = [evidence_records.record_key(("tree", n)) for n in range(3)]
    for age, key in enumerate(keys[:2]):
        assert key is not None
        evidence_records.write_record(directory, key, evidence)
        os.utime(evidence_records.record_path(directory, key), ns=(10**9 * (age + 1),) * 2)
    assert keys[0] is not None and keys[2] is not None

    assert evidence_records.read_record(directory, keys[0], (JUMP,)) is not None
    evidence_records.write_record(directory, keys[2], evidence)

    kept = {p.name for p in directory.glob("*.evd")}
    assert kept == {evidence_records.record_path(directory, k).name for k in (keys[0], keys[2])}


# Bump evidence_records.RECORD_REV and this pin together whenever the code that decides what the
# evidence is changes: a record of the old code is otherwise read as if it were the new code's.
EVIDENCE_CODE_PIN = "a6568df97d554b03"


def _normalised(text: str) -> str:
    return "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").split("\n"))


# Every module whose code decides a sample value: the source decode and its channel mix
# (decoded_source, mono_downmix, media_probe, media_seek), the probe and the resample arguments
# (ffmpeg, all of it: the probe, the layout helpers and the resampler live there), the tree
# evaluator (audio, audio_eval), the resampler grid and windowed reads (ungated_audio,
# windowed_rms) and the evidence module itself.
EVIDENCE_MODULES = (
    "audio.py",
    "audio_eval.py",
    "decoded_source.py",
    "ffmpeg.py",
    "media_probe.py",
    "media_seek.py",
    "mono_downmix.py",
    "track_evidence.py",
    "ungated_audio.py",
    "windowed_rms.py",
)
# Modules a build runs that decide the tree, which is part of the key, or are the record itself.
TREE_AND_CONFIG_MODULES = (
    "clips_ops.py",
    "evidence_records.py",
    "gate_fill.py",
    "models/whisper.py",
    "mute_regions.py",
    "timeline_render.py",
    "timed_pieces.py",
)


def _evidence_code_digest(edited: dict[str, str] | None = None) -> str:
    """The digest of the evidence code; ``edited`` maps a module name to text appended to it (a stand-in for an edit)."""
    root = Path(track_evidence.__file__).resolve().parent
    parts = []
    for name in EVIDENCE_MODULES:
        text = (root / name).read_text(encoding="utf-8")
        parts.append((name, _normalised(text + (edited or {}).get(name, ""))))
    return hashlib.sha256(repr(parts).encode()).hexdigest()[:16]


@pytest.mark.parametrize("name", EVIDENCE_MODULES)
def test_an_edit_to_any_module_the_evidence_reads_changes_the_pin_digest(name: str) -> None:
    assert _evidence_code_digest({name: "\n# edited\n"}) != _evidence_code_digest()


def test_the_downmix_weight_is_part_of_the_pin() -> None:
    root = Path(track_evidence.__file__).resolve().parent
    assert "weight = 1.0 / channels" in (root / "mono_downmix.py").read_text(encoding="utf-8")
    assert "mono_downmix.py" in EVIDENCE_MODULES


def test_every_engine_module_a_build_runs_is_pinned_or_named_as_part_of_the_key(
    tmp_path: Path,
) -> None:
    """Follows the real call graph of a build, so a helper reached through another module is seen."""
    root = Path(track_evidence.__file__).resolve().parent
    ran: set[str] = set()

    def profile(frame: types.FrameType, event: str, arg: object) -> None:
        if event == "call":
            filename = frame.f_code.co_filename
            if filename.startswith(str(root) + os.sep):
                ran.add(filename[len(str(root)) + 1 :])

    project = _project(tmp_path, "mixed joins and pads", mono_rate=None)
    sys.setprofile(profile)
    threading.setprofile(profile)
    try:
        track_evidence._entry(project, "caleb", load_defaults(), locked=False)
    finally:
        sys.setprofile(None)
        threading.setprofile(None)

    assert {"audio_eval.py", "decoded_source.py", "ffmpeg.py", "mono_downmix.py"} <= ran
    assert ran - set(EVIDENCE_MODULES) - set(TREE_AND_CONFIG_MODULES) == set()


def test_a_change_to_the_probe_moves_the_pin_digest() -> None:
    assert "def probe(" in inspect.getsource(FFmpegEngine)
    assert _evidence_code_digest({"ffmpeg.py": "\n# probe forced to one channel\n"}) != (
        _evidence_code_digest()
    )


def test_the_code_that_decides_the_evidence_is_pinned_to_the_record_revision() -> None:
    assert _evidence_code_digest() == EVIDENCE_CODE_PIN, (
        "The code behind track evidence changed (EVIDENCE_MODULES). "
        "If it can change the samples an "
        "unchanged key evaluates to, bump evidence_records.RECORD_REV so recorded evidence is "
        "evaluated again; then set EVIDENCE_CODE_PIN in tests/test_evidence_records.py to "
        f"{_evidence_code_digest()!r}."
    )


def test_a_header_split_differently_over_the_same_bytes_is_not_read(tmp_path: Path) -> None:
    key = evidence_records.record_key(("split",))
    assert key is not None
    evidence: Evidence = {JUMP: np.arange(16, dtype=np.float32), WAVEFORM: np.ones(8, np.float32)}
    assert evidence_records.write_record(tmp_path, key, evidence)
    assert evidence_records.read_record(tmp_path, key, (JUMP, WAVEFORM)) is not None
    record = evidence_records.record_path(tmp_path, key)
    data = record.read_bytes()
    head = json.loads(data[len(evidence_records._MAGIC) : data.index(b"\n")])
    head["sizes"] = [15, 9]
    body = data[data.index(b"\n") + 1 :]
    record.write_bytes(evidence_records._MAGIC + json.dumps(head).encode() + b"\n" + body)

    assert evidence_records.read_record(tmp_path, key, (JUMP, WAVEFORM)) is None


def test_an_ffmpeg_binary_that_vanishes_does_not_fail_the_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    real = track_evidence._build_id()
    assert real is not None
    monkeypatch.setattr(
        track_evidence, "_build_id", lambda: (str(tmp_path / "gone-ffmpeg"), *real[1:])
    )
    calls = Evaluations(monkeypatch)

    built = _samples(project)

    assert calls.count == 1 and _records(project) == []
    np.testing.assert_array_equal(_bits(built), _bits(_fresh(project)))


def test_a_record_that_cannot_be_written_does_not_fail_the_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")

    def refuse(*args: object, **kwargs: object) -> bool:
        raise PermissionError("read-only")

    monkeypatch.setattr(evidence_records, "write_record", refuse)

    built = _samples(project)

    np.testing.assert_array_equal(_bits(built), _bits(_fresh(project)))


def test_a_declined_build_is_returned_and_recorded_nowhere(tmp_path: Path) -> None:
    project = _project(tmp_path, "crossfade joins")
    plan = track_evidence._plan(project, "caleb", load_defaults())
    assert not isinstance(plan, Declined)
    key, tree = plan
    directory = tmp_path / "records"

    got = track_evidence._recorded(directory, key, tree, (JUMP,), lambda: Declined.EVALUATOR)

    assert got is Declined.EVALUATOR
    assert not directory.exists() or list(directory.iterdir()) == []


def test_write_record_refuses_what_is_not_evidence(tmp_path: Path) -> None:
    key = evidence_records.record_key(("x",))
    assert key is not None

    not_evidence: Any = Declined.EMPTY

    assert not evidence_records.write_record(tmp_path, key, not_evidence)
    assert list(tmp_path.iterdir()) == []


def test_a_record_with_another_magic_is_not_read_though_its_header_and_checksum_are_valid(
    tmp_path: Path,
) -> None:
    key = evidence_records.record_key(("magic",))
    assert key is not None
    assert evidence_records.write_record(tmp_path, key, {JUMP: np.arange(16, dtype=np.float32)})
    record = evidence_records.record_path(tmp_path, key)
    data = record.read_bytes()
    assert evidence_records.read_record(tmp_path, key, (JUMP,)) is not None
    record.write_bytes(b"OTHER1 " + data[len(evidence_records._MAGIC) :])

    assert evidence_records.read_record(tmp_path, key, (JUMP,)) is None


def test_a_record_whose_header_names_other_rates_is_not_read_though_its_checksum_fits(
    tmp_path: Path,
) -> None:
    key = evidence_records.record_key(("rates",))
    assert key is not None
    evidence: Evidence = {JUMP: np.arange(16, dtype=np.float32), WAVEFORM: np.ones(8, np.float32)}
    assert evidence_records.write_record(tmp_path, key, evidence)
    record = evidence_records.record_path(tmp_path, key)
    data = record.read_bytes()
    head = json.loads(data[len(evidence_records._MAGIC) : data.index(b"\n")])
    head["rates"] = [JUMP, 24000]
    body = data[data.index(b"\n") + 1 :]
    record.write_bytes(evidence_records._MAGIC + json.dumps(head).encode() + b"\n" + body)

    assert evidence_records.read_record(tmp_path, key, (JUMP, WAVEFORM)) is None
