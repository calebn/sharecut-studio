from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media.daw_session import export_aaf_session
from podcast_mcp.util.coded_error import CodedValueError


def _pcm_wav(path: Path, sample_rate: int, channels: int, frames: int, seed: int) -> MediaAsset:
    with wave.open(str(path), "wb") as audio:
        audio.setparams((channels, 2, sample_rate, 0, "NONE", "not compressed"))
        values = []
        for frame in range(frames):
            for channel in range(channels):
                value = ((frame * 37 + channel * 701 + seed * 997) % 30_000) - 15_000
                values.append(value)
        audio.writeframes(struct.pack(f"<{len(values)}h", *values))
    return MediaAsset(path=path.name)


def _project(root: Path) -> ProjectWorkspace:
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace = ProjectWorkspace.create(root)
    mono = _pcm_wav(root / "host.wav", 48_000, 1, 96_000, seed=1)
    stereo = _pcm_wav(root / "guest.wav", 44_100, 2, 88_200, seed=2)
    workspace.project.timeline.tracks = [
        Track(id="host", label="Host", media=mono),
        Track(id="guest", label="Guest", media=stereo),
        Track(id="empty", label="Empty", media=mono, timeline_empty=True),
    ]
    workspace.project.timeline.clips = [
        Clip(
            id="moved",
            track_id="host",
            source_start=0.25,
            source_end=0.75,
            timeline_start=0.5,
            fade_in_ms=20,
        ),
        Clip(
            id="overlap",
            track_id="host",
            source_start=0,
            source_end=0.25,
            timeline_start=0.875,
            fade_out_ms=10,
        ),
        Clip(id="after-gap", track_id="host", source_start=0, source_end=0.125, timeline_start=1.5),
    ]
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace.save()
    return workspace


def _reader() -> Path:
    configured = os.environ.get("SHARECUT_AAFTOOL")
    if configured:
        return Path(configured)
    bundled = shutil.which("aaftool")
    if bundled:
        return Path(bundled)
    pytest.skip("Set SHARECUT_AAFTOOL to run the independent LibAAF check.")


