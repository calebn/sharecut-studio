from __future__ import annotations

import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from tests.daw_export_fixture import create_daw_export_project
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.media.daw_session import export_audition_session


def _clips(session: Path) -> list[tuple[str, int, int, int, int]]:
    root = ET.parse(session).getroot()
    rows = []
    for track in root.findall("./session/tracks/audioTrack"):
        name = track.findtext("./trackParameters/name")
        for clip in track.findall("audioClip"):
            rows.append(
                (
                    name or "",
                    int(clip.get("startPoint", "0")),
                    int(clip.get("endPoint", "0")),
                    int(clip.get("sourceInPoint", "0")),
                    int(clip.get("sourceOutPoint", "0")),
                )
            )
    return rows


def _reader() -> tuple[Path, Path | None] | None:
    configured = os.environ.get("SHARECUT_SESX_READER")
    if not configured:
        return None
    reader = Path(configured)
    rpp_site_value = os.environ.get("SHARECUT_SESX_RPP_SITE")
    rpp_site = Path(rpp_site_value) if rpp_site_value else None
    if rpp_site is not None and not rpp_site.is_dir():
        return None
    return reader, rpp_site


def test_cli_export_is_relocatable_and_keeps_saved_project_unchanged(tmp_path: Path) -> None:
    workspace = create_daw_export_project(tmp_path / "original")
    original_bytes = workspace.path.read_bytes()
    host_bytes = (workspace.path.parent / "host.wav").read_bytes()
    output = tmp_path / "package"
    result = CliRunner().invoke(
        app,
        ["episode", "export-audition", "--project", str(workspace.path), "--output", str(output)],
    )
    assert result.exit_code == 0, result.output
    assert result.output.strip() == str(output / "session.sesx")
    assert workspace.path.read_bytes() == original_bytes

    relocated = tmp_path / "relocated"
    output.rename(relocated)
    hidden_project = tmp_path / "unavailable"
    workspace.path.parent.rename(hidden_project)
    session = relocated / "session.sesx"
    root = ET.parse(session).getroot()
    assert root.find("./session").get("sampleRate") == "48000"
    assert root.find("./session").get("audioChannelType") == "stereo"
    assert [
        track.findtext("./trackParameters/name")
        for track in root.findall("./session/tracks/audioTrack")
    ] == [
        "Host",
        "Host (overlap 1)",
        "Guest",
        "Empty",
    ]
    assert _clips(session) == [
        ("Host", 24_000, 48_000, 12_000, 36_000),
        ("Host", 72_000, 78_000, 0, 6_000),
        ("Host (overlap 1)", 42_000, 54_000, 0, 12_000),
        ("Guest", 0, 96_000, 0, 96_000),
    ]
    assert root.find(".//fadeIn").get("endPoint") == "960"
    assert root.find(".//fadeOut").get("endPoint") == "12000"

    files = {node.get("id"): node for node in root.findall("./files/file")}
    assert set(files) == {"1", "2"}
    for node in files.values():
        relative = Path(node.get("relativePath", ""))
        assert not relative.is_absolute() and ".." not in relative.parts
        assert node.get("absolutePath") == relative.as_posix()
        assert (relocated / relative).is_file()
    media = {path.name: path for path in (relocated / "media").glob("*.wav")}
    assert set(media) == {"0001.wav", "0002.wav"}
    assert media["0001.wav"].read_bytes() == host_bytes
    probe = FFmpegEngine().probe(media["0002.wav"])
    assert (
        probe.sample_rate,
        probe.channels,
        round(probe.require_duration_sec() * probe.sample_rate),
    ) == (
        48_000,
        2,
        96_000,
    )
    decoded = FFmpegEngine().decode_full_f32(
        media["0002.wav"], sample_rate=48_000, layout=["-ac", "2"]
    )
    assert decoded[::2].mean() != decoded[1::2].mean()
    assert not workspace.path.exists()
    assert (hidden_project / "host.wav").is_file()

    reader = _reader()
    if reader is not None:
        converter, rpp_site = reader
        reader_env = dict(os.environ)
        if rpp_site is not None:
            reader_env["PYTHONPATH"] = str(rpp_site)
        completed = subprocess.run(
            [sys.executable, str(converter), str(session)],
            env=reader_env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode == 0, completed.stdout + completed.stderr
        converted = (relocated / "session.rpp").read_text(encoding="utf-8")
        assert re.findall(r"^    NAME (.+)$", converted, flags=re.MULTILINE) == [
            "Host",
            '"Host (overlap 1)"',
            "Guest",
            "Empty",
        ]
        assert re.findall(r"^      POSITION (.+)$", converted, flags=re.MULTILINE) == [
            "0.500000",
            "1.500000",
            "0.875000",
            "0.000000",
        ]
        assert re.findall(r"^      LENGTH (.+)$", converted, flags=re.MULTILINE) == [
            "0.500000",
            "0.125000",
            "0.250000",
            "2.000000",
        ]
        assert re.findall(r"^      SOFFS (.+)$", converted, flags=re.MULTILINE) == [
            "0.250000",
            "0.000000",
            "0.000000",
            "0.000000",
        ]
    assert not workspace.path.exists()
    assert (hidden_project / "host.wav").is_file()


def test_uniform_session_rate_preserves_every_media_byte(tmp_path: Path) -> None:
    workspace = create_daw_export_project(tmp_path / "original", mixed_rates=False)
    originals = {
        path.name: path.read_bytes()
        for path in (workspace.path.parent / "host.wav", workspace.path.parent / "guest.wav")
    }
    session = export_audition_session(workspace.path, tmp_path / "package")
    for path in (session.parent / "media").glob("*.wav"):
        source_name = "host.wav" if path.name == "0001.wav" else "guest.wav"
        assert path.read_bytes() == originals[source_name]
    assert ET.parse(session).find("./session").get("sampleRate") == "48000"


def test_mixed_rate_odd_frame_source_is_trimmed_to_projected_extent(tmp_path: Path) -> None:
    workspace = create_daw_export_project(
        tmp_path / "original", mixed_rates=True, guest_frames=22_051
    )
    session = export_audition_session(workspace.path, tmp_path / "package")
    root = ET.parse(session).getroot()
    guest_clip = root.find("./session/tracks/audioTrack[3]/audioClip")
    assert guest_clip is not None
    assert guest_clip.get("endPoint") == "24001"
    assert guest_clip.get("sourceOutPoint") == "24001"
    guest_file = root.find("./files/file[@id='2']")
    assert guest_file is not None
    media_path = session.parent / guest_file.get("relativePath", "")
    probe = FFmpegEngine().probe(media_path)
    assert round(probe.require_duration_sec() * probe.sample_rate) == 24_001


def test_converted_source_bounds_round_half_sample_ties_to_even(tmp_path: Path) -> None:
    workspace = create_daw_export_project(
        tmp_path / "original",
        mixed_rates=True,
        guest_frames=32_000,
        guest_sample_rate=32_000,
        guest_clip_frame_bounds=(1, 3),
    )
    session = export_audition_session(workspace.path, tmp_path / "package")
    root = ET.parse(session).getroot()
    guest_clip = root.find("./session/tracks/audioTrack[3]/audioClip")
    assert guest_clip is not None
    assert guest_clip.get("sourceInPoint") == "2"
    assert guest_clip.get("sourceOutPoint") == "4"
    assert guest_clip.get("endPoint") == "24002"


@pytest.mark.parametrize("media_path", ["missing.wav", "../outside.wav"])
def test_invalid_media_does_not_publish_package(tmp_path: Path, media_path: str) -> None:
    workspace = create_daw_export_project(tmp_path / "original", mixed_rates=False)
    workspace.project.timeline.tracks[0] = workspace.project.timeline.tracks[0].model_copy(
        update={
            "media": workspace.project.timeline.tracks[0].media.model_copy(
                update={"path": media_path}
            )
        }
    )
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace.save()
    output = tmp_path / "package"
    with pytest.raises((OSError, ValueError)):
        export_audition_session(workspace.path, output)
    assert not output.exists()
    assert not any(path.name.startswith((".partial-", ".cleanup-")) for path in tmp_path.iterdir())


def test_existing_target_is_never_replaced(tmp_path: Path) -> None:
    workspace = create_daw_export_project(tmp_path / "original", mixed_rates=False)
    output = tmp_path / "package"
    output.mkdir()
    marker = output / "keep.txt"
    marker.write_text("existing", encoding="utf-8")
    with pytest.raises(FileExistsError):
        export_audition_session(workspace.path, output)
    assert marker.read_text(encoding="utf-8") == "existing"


def test_packaging_failure_cleans_owned_stage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = create_daw_export_project(tmp_path / "original", mixed_rates=True)
    output = tmp_path / "package"

    def fail(*args: object, **kwargs: object) -> None:
        raise RuntimeError("synthetic conversion failure")

    monkeypatch.setattr(FFmpegEngine, "export_audio", fail)
    with pytest.raises(RuntimeError, match="synthetic conversion failure"):
        export_audition_session(workspace.path, output)
    assert not output.exists()
    assert not any(path.name.startswith((".partial-", ".cleanup-")) for path in tmp_path.iterdir())
