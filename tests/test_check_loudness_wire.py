"""Pin the exact JSON wire output of check_loudness_tool for every freshness branch."""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.balance import balance_basis_digest
from podcast_mcp.engines.mastering import MasterTarget
from podcast_mcp.engines.play_audit import (
    master_fingerprint,
    mastered_hash_path,
    mastered_path,
    mix_gains,
    premix_path,
    write_mastered_hash,
    write_premix_hash,
)
from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import BalanceBasis
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService

ENGINE = "podcast_mcp.services.document.analysis.check_loudness"

REPORT = {
    "path": "/engine/audio.wav",
    "measured_lufs": -16.0,
    "target_lufs": -16.0,
    "true_peak_limit_db": -1.5,
    "lufs_pass": True,
    "pass": True,
}

HEAD = """{
  "path": "/engine/audio.wav",
  "measured_lufs": -16.0,
  "target_lufs": -16.0,
  "true_peak_limit_db": -1.5,
  "lufs_pass": true,
  "pass": true,
"""

NO_BASIS = """  "balance": {
    "host": {
      "stale": null,
      "speech_gated": null,
      "measured_lufs": null
    }
  }
}"""


def tracked(stale_reason: str | None) -> str:
    stale = "false" if stale_reason is None else "true"
    reason = "null" if stale_reason is None else f'"{stale_reason}"'
    return HEAD + f'  "stale": {stale},\n  "stale_reason": {reason},\n' + NO_BASIS