def _run_reader(
    reader: Path,
    action: str,
    session: Path,
    output_dir: Path,
    *,
    extract_kind: str = "clips",
) -> str:
    args = [str(reader), action]
    if action == "analysis":
        args.append("--aaf-clips")
    else:
        output_dir.mkdir()
        args.extend([f"--extract-{extract_kind}", "--extract-path", str(output_dir)])
    result = subprocess.run(
        [*args, "--pos-format", "raw", "--no-color", str(session)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout + result.stderr


def _samples(path: Path) -> tuple[int, int, int, tuple[int, ...]]:
    with wave.open(str(path), "rb") as audio:
        channels = audio.getnchannels()
        sample_rate = audio.getframerate()
        frames = audio.getnframes()
        assert audio.getsampwidth() == 2
        values = struct.unpack(f"<{frames * channels}h", audio.readframes(frames))
        return channels, sample_rate, frames, values


def test_cli_export_is_relocatable_and_matches_independent_aaf_reader(tmp_path: Path) -> None:
    reader = _reader()
    original = tmp_path / "original"
    workspace = _project(original)
    original_bytes = workspace.path.read_bytes()
    output = tmp_path / "package"
    cli = CliRunner().invoke(
        app,
        ["episode", "export-aaf", "--project", str(workspace.path), "--output", str(output)],
    )
    assert cli.exit_code == 0, cli.output
    assert cli.output.strip() == str(output / "session.aaf")
    assert workspace.path.read_bytes() == original_bytes

    relocated = tmp_path / "relocated"
    output.rename(relocated)
    hidden_project = tmp_path / "source-unavailable"
    original.rename(hidden_project)
    session = relocated / "session.aaf"
    assert [path.name for path in relocated.iterdir()] == ["session.aaf"]

    report_dir = tmp_path / "report"
    report = _run_reader(reader, "analysis", session, report_dir)
    assert "Missing Sequence::Components" not in report
    tracks = re.findall(r'AudioTrack\[(\d+)\].*?Name: "([^"]+)"', report)
    assert [(int(number), name) for number, name in tracks] == [
        (1, "Host"),
        (2, "Host (overlap 1)"),
        (3, "Guest"),
        (4, "Empty"),
    ]
    clip_rows = [
        tuple(map(int, match))
        for match in re.findall(
            r"Clip \(\d+\):\s+Start: (\d+)\s+Len: (\d+)\s+End: (\d+)\s+SourceOffset: (\d+)\s+Channels: (\d+)",
            report,
        )
    ]
    assert clip_rows == [
        (24_000, 24_000, 48_000, 12_000, 1),
        (72_000, 6_000, 78_000, 0, 1),
        (42_000, 12_000, 54_000, 0, 1),
        (0, 88_200, 88_200, 0, 2),
    ]

    essence_dir = tmp_path / "essences"
    _run_reader(reader, "extraction", session, essence_dir, extract_kind="essences")
    assets = {path.name: _samples(path) for path in essence_dir.glob("*.wav")}
    assert set(assets) == {"0001.wav", "0002.wav"}
    host_asset = _samples(hidden_project / "host.wav")
    guest_asset = _samples(hidden_project / "guest.wav")
    assert assets["0001.wav"] == host_asset
    assert assets["0002.wav"] == guest_asset

    clip_dir = tmp_path / "clips"
    _run_reader(reader, "extraction", session, clip_dir)
    extracted = {path.name: _samples(path) for path in clip_dir.glob("*.wav")}
    assert len(extracted) == 4
    host_values = host_asset[3]
    expected_host_clips = [
        (host_asset[0], host_asset[1], 24_000, host_values[12_000:36_000]),
        (host_asset[0], host_asset[1], 6_000, host_values[:6_000]),
        (host_asset[0], host_asset[1], 12_000, host_values[:12_000]),
    ]
    guest_values = guest_asset[3]
    expected_guest_clip = (guest_asset[0], guest_asset[1], 88_200, guest_values)
    actual_clips = list(extracted.values())
    actual_signatures = [(channels, rate, frames) for channels, rate, frames, _ in actual_clips]
    expected_signatures = [item[:3] for item in expected_host_clips] + [expected_guest_clip[:3]]
    assert sorted(actual_signatures) == sorted(expected_signatures)
    expected_pcm = [item[3] for item in expected_host_clips] + [expected_guest_clip[3]]
    assert sorted(tuple(pcm) for _, _, _, pcm in actual_clips) == sorted(expected_pcm)


def test_aaf_rejects_same_track_mixed_rates_before_publication(tmp_path: Path) -> None:
    workspace = _project(tmp_path / "original")
    source = _pcm_wav(workspace.path.parent / "other-rate.wav", 44_100, 1, 88_200, seed=3)
    workspace.project.sources.append(
        SourceRecording(
            id="other-rate",
            path=source.path,
            sample_rate=44_100,
            channels=1,
            duration_sec=2.0,
        )
    )
    workspace.project.timeline.clips.append(
        Clip(
            id="mixed-rate",
            track_id="host",
            source_id="other-rate",
            source_start=0,
            source_end=0.5,
            timeline_start=2.0,
        )
    )
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace.save()
    output = tmp_path / "package"
    with pytest.raises(ValueError, match="one sample rate per track"):
        export_aaf_session(workspace.path, output)
    assert not output.exists()
    assert not any(path.name.startswith((".partial-", ".cleanup-")) for path in tmp_path.iterdir())


@pytest.mark.parametrize(
    ("media_path", "error"),
    [("missing.wav", FileNotFoundError), ("../outside.wav", ValueError)],
)
def test_aaf_rejects_missing_or_unsafe_media_before_publication(
    tmp_path: Path, media_path: str, error: type[Exception]
) -> None:
    workspace = _project(tmp_path / "original")
    workspace.project.timeline.tracks[0] = workspace.project.timeline.tracks[0].model_copy(
        update={
            "media": workspace.project.timeline.tracks[0].media.model_copy(
                update={"path": media_path}
            )
        }
    )
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace.save()
    with pytest.raises(error):
        export_aaf_session(workspace.path, tmp_path / "package")
    assert not (tmp_path / "package").exists()
    assert not any(path.name.startswith((".partial-", ".cleanup-")) for path in tmp_path.iterdir())


def test_aaf_destination_collision_keeps_existing_data_and_cleans_stage(tmp_path: Path) -> None:
    workspace = _project(tmp_path / "original")
    output = tmp_path / "package"
    output.mkdir()
    sentinel = output / "keep"
    sentinel.write_bytes(b"existing")
    with pytest.raises(FileExistsError):
        export_aaf_session(workspace.path, output)
    assert list(output.iterdir()) == [sentinel]
    assert sentinel.read_bytes() == b"existing"
    assert not any(path.name.startswith((".partial-", ".cleanup-")) for path in tmp_path.iterdir())


def test_aaf_writer_failure_cleans_staged_media_and_partial_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import aaf2

    workspace = _project(tmp_path / "original")
    original_import = aaf2.mobs.MasterMob.import_audio_essence
    imported = False

    def fail_after_embedding(master: object, *args: object, **kwargs: object) -> object:
        nonlocal imported
        original_import(master, *args, **kwargs)
        imported = True
        raise RuntimeError("synthetic writer failure")

    monkeypatch.setattr(aaf2.mobs.MasterMob, "import_audio_essence", fail_after_embedding)
    with pytest.raises(RuntimeError, match="synthetic writer failure"):
        export_aaf_session(workspace.path, tmp_path / "package")
    assert imported
    assert not (tmp_path / "package").exists()
    assert not any(path.name.startswith((".partial-", ".cleanup-")) for path in tmp_path.iterdir())


def test_float_wav_is_embedded_as_native_rate_24_bit_pcm(tmp_path: Path) -> None:
    reader = _reader()
    root = tmp_path / "original"
    workspace = _project(root)
    engine = FFmpegEngine()
    float_path = root / "host-float.wav"
    expected_path = root / "expected-s24.wav"
    engine.export_audio(
        root / "host.wav",
        float_path,
        codec="pcm_f32le",
        format="wav",
        extra_args=["-map", "0:a:0", "-map_metadata", "-1"],
    )
    engine.export_audio(
        float_path,
        expected_path,
        codec="pcm_s24le",
        format="wav",
        sample_rate=48_000,
        channels=1,
        extra_args=["-map", "0:a:0", "-map_metadata", "-1"],
    )
    workspace.project.timeline.tracks[0] = workspace.project.timeline.tracks[0].model_copy(
        update={"media": MediaAsset(path=float_path.name)}
    )
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace.save()
    output = tmp_path / "package"
    export_aaf_session(workspace.path, output)
    session = output / "session.aaf"
    essence_dir = tmp_path / "essences"
    _run_reader(reader, "extraction", session, essence_dir, extract_kind="essences")
    extracted = _samples_or_s24(essence_dir / "0001.wav")
    expected = _samples_or_s24(expected_path)
    assert extracted[:3] == expected[:3] == (1, 48_000, 96_000)
    assert extracted[3] == expected[3]


def _samples_or_s24(path: Path) -> tuple[int, int, int, bytes]:
    content = path.read_bytes()
    fmt = None
    payload = None
    offset = 12
    while offset + 8 <= len(content):
        chunk_id = content[offset : offset + 4]
        chunk_size = int.from_bytes(content[offset + 4 : offset + 8], "little")
        chunk = content[offset + 8 : offset + 8 + chunk_size]
        if chunk_id == b"fmt ":
            fmt = chunk
        elif chunk_id == b"data":
            payload = chunk
        offset += 8 + chunk_size + (chunk_size & 1)
    assert fmt is not None and payload is not None
    format_tag, channels, sample_rate, _, block_align, bits = struct.unpack_from("<HHIIHH", fmt)
    assert bits == 24 and block_align == channels * 3
    assert format_tag == 1 or (
        format_tag == 0xFFFE and fmt[24:40] == bytes.fromhex("0100000000001000800000aa00389b71")
    )
    frames = len(payload) // block_align
    assert len(payload) == frames * block_align
    return channels, sample_rate, frames, payload


def test_aaf_timeline_positions_round_half_to_even(tmp_path: Path) -> None:
    reader = _reader()
    root = tmp_path / "original"
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace = ProjectWorkspace.create(root)
    media = _pcm_wav(root / "host.wav", 48_000, 1, 48_000, seed=4)
    workspace.project.timeline.tracks = [Track(id="host", label="Host", media=media)]
    workspace.project.timeline.clips = [
        Clip(
            id="half-tick",
            track_id="host",
            source_start=0,
            source_end=0.25,
            timeline_start=1.5 / 48_000,
        )
    ]
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace.save()
    session = export_aaf_session(workspace.path, tmp_path / "package")
    report = _run_reader(reader, "analysis", session, tmp_path / "report")
    assert re.search(r"Start: 2\s+Len: 12000\s+End: 12002\s+SourceOffset: 0", report)


def test_aaf_without_optional_writer_fails_before_staging(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = _project(tmp_path / "original")
    monkeypatch.setitem(sys.modules, "aaf2", None)
    with pytest.raises(CodedValueError, match="optional writer") as raised:
        export_aaf_session(workspace.path, tmp_path / "package")
    assert raised.value.code == "aaf_export_dependency_missing"
    assert not (tmp_path / "package").exists()
    assert not any(path.name.startswith((".partial-", ".cleanup-")) for path in tmp_path.iterdir())
