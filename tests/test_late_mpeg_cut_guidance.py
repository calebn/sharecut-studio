from __future__ import annotations

import json
import subprocess

import pytest
from typer.testing import CliRunner

from pause_policy_public_helpers import files
from podcast_mcp.cli.main import app
from podcast_mcp.edits import cut_application, cut_effects, cut_policy, cut_safety
from podcast_mcp.edits.cut_placement import CutRejected, CutScopeHold
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.engines.ffmpeg import FFmpegEngine, LateMpegAudioError
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.util.coded_error import CodedValueError


@pytest.mark.refine_gate
def test_cli_late_mpeg_cut_explains_recovery_without_changing_project(tmp_path):
    project = EpisodeProject.create("Legacy transport", str(tmp_path))
    project.ensure_dirs()
    source = tmp_path / "raw" / "late.ts"
    engine = FFmpegEngine()
    subprocess.run(
        [
            engine.ffmpeg,
            "-v",
            "error",
            "-y",
            "-filter_threads",
            "1",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x64:rate=10:duration=8",
            "-itsoffset",
            "0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:r=44100:duration=2",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "mpeg2video",
            "-c:a",
            "mp2",
            "-threads",
            "1",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    project.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(
                path="raw/late.ts",
                duration_sec=8,
                sample_rate=44100,
                channels=1,
            ),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0,
            source_end=2,
            timeline_start=0,
        )
    ]
    path = save_project(project)
    runner = CliRunner()
    status = runner.invoke(app, ["transcript", "refine-status", "--project", str(path)])
    assert status.exit_code == 0, status.output
    with write_grant(WriteGrantKind.LEGACY_CLI):
        done = runner.invoke(
            app,
            [
                "transcript",
                "refine-done",
                "--project",
                str(path),
                "--expected-fingerprint",
                json.loads(status.stdout)["fingerprint"],
                "--notes",
                "Disposable pure-tone fixture has no speech or transcript words.",
            ],
        )
    assert done.exit_code == 0, done.output
    with pytest.raises(LateMpegAudioError):
        engine.audio_start_sec(source)
    before = files(tmp_path)

    result = runner.invoke(
        app,
        [
            "edit",
            "ripple-delete",
            "--project",
            str(path),
            "--start",
            "0.75",
            "--end",
            "1.25",
            "--no-inaudible-opt",
        ],
    )

    assert result.exit_code != 0
    assert "cut_scope_changed" in result.output
    assert files(tmp_path) == before
    assert "re-encode" in result.output
    assert "re-add" in result.output
    assert "late.ts" not in result.output
    assert str(tmp_path) not in result.output


@pytest.mark.parametrize(
    "failure",
    [
        ValueError("/private/recordings/secret.wav"),
        OSError("/private/recordings/secret.wav"),
        subprocess.SubprocessError("decoder stderr /private/recordings/secret.wav"),
        CodedValueError("/private/recordings/secret.wav", code="invalid_audio"),
        LateMpegAudioError(),
    ],
)
def test_completed_extraction_failure_keeps_safe_specific_or_generic_guidance(
    tmp_path,
    monkeypatch,
    failure,
):
    project = EpisodeProject.create("Unavailable", str(tmp_path))

    def unavailable(*args, **kwargs):
        raise failure

    monkeypatch.setattr(cut_effects, "completed_audio_effects", unavailable)
    holds = cut_application._completed_holds(
        project,
        project.model_copy(deep=True),
        frozenset({"first", "second"}),
        defaults={},
    )
    assert {hold.edit_id for hold in holds} == {"first", "second"}
    assert all(hold.reason == "acoustic_edge" for hold in holds)
    error = ScopeChangedAtApproval(holds, {})
    assert error.code == "cut_scope_changed"
    assert error.guest_message() == (
        "This edit needs another review. Ask the host to review it in the editor before applying it."
    )
    assert "/private" not in str(error)
    assert "secret.wav" not in str(error)
    assert "decoder stderr" not in str(error)
    assert "--override-audio-checks" in str(error)
    if isinstance(failure, LateMpegAudioError):
        assert all(hold.detail == "late_mpeg_audio" for hold in holds)
        assert "re-encode" in str(error)
        assert "re-add" in str(error)
    else:
        assert all(hold.detail == "audio_unavailable" for hold in holds)
        assert "the audio could not be read" in str(error)
        assert "re-encode" not in str(error)


@pytest.mark.parametrize("mode", ["ripple", "mute"])
def test_late_mpeg_finding_keeps_acoustic_policy_and_override_eligibility(tmp_path, mode):
    project = EpisodeProject.create("Policy", str(tmp_path))
    generic = CutScopeHold("cut", (), "acoustic_edge", detail="audio_unavailable")
    specific = CutScopeHold("cut", (), "acoustic_edge", detail="late_mpeg_audio")
    assert cut_safety.safety_observation_label(specific) == "acoustic_edge"
    assert cut_policy.action_for_safety_observation(
        cut_safety.safety_observation_label(specific),
        mode,
    ) == cut_policy.action_for_safety_observation(
        cut_safety.safety_observation_label(generic),
        mode,
    )
    assert cut_safety.hold_is_overridable(specific) == cut_safety.hold_is_overridable(generic)
    assert cut_safety.apply_safety_actions(project, [specific], mode=mode) == [specific]


def test_unavailable_findings_respect_manual_and_rejected_pause_precedence(tmp_path, monkeypatch):
    project = EpisodeProject.create("Precedence", str(tmp_path))

    def unavailable(*args, **kwargs):
        raise LateMpegAudioError()

    monkeypatch.setattr(cut_effects, "completed_audio_effects", unavailable)
    holds = cut_application._completed_holds(
        project,
        project.model_copy(deep=True),
        frozenset({"manual", "pause", "cut"}),
        defaults={},
        manual_ids=frozenset({"manual"}),
        pauses={"pause": CutRejected("pause_support_unavailable")},
    )
    assert [(hold.edit_id, hold.reason, hold.detail) for hold in holds] == [
        ("pause", "pause_air", "pause_support_unavailable"),
        ("cut", "acoustic_edge", "late_mpeg_audio"),
    ]
