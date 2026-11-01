"""Track evidence recorded under the project's artifacts, so a fresh process reads it instead of rebuilding it (#2359)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import evidence_records, track_evidence
from podcast_mcp.engines.track_evidence import Declined, Evidence
from podcast_mcp.models import EpisodeProject
from test_audio_eval import _ffmpeg_or_skip, _project

JUMP, WAVEFORM = 8000, 16000
RETAINED = track_evidence._RETAINED
real_evaluate = track_evidence._evaluate


@pytest.fixture(autouse=True)
def _setup(monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    # Fixtures written a moment ago are racy for a record; read the clock an hour on.
    monkeypatch.setattr(track_evidence, "_now_ns", lambda: time.time_ns() + 3600 * 10**9)
    RETAINED.clear()


class Evaluations:
    """Counts the evaluations the store asks for."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.rates: list[tuple[int, ...]] = []

        def counted(tree, curve, rates=(JUMP, WAVEFORM)):  # type: ignore[no-untyped-def]
            self.rates.append(tuple(rates))
            return real_evaluate(tree, curve, rates)

        monkeypatch.setattr(track_evidence, "_evaluate", counted)

    @property
    def count(self) -> int:
        return len(self.rates)


def _restart() -> None:
    """What a new process lacks: the evidence this one kept."""
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


def test_a_fresh_process_reads_the_recorded_evidence_with_the_same_bits_and_evaluates_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    calls = Evaluations(monkeypatch)
    built = _samples(project)
    assert calls.count == 1 and len(_records(project)) == 1
    _restart()

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
    _restart()

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
    _restart()
    _rewrite_header(record, header)
    calls = Evaluations(monkeypatch)

    read = _samples(project)

    assert calls.count == 1
    np.testing.assert_array_equal(_bits(read), _bits(built))
    _restart()
    assert _samples(project).shape == built.shape and calls.count == 1


@pytest.mark.parametrize(
    "damage",
    [_damage_garbage, _damage_empty, _damage_truncated, _damage_extended, _damage_half],
    ids=lambda f: f.__name__.removeprefix("_damage_"),
)
def test_a_damaged_record_is_evaluated_again_and_replaced_whole(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage
) -> None:  # type: ignore[no-untyped-def]
    project = _project(tmp_path, "crossfade joins")
    built = _samples(project)
    (record,) = _records(project)
    whole = record.read_bytes()
    _restart()
    damage(record)
    calls = Evaluations(monkeypatch)

    read = _samples(project)

    assert calls.count == 1
    np.testing.assert_array_equal(_bits(read), _bits(built))
    assert record.read_bytes() == whole
    _restart()
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
    _restart()
    calls = Evaluations(monkeypatch)

    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
    _samples(project)

    assert calls.count == 1 and len(_records(project)) == 2


def test_a_changed_track_gets_a_new_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = _project(tmp_path, "crossfade joins")
    before = _samples(project)
    _restart()
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
    _restart()
    calls = Evaluations(monkeypatch)
    monkeypatch.setattr(evidence_records, "RECORD_REV", evidence_records.RECORD_REV + 1)

    _samples(project)

    assert calls.count == 1 and len(_records(project)) == 2


def test_another_ffmpeg_build_makes_the_old_record_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    _restart()
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

    def rewritten(tree, curve, rates=(JUMP, WAVEFORM)):  # type: ignore[no-untyped-def]
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
    _restart()
    _samples(project)

    assert _records(project) == [] and calls.count == 2


def test_verify_mode_compares_a_record_with_a_fresh_evaluation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, "crossfade joins")
    _samples(project)
    (record,) = _records(project)
    _restart()
    monkeypatch.setenv(track_evidence.VERIFY_ENV, "1")
    _samples(project)
    _restart()
    data = bytearray(record.read_bytes())
    data[-8] ^= 0x40
    record.write_bytes(bytes(data))

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
    for key in keys:
        assert key is not None
        evidence_records.write_record(directory, key, evidence)
        time.sleep(0.01)

    kept = list(directory.glob("*.evd"))

    assert [p.name for p in kept] == [evidence_records.record_path(directory, keys[2] or "").name]


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
