from __future__ import annotations

import json
import wave
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.ingest import _parse_speaker_overrides
from podcast_mcp.cli.main import app
from podcast_mcp.engines.ffmpeg import AudioProbe
from podcast_mcp.ingest.import_folder import derive_speaker_label, scan_recorder_folder
from podcast_mcp.ingest.manifest import IngestManifest
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.services.ingest import IngestService, _unique_speaker_name


def _write_wav(
    path: Path,
    *,
    duration_sec: float = 0.2,
    sample_rate: int = 48000,
    channels: int = 1,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = max(1, int(duration_sec * sample_rate))
    with wave.open(str(path), "w") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * frames * channels)
    return path


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("audioJohnSmith11234567890.m4a", "John Smith"),
        ("Jane_Doe-track-2026-01-02.wav", "Jane Doe"),
        ("host-caleb.wav", "Host Caleb"),
        ("guest_recording_raw.flac", "Guest"),
        ("track-2026-01-02.wav", "speaker_1"),
    ],
)
def test_derive_speaker_label_table(filename: str, expected: str) -> None:
    assert derive_speaker_label(filename, fallback_index=1) == expected


def test_scan_skips_mix_file_when_others_exist(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    _write_wav(audio / "session_mix.wav")
    _write_wav(audio / "combined-output.mp3")
    _write_wav(audio / "host-remix.wav")
    scan = scan_recorder_folder(audio)
    names = {row.filename for row in scan.files}
    assert names == {"host.wav", "host-remix.wav"}
    skipped = {row.filename for row in scan.skipped}
    assert "session_mix.wav" in skipped
    assert "combined-output.mp3" in skipped


def test_scan_keeps_mix_file_when_only_audio(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "stereo-mix.wav")
    scan = scan_recorder_folder(audio)
    assert [row.filename for row in scan.files] == ["stereo-mix.wav"]
    assert scan.skipped == []


def test_scan_skips_hidden_and_detects_vendor_hint(tmp_path: Path) -> None:
    audio = tmp_path / "zoom-export"
    _write_wav(audio / "host.wav")
    _write_wav(audio / ".secret.wav")
    scan = scan_recorder_folder(audio)
    assert [row.filename for row in scan.files] == ["host.wav"]
    assert scan.vendor_hint == "zoom"


def test_scan_duplicate_short_channel_rate_warnings(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav", duration_sec=1.0, sample_rate=48000, channels=1)
    _write_wav(audio / "host-track.wav", duration_sec=1.0, sample_rate=44100, channels=2)
    _write_wav(audio / "late.wav", duration_sec=0.2, sample_rate=48000, channels=1)
    scan = scan_recorder_folder(audio)
    text = " ".join(scan.warnings)
    assert "duplicate speaker labels" in text
    assert "sample-rate mismatch" in text
    assert "mono and stereo" in text
    assert "late.wav" in text


def test_scan_many_files_warning(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    for i in range(9):
        _write_wav(audio / f"speaker-{i}.wav")
    scan = scan_recorder_folder(audio)
    assert any("9 files" in warning for warning in scan.warnings)


def test_scan_file_count_bound(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "a.wav")
    _write_wav(audio / "b.wav")
    with pytest.raises(ValueError, match="bound is 1"):
        scan_recorder_folder(audio, max_files=1)


def test_scan_duration_bound(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "a.wav")

    class _HugeProbe:
        def probe(self, path: Path, *, untrusted: bool = False) -> AudioProbe:
            assert untrusted is True
            return AudioProbe(duration_sec=10_000, sample_rate=48000, channels=1)

    with pytest.raises(ValueError, match="exceeds bound"):
        scan_recorder_folder(
            audio,
            engine=_HugeProbe(),  # type: ignore[arg-type]
            max_total_duration_sec=60,
        )


def test_scan_refuses_symlink_escape(tmp_path: Path) -> None:
    outside = _write_wav(tmp_path / "secret.wav")
    audio = tmp_path / "rec"
    audio.mkdir()
    (audio / "escape.wav").symlink_to(outside)
    with pytest.raises(ValueError, match="symlink escapes"):
        scan_recorder_folder(audio)


def test_scan_accepts_relative_recorder_folder(tmp_path: Path, monkeypatch) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    monkeypatch.chdir(tmp_path)
    result = scan_recorder_folder(Path("rec"))
    assert result.files[0].filename == "host.wav"


def test_scan_accepts_literal_tilde_recorder_folder(tmp_path: Path, monkeypatch) -> None:
    audio = tmp_path / "~nobody-local"
    _write_wav(audio / "host.wav")
    monkeypatch.chdir(tmp_path)
    result = scan_recorder_folder(Path("~nobody-local"))
    assert result.files[0].filename == "host.wav"


def test_scan_missing_dir(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="not a readable directory"):
        scan_recorder_folder(tmp_path / "missing")


def test_scan_empty_folder(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    audio.mkdir()
    with pytest.raises(ValueError, match="no audio files"):
        scan_recorder_folder(audio)


def test_scan_skips_directory_with_audio_suffix(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    (audio / "nested.wav").mkdir(parents=True)
    _write_wav(audio / "host.wav")
    scan = scan_recorder_folder(audio)
    assert [row.filename for row in scan.files] == ["host.wav"]


def test_scan_list_dir_oserror(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    audio = tmp_path / "rec"
    audio.mkdir()
    real_iterdir = Path.iterdir
    calls = {"n": 0}

    def _flaky(self: Path) -> object:
        if self == audio:
            calls["n"] += 1
            if calls["n"] > 1:
                raise OSError("denied")
        return real_iterdir(self)

    monkeypatch.setattr(Path, "iterdir", _flaky)
    with pytest.raises(ValueError, match="cannot read directory"):
        scan_recorder_folder(audio)


def test_scan_resolve_oserror(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    real_resolve = Path.resolve

    def _boom(self: Path, strict: bool = False) -> Path:
        if self.name == "host.wav":
            raise OSError("bad link")
        return real_resolve(self)

    monkeypatch.setattr(Path, "resolve", _boom)
    with pytest.raises(ValueError, match="cannot resolve"):
        scan_recorder_folder(audio)


def test_scan_unreadable_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    audio = tmp_path / "rec"
    audio.mkdir()

    def _denied(self: Path) -> list[Path]:
        raise OSError("denied")

    monkeypatch.setattr(Path, "iterdir", _denied)
    with pytest.raises(ValueError, match="not a readable directory"):
        scan_recorder_folder(audio)


def test_scan_even_count_short_file_median(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "long.wav", duration_sec=1.0)
    _write_wav(audio / "late.wav", duration_sec=0.2)
    scan = scan_recorder_folder(audio)
    assert any("late.wav" in warning for warning in scan.warnings)


def test_import_writes_loadable_manifest(tmp_path: Path) -> None:
    audio = tmp_path / "riverside-room"
    _write_wav(audio / "audioJohnSmith11234567890.wav")
    _write_wav(audio / "Jane_Doe-track-2026-01-02.wav")
    dest = tmp_path / "episode" / "ingest.yaml"
    report = IngestService.import_recorder_folder(audio, out_manifest=dest)
    assert report.written is True
    assert dest.is_file()
    assert report.vendor_hint == "riverside"
    labels = {row["speaker_label"] for row in report.files}
    assert labels == {"John Smith", "Jane Doe"}
    manifest = IngestManifest.load(dest)
    assert manifest.reference_speaker_name() in labels
    assert all(sp.session_start_in_file_sec is None for sp in manifest.speakers)
    assert manifest.align_anchors == []
    assert {src for sp in manifest.speakers for src in sp.sources} == {
        "audioJohnSmith11234567890.wav",
        "Jane_Doe-track-2026-01-02.wav",
    }


def test_import_dry_run_writes_nothing(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    dest = tmp_path / "ingest.yaml"
    report = IngestService.import_recorder_folder(audio, out_manifest=dest, dry_run=True)
    assert report.written is False
    assert report.dry_run is True
    assert not dest.exists()


def test_import_uniquifies_duplicate_labels(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    _write_wav(audio / "host-track.wav")
    dest = tmp_path / "ingest.yaml"
    report = IngestService.import_recorder_folder(audio, out_manifest=dest)
    labels = [row["speaker_label"] for row in report.files]
    assert "Host" in labels
    assert "Host 2" in labels
    assert not any("duplicate speaker labels" in w for w in report.warnings)
    manifest = IngestManifest.load(dest)
    assert {sp.name for sp in manifest.speakers} == {"Host", "Host 2"}


def test_import_speaker_override_by_stem(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host-caleb.wav")
    dest = tmp_path / "ingest.yaml"
    report = IngestService.import_recorder_folder(
        audio,
        out_manifest=dest,
        speakers_override={"host-caleb": "Caleb"},
    )
    assert report.files[0]["speaker_label"] == "Caleb"


def test_import_speaker_override(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host-caleb.wav")
    dest = tmp_path / "ingest.yaml"
    report = IngestService.import_recorder_folder(
        audio,
        out_manifest=dest,
        speakers_override={"host-caleb.wav": "Caleb"},
    )
    assert report.files[0]["speaker_label"] == "Caleb"
    manifest = IngestManifest.load(dest)
    assert manifest.speakers[0].name == "Caleb"


def test_import_refuses_tests_fixtures_write(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    dest = tmp_path / "tests" / "fixtures" / "ingest.yaml"
    dest.parent.mkdir(parents=True)
    with pytest.raises(ValueError, match="tests/fixtures"):
        IngestService.import_recorder_folder(audio, out_manifest=dest)


def test_import_refuses_tests_fixtures_parent_write(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    dest = tmp_path / "tests" / "fixtures" / "nested" / "ingest.yaml"
    dest.parent.mkdir(parents=True)
    with pytest.raises(ValueError, match="tests/fixtures"):
        IngestService.import_recorder_folder(audio, out_manifest=dest)


def test_import_warns_on_overwrite(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    dest = tmp_path / "ingest.yaml"
    dest.write_text("old", encoding="utf-8")
    report = IngestService.import_recorder_folder(audio, out_manifest=dest)
    assert any("overwriting existing manifest" in w for w in report.warnings)


def test_import_refuses_manifest_symlink(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    real = tmp_path / "real.yaml"
    dest = audio / "ingest.yaml"
    dest.symlink_to(real)
    with pytest.raises(ValueError, match="symlink"):
        IngestService.import_recorder_folder(audio, out_manifest=dest)


def test_import_prefers_host_reference_speaker(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "guest.wav")
    _write_wav(audio / "host.wav")
    dest = tmp_path / "ingest.yaml"
    report = IngestService.import_recorder_folder(audio, out_manifest=dest)
    manifest = IngestManifest.load(dest)
    assert manifest.reference_speaker_name() == "Host"
    assert report.files[0]["speaker_label"] in {"Guest", "Host"}


def test_import_host_token_not_substring_of_ghost(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "ghost.wav")
    _write_wav(audio / "host.wav")
    dest = tmp_path / "ingest.yaml"
    IngestService.import_recorder_folder(audio, out_manifest=dest)
    manifest = IngestManifest.load(dest)
    assert manifest.reference_speaker_name() == "Host"


def test_import_host_token_splits_spaces_and_camel_case(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "ghost.wav")
    _write_wav(audio / "Host Track.wav")
    dest = tmp_path / "ingest.yaml"
    IngestService.import_recorder_folder(audio, out_manifest=dest)
    assert IngestManifest.load(dest).reference_speaker_name() == "Host"

    dest2 = tmp_path / "ingest2.yaml"
    audio2 = tmp_path / "rec2"
    _write_wav(audio2 / "aaa-guest.wav")
    _write_wav(audio2 / "HostCaleb.wav")
    IngestService.import_recorder_folder(audio2, out_manifest=dest2)
    assert IngestManifest.load(dest2).reference_speaker_name() == "Host Caleb"


def test_import_rejects_empty_speaker_override(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    with pytest.raises(ValueError, match="non-empty"):
        IngestService.import_recorder_folder(
            audio,
            speakers_override={"host.wav": "  "},
        )


def test_import_cli_human_vendor_and_skip(tmp_path: Path) -> None:
    audio = tmp_path / "zoom-room"
    _write_wav(audio / "host.wav")
    _write_wav(audio / "session_mix.wav")
    result = CliRunner().invoke(app, ["ingest", "import", str(audio)])
    assert result.exit_code == 0, result.output
    assert "Vendor hint: zoom" in result.output
    assert "skipped: session_mix.wav" in result.output
    assert "Wrote" in result.output
    assert (audio / "ingest.yaml").is_file()


def test_unique_speaker_name_collisions() -> None:
    used = {"Host", "Host 2"}
    assert _unique_speaker_name("Host", used, fallback_index=1) == "Host 3"
    used2 = {"speaker_1"}
    assert _unique_speaker_name("  ", used2, fallback_index=1) == "speaker_1 2"


def test_parse_speaker_overrides_rejects_empty_parts() -> None:
    with pytest.raises(Exception, match="filename=Name"):
        _parse_speaker_overrides(["=Name"])
    with pytest.raises(Exception, match="filename=Name"):
        _parse_speaker_overrides(["file="])
    assert _parse_speaker_overrides(None) == {}


def test_import_cli_bad_speaker(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    result = CliRunner().invoke(
        app,
        ["ingest", "import", str(audio), "--speaker", "not-a-pair"],
    )
    assert result.exit_code != 0


def test_import_cli_json(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    dest = tmp_path / "out.yaml"
    result = CliRunner().invoke(
        app,
        ["ingest", "import", str(audio), "--out", str(dest), "--json"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["written"] is True
    assert Path(payload["out_manifest"]).is_file()


def test_import_cli_speaker_and_dry_run(tmp_path: Path) -> None:
    audio = tmp_path / "rec"
    _write_wav(audio / "host.wav")
    dest = tmp_path / "ingest.yaml"
    result = CliRunner().invoke(
        app,
        [
            "ingest",
            "import",
            str(audio),
            "--out",
            str(dest),
            "--speaker",
            "host.wav=Alex",
            "--dry-run",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "Alex" in result.output
    assert "Dry run" in result.output
    assert not dest.exists()


def test_ingest_import_folder_mcp(tmp_path: Path) -> None:
    audio = tmp_path / "zencastr-drop"
    _write_wav(audio / "host-caleb.wav")
    dest = tmp_path / "ingest.yaml"
    out = mcp_server.ingest_import_folder_tool(
        str(audio),
        out_manifest=str(dest),
        speakers_override={"host-caleb.wav": "Caleb"},
    )
    data = json.loads(out)
    assert data["written"] is True
    assert data["vendor_hint"] == "zencastr"
    assert data["files"][0]["speaker_label"] == "Caleb"
    manifest = IngestManifest.load(dest)
    assert manifest.speakers[0].name == "Caleb"
