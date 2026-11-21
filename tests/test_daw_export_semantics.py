from __future__ import annotations

import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from tests.daw_export_fixture import EXPECTED_CLIPS_SECONDS, create_daw_export_project

from podcast_mcp.services.media.daw_session import (
    export_aaf_session,
    export_audition_session,
    export_reaper_session,
)


def _base_track(label: str) -> str:
    return label.split(" (overlap ", maxsplit=1)[0]


def _rounded(rows: list[tuple[str, float, float, float]]) -> list[tuple[str, float, float, float]]:
    return sorted(
        (label, round(start, 6), round(length, 6), round(source, 6))
        for label, start, length, source in rows
    )


def _reaper_semantics(path: Path) -> tuple[list[str], list[tuple[str, float, float, float]]]:
    text = path.read_text(encoding="utf-8")
    blocks = re.findall(r"  <TRACK\n(.*?)\n  >", text, flags=re.DOTALL)
    names = []
    clips = []
    for block in blocks:
        name = re.search(r"^    NAME (.+)$", block, flags=re.MULTILINE)
        assert name is not None
        label = name.group(1).strip("\"`'")
        names.append(label)
        for item in re.findall(r"    <ITEM\n(.*?)\n    >", block, flags=re.DOTALL):
            values = {
                key: float(value)
                for key, value in re.findall(
                    r"^      (POSITION|LENGTH|SOFFS) (.+)$", item, flags=re.MULTILINE
                )
            }
            clips.append(
                (_base_track(label), values["POSITION"], values["LENGTH"], values["SOFFS"])
            )
    return names, clips


def _sesx_semantics(path: Path) -> tuple[list[str], list[tuple[str, float, float, float]]]:
    root = ET.parse(path).getroot()
    rate = int(root.find("./session").get("sampleRate"))
    names = []
    clips = []
    for track in root.findall("./session/tracks/audioTrack"):
        label = track.findtext("./trackParameters/name") or ""
        names.append(label)
        for clip in track.findall("audioClip"):
            start = int(clip.get("startPoint"))
            end = int(clip.get("endPoint"))
            source = int(clip.get("sourceInPoint"))
            clips.append((_base_track(label), start / rate, (end - start) / rate, source / rate))
    return names, clips


def _aaf_semantics(report: str) -> tuple[list[str], list[tuple[str, float, float, float]]]:
    track_headers = list(
        re.finditer(r'AudioTrack\[(\d+)\].*?Name: "([^"]+)"', report, flags=re.DOTALL)
    )
    names = [match.group(2) for match in track_headers]
    clips = []
    for index, match in enumerate(track_headers):
        end = track_headers[index + 1].start() if index + 1 < len(track_headers) else len(report)
        section = report[match.start() : end]
        label = match.group(2)
        rate = 44_100 if label == "Guest" else 48_000
        for values in re.finditer(
            r"Clip \(\d+\):\s+Start: (\d+)\s+Len: (\d+)\s+End: (\d+)\s+SourceOffset: (\d+)",
            section,
        ):
            start, length, _, source = (int(value) for value in values.groups())
            clips.append((_base_track(label), start / rate, length / rate, source / rate))
    return names, clips


def test_shared_semantic_fixture_matches_reaper_aaf_and_sesx(tmp_path: Path) -> None:
    aaf_reader = os.environ.get("SHARECUT_AAFTOOL")
    sesx_reader = os.environ.get("SHARECUT_SESX_READER")
    if not aaf_reader or not sesx_reader:
        pytest.skip("The independent AAF and SESX readers are configured in the FFmpeg shard.")
    workspace = create_daw_export_project(tmp_path / "original")
    reaper = export_reaper_session(workspace.path, tmp_path / "reaper")
    aaf = export_aaf_session(workspace.path, tmp_path / "aaf")
    sesx = export_audition_session(workspace.path, tmp_path / "sesx")
    relocated = {}
    for key, session in (("reaper", reaper), ("aaf", aaf), ("sesx", sesx)):
        package = tmp_path / f"{key}-relocated"
        session.parent.rename(package)
        relocated[key] = package / session.name
    workspace.path.parent.rename(tmp_path / "unavailable")

    reaper_tracks, reaper_clips = _reaper_semantics(relocated["reaper"])
    assert reaper_tracks == ["Host", "Guest", "Empty"]
    assert _rounded(reaper_clips) == _rounded(list(EXPECTED_CLIPS_SECONDS))

    sesx_tracks, sesx_clips = _sesx_semantics(relocated["sesx"])
    assert sesx_tracks == ["Host", "Host (overlap 1)", "Guest", "Empty"]
    assert _rounded(sesx_clips) == _rounded(list(EXPECTED_CLIPS_SECONDS))

    aaf_result = subprocess.run(
        [
            aaf_reader,
            "analysis",
            "--aaf-clips",
            "--pos-format",
            "raw",
            "--no-color",
            str(relocated["aaf"]),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert aaf_result.returncode == 0, aaf_result.stdout + aaf_result.stderr
    aaf_tracks, aaf_clips = _aaf_semantics(aaf_result.stdout + aaf_result.stderr)
    assert aaf_tracks == ["Host", "Host (overlap 1)", "Guest", "Empty"]
    assert _rounded(aaf_clips) == _rounded(list(EXPECTED_CLIPS_SECONDS))

    converter_env = dict(os.environ)
    rpp_site = os.environ.get("SHARECUT_SESX_RPP_SITE")
    if rpp_site:
        converter_env["PYTHONPATH"] = rpp_site
    converter_result = subprocess.run(
        [sys.executable, sesx_reader, str(relocated["sesx"])],
        env=converter_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert converter_result.returncode == 0, converter_result.stdout + converter_result.stderr
    converted_tracks, converted_clips = _reaper_semantics(relocated["sesx"].with_suffix(".rpp"))
    assert converted_tracks == sesx_tracks
    assert _rounded(converted_clips) == _rounded(list(EXPECTED_CLIPS_SECONDS))