def _project(path: Path, sample_wav: Path) -> None:
    proj = load_project(path)
    raw = proj.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.clips = [
        Clip(id="full", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    save_project(proj, path)


@pytest.fixture
def world(minimal_project: Path, sample_wav: Path) -> Path:
    _project(minimal_project, sample_wav)
    return minimal_project


def _wire(path: Path, audio: Path | str | None = None) -> str:
    arg = None if audio is None else str(audio)
    with patch(ENGINE, return_value=dict(REPORT)):
        text = mcp_timeline.check_loudness_tool(str(path), arg)
        service = AnalysisService(ProjectWorkspace.open(path)).check_loudness(arg)
    assert to_json(service.model_dump()) == text
    return text


def _edit(path: Path, fn) -> None:
    proj = load_project(path)
    fn(proj)
    save_project(proj, path)


def _write_premix(path: Path, wav: Path) -> Path:
    project = load_project(path)
    premix = premix_path(project)
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(wav.read_bytes())
    return premix


def _hash_premix(path: Path) -> None:
    project = load_project(path)
    write_premix_hash(project, mix_gains(project), trim_db=0.0, defaults=load_defaults())


def _export(path: Path, wav: Path) -> Path:
    project = load_project(path)
    export = project.export_dir() / f"{project.name}.wav"
    export.parent.mkdir(parents=True, exist_ok=True)
    export.write_bytes(wav.read_bytes())
    return export


def _write_master(path: Path, wav: Path) -> Path:
    project = load_project(path)
    master = mastered_path(project)
    master.write_bytes(wav.read_bytes())
    write_mastered_hash(project, MasterTarget(), master_fingerprint(project, MasterTarget()))
    return master


def _newer_than(export: Path, master: Path) -> None:
    os.utime(export, ns=(master.stat().st_atime_ns, master.stat().st_mtime_ns + 1))


def test_untracked_audio_wire(world, sample_wav) -> None:
    other = world.parent / "other.wav"
    other.write_bytes(sample_wav.read_bytes())
    text = _wire(world, other)
    assert text == HEAD + '  "stale": null,\n  "stale_reason": "untracked_audio"\n}'
    assert list(json.loads(text)) == [*REPORT, "stale", "stale_reason"]


def test_premix_default_wire(world, sample_wav) -> None:
    premix = _write_premix(world, sample_wav)
    assert _wire(world) == tracked("premix_unverified")
    _hash_premix(world)
    assert _wire(world) == tracked(None)
    assert _wire(world, premix) == tracked(None)
    _edit(world, lambda p: setattr(p.track_by_id("host"), "fader_db", -3.0))
    assert _wire(world) == tracked("premix_stale")


def test_premix_unverified_is_stale_true(world, sample_wav) -> None:
    _write_premix(world, sample_wav)
    data = json.loads(_wire(world))
    assert data["stale"] is True
    assert data["stale_reason"] == "premix_unverified"


def test_export_branches_wire(world, sample_wav) -> None:
    export = _export(world, sample_wav)
    assert _wire(world) == tracked("premix_missing")
    premix = _write_premix(world, sample_wav)
    assert _wire(world) == tracked("premix_unverified")
    _hash_premix(world)
    _edit(world, lambda p: setattr(p.track_by_id("host"), "fader_db", -3.0))
    assert _wire(world) == tracked("premix_stale")
    _edit(world, lambda p: setattr(p.track_by_id("host"), "fader_db", 0.0))
    assert _wire(world) == tracked("master_missing")
    master = _write_master(world, sample_wav)
    assert _wire(world) == tracked("export_older_than_master")
    _newer_than(export, master)
    assert _wire(world) == tracked(None)
    assert _wire(world, export) == tracked(None)
    assert _wire(world, premix).count('"stale_reason": null') == 1
    mastered_hash_path(load_project(world)).unlink()
    assert _wire(world) == tracked("master_stale")


def test_export_branch_stale_flags(world, sample_wav) -> None:
    export = _export(world, sample_wav)
    data = json.loads(_wire(world))
    flags = {"premix_missing": (data["stale"], data["stale_reason"])}
    _write_premix(world, sample_wav)
    _hash_premix(world)
    data = json.loads(_wire(world))
    flags["master_missing"] = (data["stale"], data["stale_reason"])
    master = _write_master(world, sample_wav)
    _newer_than(export, master)
    data = json.loads(_wire(world))
    flags["fresh"] = (data["stale"], data["stale_reason"])
    assert flags == {
        "premix_missing": (True, "premix_missing"),
        "master_missing": (True, "master_missing"),
        "fresh": (False, None),
    }


def test_balance_values_wire(world, sample_wav) -> None:
    premix = _write_premix(world, sample_wav)
    _hash_premix(world)
    digest = balance_basis_digest(load_project(world), "host")
    assert digest is not None
    _edit(
        world,
        lambda p: setattr(
            p.track_by_id("host"),
            "balance_basis",
            BalanceBasis(digest=digest, measured_lufs=-23.0, speech_gated=True),
        ),
    )
    assert _wire(world, premix) == HEAD + (
        '  "stale": false,\n  "stale_reason": null,\n'
        '  "balance": {\n    "host": {\n      "stale": false,\n'
        '      "speech_gated": true,\n      "measured_lufs": -23.0\n    }\n  }\n}'
    )
    _edit(
        world,
        lambda p: setattr(
            p.track_by_id("host"),
            "balance_basis",
            BalanceBasis(digest="old", measured_lufs=-20.5, speech_gated=False),
        ),
    )
    assert _wire(world, premix) == HEAD + (
        '  "stale": false,\n  "stale_reason": null,\n'
        '  "balance": {\n    "host": {\n      "stale": true,\n'
        '      "speech_gated": false,\n      "measured_lufs": -20.5\n    }\n  }\n}'
    )


@pytest.mark.parametrize(
    ("value", "token"),
    [(float("nan"), "NaN"), (float("inf"), "Infinity"), (float("-inf"), "-Infinity")],
)
def test_balance_non_finite_measured_wire(world, sample_wav, value, token) -> None:
    premix = _write_premix(world, sample_wav)
    _hash_premix(world)
    with patch(
        "podcast_mcp.engines.balance.balance_status",
        return_value={"stale": False, "speech_gated": True, "measured_lufs": value},
    ):
        text = _wire(world, premix)
    assert text == HEAD + (
        '  "stale": false,\n  "stale_reason": null,\n'
        '  "balance": {\n    "host": {\n      "stale": false,\n'
        f'      "speech_gated": true,\n      "measured_lufs": {token}\n    }}\n  }}\n}}'
    )


def test_balance_only_dialogue_tracks_with_media(world, sample_wav) -> None:
    premix = _write_premix(world, sample_wav)
    _hash_premix(world)

    def add(proj) -> None:
        proj.tracks.append(Track(id="music", label="Music", role=TrackRole.MUSIC))
        proj.tracks.append(Track(id="guest", label="Guest", role=TrackRole.DIALOGUE))

    _edit(world, add)
    assert list(json.loads(_wire(world, premix))["balance"]) == ["host"]


def test_unmeasurable_audio_wire(world, sample_wav) -> None:
    premix = _write_premix(world, sample_wav)
    _hash_premix(world)
    with patch("podcast_mcp.edits.loudness.FFmpegEngine.measure_loudness", return_value=None):
        text = mcp_timeline.check_loudness_tool(str(world), str(premix))
    expected_head = (
        '{\n  "path": ' + json.dumps(str(premix)) + ',\n  "measured_lufs": null,\n'
        '  "target_lufs": -16.0,\n  "true_peak_limit_db": -1.5,\n'
        '  "lufs_pass": false,\n  "pass": false,\n'
    )
    assert text == expected_head + '  "stale": false,\n  "stale_reason": null,\n' + NO_BASIS


def test_model_key_order_and_balance_omission(world, sample_wav) -> None:
    _write_premix(world, sample_wav)
    keys = list(REPORT)
    with patch(ENGINE, return_value=dict(REPORT)):
        service = AnalysisService(ProjectWorkspace.open(world))
        untracked = service.check_loudness(str(sample_wav)).model_dump()
        tracked = service.check_loudness().model_dump()
    assert list(untracked) == [*keys, "stale", "stale_reason"]
    assert list(tracked) == [*keys, "stale", "stale_reason", "balance"]


def test_model_dump_keeps_non_finite() -> None:
    import math

    from podcast_mcp.services.document.loudness_results import build_loudness_report

    report = build_loudness_report(
        {**REPORT, "measured_lufs": float("nan")}, stale=None, stale_reason=None, balance={}
    )
    dumped = report.model_dump()
    assert math.isnan(dumped["measured_lufs"])
    assert dumped["balance"] == {}
