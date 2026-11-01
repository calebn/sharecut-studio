"""``podcast doctor`` and the segment library."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.segments import store as store_module
from podcast_mcp.segments.model import SEGMENT_JSON, MediaEntry, segment_json
from podcast_mcp.segments.store import SegmentStore, sha256_file
from podcast_mcp.services.support import doctor as doctor_module
from podcast_mcp.services.support.doctor import MAX_DAMAGED_SEGMENTS_LISTED, run_doctor_checks
from test_segments_insert import _flac, _save

runner = CliRunner()


def _segment_messages(*, deep: bool = False) -> list[str]:
    return [c.message for c in doctor_module._segment_library_checks(deep=deep)]


def test_doctor_is_quiet_without_a_library_and_with_a_clean_one(tmp_path: Path) -> None:
    assert _segment_messages() == []
    _save(tmp_path, "Warm Intro")
    assert _segment_messages() == []
    assert not any("segment" in c.message for c in run_doctor_checks().checks)


def test_doctor_reports_a_segment_whose_audio_changed(tmp_path: Path) -> None:
    segment = _save(tmp_path, "Warm Intro")
    store = SegmentStore()
    audio = store.path(segment.id) / "clip-01.flac"
    audio.write_bytes(audio.read_bytes() + b"tamper")

    checks = doctor_module._segment_library_checks()

    assert len(checks) == 1
    assert checks[0].status == "warn"
    assert segment.id in checks[0].message
    assert "does not match its recorded hash" in checks[0].message
    assert segment.id in (checks[0].extra or "")
    report = run_doctor_checks()
    assert report.passed
    assert any(segment.id in c.message for c in report.checks)


def test_doctor_caps_the_damaged_segments_it_lists(tmp_path: Path) -> None:
    total = MAX_DAMAGED_SEGMENTS_LISTED + 2
    store = SegmentStore()
    for index in range(total):
        segment = _save(tmp_path, f"Intro {index}")
        audio = store.path(segment.id) / "clip-01.flac"
        audio.write_bytes(audio.read_bytes() + b"x")

    messages = _segment_messages()

    assert len(messages) == MAX_DAMAGED_SEGMENTS_LISTED + 1
    assert "2 more damaged segments" in messages[-1]


@pytest.fixture(autouse=True)
def _config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(tmp_path / "doctor-config"))


def test_the_default_check_never_hashes_and_deep_does(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    segment = _save(tmp_path, "Warm Intro")
    audio = SegmentStore().path(segment.id) / "clip-01.flac"
    data = bytearray(audio.read_bytes())
    data[-1] ^= 0xFF  # same size, other content
    audio.write_bytes(bytes(data))
    hashed: list[Path] = []
    real = store_module.sha256_file
    monkeypatch.setattr(
        store_module, "sha256_file", lambda path: (hashed.append(path), real(path))[1]
    )

    assert _segment_messages() == []
    assert run_doctor_checks().passed
    assert hashed == []

    deep = _segment_messages(deep=True)
    assert len(deep) == 1 and "does not match" in deep[0]
    assert hashed


def test_the_cheap_check_sees_a_missing_or_resized_file_and_a_broken_manifest(
    tmp_path: Path,
) -> None:
    gone = _save(tmp_path, "Gone Intro")
    (SegmentStore().path(gone.id) / "clip-01.flac").unlink()
    grown = _save(tmp_path, "Grown Intro")
    audio = SegmentStore().path(grown.id) / "clip-01.flac"
    audio.write_bytes(audio.read_bytes() + b"x")
    broken = _save(tmp_path, "Broken Intro")
    (SegmentStore().path(broken.id) / "segment.json").write_text("{", encoding="utf-8")

    messages = _segment_messages()

    assert len(messages) == 3
    assert all(m.startswith("segment ") for m in messages)


def test_the_fix_line_never_offers_remove_when_an_older_version_would_be_lost(
    tmp_path: Path,
) -> None:
    only = _save(tmp_path, "Only Intro")
    audio = SegmentStore().path(only.id) / "clip-01.flac"
    audio.write_bytes(audio.read_bytes() + b"x")
    first = next(c for c in doctor_module._segment_library_checks() if only.id in c.message)
    assert "segment remove" in (first.extra or "")

    twice = _save(tmp_path, "Twice Intro")
    other = tmp_path / "v2"
    other.mkdir()
    new_audio = other / "clip-01.flac"
    # A real second version: other audio under the same name.
    new_audio = _flac(other / "clip-01.flac", 1.5)
    updated = twice.model_copy(
        update={
            "clips": [twice.clips[0].model_copy(update={"duration_sec": 1.5})],
            "media": {
                "clip-01.flac": MediaEntry(
                    sha256=sha256_file(new_audio), bytes=new_audio.stat().st_size
                )
            },
        }
    )
    (other / SEGMENT_JSON).write_text(segment_json(updated), encoding="utf-8")
    assert SegmentStore().add(other).version == 2
    bad = SegmentStore().path(twice.id) / "clip-01.flac"
    bad.write_bytes(bad.read_bytes() + b"x")

    checks = [c for c in doctor_module._segment_library_checks() if twice.id in c.message]

    assert len(checks) == 1
    assert "segment remove" not in (checks[0].extra or "")
    assert "Import the segment again" in (checks[0].extra or "")
    listing = runner.invoke(app, ["segment", "list"])
    assert twice.id in listing.output and "segment remove " + twice.id not in listing.output


def test_a_segment_removed_during_the_scan_is_not_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import shutil

    segment = _save(tmp_path, "Warm Intro")
    store = SegmentStore()
    real = store._read

    def vanish(folder: Path, **kwargs):
        shutil.rmtree(folder.parent)
        return real(folder, **kwargs)

    monkeypatch.setattr(store, "_read", vanish)

    listing = store.scan(deep=False)

    assert listing.damaged == [] and listing.segments == []
    assert segment.id not in " ".join(_segment_messages())


def test_doctor_deep_flag_reaches_the_check(tmp_path: Path) -> None:
    segment = _save(tmp_path, "Warm Intro")
    audio = SegmentStore().path(segment.id) / "clip-01.flac"
    data = bytearray(audio.read_bytes())
    data[-1] ^= 0xFF
    audio.write_bytes(bytes(data))

    assert segment.id not in runner.invoke(app, ["doctor"]).output
    assert segment.id in runner.invoke(app, ["doctor", "--deep"]).output
