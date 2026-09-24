from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.engines.align import AlignmentResult
from podcast_mcp.engines.alignment_audit import DriftReport, SessionStartScore, WaveformRenderResult
from podcast_mcp.engines.ffmpeg import AudioProbe
from podcast_mcp.ingest.consolidate import ConsolidateResult, SpeakerAlignment
from podcast_mcp.ingest.manifest import IngestManifest
from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project
from podcast_mcp.services.ingest import (
    IngestService,
    SuggestCandidate,
    SuggestResult,
    VerifyResult,
    _frange,
    _manual_session_start,
    _track_id,
    _yaml_snippet_for_manifest,
    suggest_alignment_for_manifest,
    suggest_result_to_dict,
    verify_result_to_dict,
    write_alignment_report,
)
from podcast_mcp.services.workspace import ProjectWorkspace


def _ingest_manifest(tmp_path: Path, sample_wav: Path) -> tuple[Path, IngestManifest]:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    ref = audio_dir / "ref.wav"
    guest = audio_dir / "guest.wav"
    ref.write_bytes(sample_wav.read_bytes())
    guest.write_bytes(sample_wav.read_bytes())
    manifest_path = tmp_path / "ingest.yaml"
    manifest_path.write_text(
        """
session:
  reference_speaker: Ref
speakers:
  - name: Ref
    sources: [ref.wav]
    session_start_in_file_sec: 2.0
  - name: Guest
    sources: [guest.wav]
""",
        encoding="utf-8",
    )
    return audio_dir, IngestManifest.load(manifest_path)


def _two_track_workspace(minimal_project: Path, sample_wav: Path) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    ws = proj.workspace_path()
    guest = ws / "raw" / "guest.wav"
    guest.write_bytes(sample_wav.read_bytes())
    proj.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=2.0),
        ),
    ]
    proj.timeline.clips = []
    from podcast_mcp.models import save_project

    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_frange_and_track_id_helpers() -> None:
    assert _frange(0.0, 10.0, 5.0) == [0.0, 5.0, 10.0]
    with pytest.raises(ValueError, match="sweep step"):
        _frange(0.0, 1.0, 0.0)
    assert _track_id("Host Name!") == "host_name"


def test_manual_session_start_and_yaml_snippet(tmp_path: Path, sample_wav: Path) -> None:
    _, manifest = _ingest_manifest(tmp_path, sample_wav)
    assert _manual_session_start(manifest, "Ref") == 2.0
    assert _manual_session_start(manifest, "Missing") == 0.0
    snippet = _yaml_snippet_for_manifest(
        manifest,
        {"Ref": 2.0, "Guest": 5.0},
        {"Ref": 0.0, "Guest": 0.25},
        "Guest",
    )
    assert "reference_speaker: Ref" in snippet
    assert "session_start_in_file_sec: 5.0" in snippet
    assert "session_offset_sec: 0.25" in snippet


def test_result_serializers_and_report(tmp_path: Path) -> None:
    suggest = SuggestResult(
        reference_speaker="Ref",
        source_speaker="Guest",
        recommended_session_starts={"Ref": 0.0, "Guest": 5.0},
        recommended_content_offsets={"Ref": 0.0, "Guest": 0.1},
        candidates=[
            SuggestCandidate(
                session_start_in_file_sec=5.0,
                content_align_sec=0.1,
                simultaneous_speech_sec=1.0,
                correlation_peak=0.8,
            )
        ],
        yaml_snippet="speakers:\n",
        drift_warning="drift",
    )
    verify = VerifyResult(
        status="pass",
        simultaneous_speech_sec=1.0,
        window_start_sec=0.0,
        window_end_sec=90.0,
        per_track_segments=[],
        warnings=[],
        play_commands=["podcast play"],
    )
    suggest_dict = suggest_result_to_dict(suggest)
    assert suggest_dict["drift_warning"] == "drift"
    assert suggest_dict["candidates"][0]["correlation_peak"] == 0.8
    verify_dict = verify_result_to_dict(verify)
    assert verify_dict["status"] == "pass"
    out = tmp_path / "nested" / "report.json"
    write_alignment_report(out, [{"speaker": "Host"}])
    assert json.loads(out.read_text(encoding="utf-8")) == [{"speaker": "Host"}]


def test_consolidate_to_dialogue_tracks_delegates(tmp_path: Path, sample_wav: Path) -> None:
    ws = ProjectWorkspace.create(tmp_path / "proj")
    audio_dir, manifest = _ingest_manifest(tmp_path, sample_wav)
    fake = ConsolidateResult(
        speaker_tracks={"Host": audio_dir / "ref.wav"},
        alignments=[],
        cross_speaker_offsets={},
    )
    with patch(
        "podcast_mcp.services.ingest.consolidate_speakers",
        return_value=fake,
    ) as consolidate:
        result = IngestService(ws).consolidate_to_dialogue_tracks(
            manifest,
            audio_dir,
            extract_start_sec=0.0,
            transcript_path=tmp_path / "t.json",
        )
    assert result is fake
    consolidate.assert_called_once()
    kwargs = consolidate.call_args.kwargs
    assert kwargs["extract_start_sec"] == 0.0
    assert kwargs["transcript_path"] == tmp_path / "t.json"


@pytest.mark.parametrize(
    "overlap,expected_status",
    [(10.0, "pass"), (25.0, "warn"), (40.0, "fail")],
)
def test_verify_alignment_status(
    minimal_project: Path,
    sample_wav: Path,
    overlap: float,
    expected_status: str,
) -> None:
    ws = _two_track_workspace(minimal_project, sample_wav)
    intervals = [(0.0, 90.0), (0.0, 90.0)]
    wf = WaveformRenderResult(
        stack_path=ws.project.artifacts_dir() / "stack.png",
        per_speaker={"Host": ws.project.artifacts_dir() / "host.png"},
    )
    with (
        patch(
            "podcast_mcp.services.ingest.vad_speech_intervals",
            return_value=intervals,
        ),
        patch(
            "podcast_mcp.services.ingest.simultaneous_speech_sec",
            return_value=overlap,
        ),
        patch(
            "podcast_mcp.services.ingest.render_comparison_waveforms",
            return_value=wf,
        ),
    ):
        result = IngestService(ws).verify_alignment(
            window_start_sec=0.0,
            window_end_sec=90.0,
        )
    assert result.status == expected_status
    assert result.simultaneous_speech_sec == overlap
    assert len(result.play_commands) == 3
    assert result.waveform_paths
    assert result.per_track_segments


def test_verify_alignment_no_waveforms_and_requires_two_tracks(
    minimal_project: Path,
    sample_wav: Path,
) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="at least two dialogue tracks"):
        IngestService(ws).verify_alignment(write_waveforms=False)

    ws = _two_track_workspace(minimal_project, sample_wav)
    with (
        patch(
            "podcast_mcp.services.ingest.vad_speech_intervals",
            return_value=[],
        ),
        patch(
            "podcast_mcp.services.ingest.simultaneous_speech_sec",
            return_value=0.0,
        ),
    ):
        result = IngestService(ws).verify_alignment(
            write_waveforms=False,
            diag_dir=minimal_project / "diag",
        )
    assert result.status == "pass"
    assert result.waveform_paths == []
    assert result.per_track_segments == []


def test_apply_consolidated_tracks(minimal_project: Path, sample_wav: Path) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    ws_path = ws.project.workspace_path()
    out_wav = ws_path / "raw" / "host_consolidated.wav"
    out_wav.write_bytes(sample_wav.read_bytes())
    src_wav = ws_path / "raw" / "host_source.wav"
    src_wav.write_bytes(sample_wav.read_bytes())
    result = ConsolidateResult(
        speaker_tracks={"Host": out_wav},
        alignments=[
            SpeakerAlignment(
                name="Host",
                reference=src_wav,
                sources=[
                    AlignmentResult(
                        reference=src_wav,
                        source=src_wav,
                        offset_sec=0.0,
                        correlation_peak=1.0,
                    )
                ],
            )
        ],
        cross_speaker_offsets={"Host": 0.5},
        session_start_in_file_sec={"Host": 1.0},
        cross_speaker_align_method={"Host": "audio"},
    )
    probe = AudioProbe(duration_sec=2.0, sample_rate=48000, channels=1)
    with patch("podcast_mcp.edits.track_media.FFmpegEngine") as eng_cls:
        eng_cls.return_value.probe.return_value = probe
        track_ids = IngestService(ws).apply_consolidated_tracks(result)
    assert track_ids == ["host"]
    proj = load_project(minimal_project)
    assert len(proj.timeline.tracks) == 1
    assert proj.timeline.tracks[0].speaker == "Host"
    assert proj.sources and proj.sources[0].offset_sec == 0.5
    assert proj.meta.ingest_alignment is not None
    assert proj.meta.ingest_alignment["Host"].content_align_sec == 0.5


def test_apply_consolidated_extra_clips_sequential(minimal_project: Path, sample_wav: Path) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    ws_path = ws.project.workspace_path()
    wav_a = ws_path / "raw" / "host_a.wav"
    wav_b = ws_path / "raw" / "host_b.wav"
    wav_a.write_bytes(sample_wav.read_bytes())
    wav_b.write_bytes(sample_wav.read_bytes())
    result = ConsolidateResult(
        speaker_tracks={"Host": wav_a},
        alignments=[
            SpeakerAlignment(
                name="Host",
                reference=wav_a,
                sources=[
                    AlignmentResult(
                        reference=wav_a,
                        source=wav_a,
                        offset_sec=0.0,
                        correlation_peak=1.0,
                    ),
                    AlignmentResult(
                        reference=wav_a,
                        source=wav_b,
                        offset_sec=0.0,
                        correlation_peak=1.0,
                    ),
                ],
            )
        ],
        cross_speaker_offsets={"Host": 0.0},
        session_start_in_file_sec={"Host": 0.0},
        cross_speaker_align_method={"Host": "audio"},
    )
    probe = AudioProbe(duration_sec=3.0, sample_rate=48000, channels=1)
    with patch("podcast_mcp.engines.ffmpeg.FFmpegEngine") as eng_cls:
        eng_cls.return_value.probe.return_value = probe
        IngestService(ws).apply_consolidated_tracks(result)
    proj = load_project(minimal_project)
    host_clips = [c for c in proj.clips if c.track_id == "host"]
    assert len(host_clips) == 2
    starts = sorted(c.timeline_start for c in host_clips)
    assert starts == [0.0, 3.0]
    assert proj.meta.ingest_alignment is not None
    assert "Host" not in proj.meta.ingest_alignment
    assert all(":" in k for k in proj.meta.ingest_alignment)


def test_suggest_alignment_for_manifest(tmp_path: Path, sample_wav: Path) -> None:
    audio_dir, manifest = _ingest_manifest(tmp_path, sample_wav)
    scored = [
        SessionStartScore(
            session_start_in_file_sec=5.0,
            simultaneous_speech_sec=1.0,
            correlation_peak=0.7,
        )
    ]
    wf = WaveformRenderResult(stack_path=tmp_path / "stack.png")
    drift = DriftReport(
        offset_window_a=0.0,
        offset_window_b=0.0,
        drift_sec=0.0,
        warning="small drift",
    )
    with (
        patch(
            "podcast_mcp.services.ingest.sweep_session_starts",
            return_value=scored,
        ),
        patch(
            "podcast_mcp.services.ingest.sweep_content_offset",
            side_effect=[0.25, 0.25],
        ),
        patch(
            "podcast_mcp.services.ingest.render_comparison_waveforms",
            return_value=wf,
        ),
        patch(
            "podcast_mcp.services.ingest.check_drift",
            return_value=drift,
        ),
    ):
        result = suggest_alignment_for_manifest(
            manifest,
            audio_dir,
            analysis_duration_sec=60.0,
            sweep_start_max=5.0,
            sweep_step=5.0,
            waveform_top_n=1,
        )
    assert result.reference_speaker == "Ref"
    assert result.source_speaker == "Guest"
    assert result.recommended_session_starts["Guest"] == 5.0
    assert result.recommended_content_offsets["Guest"] == 0.25
    assert result.drift_warning == "small drift"
    assert result.waveform_paths == [str(wf.stack_path)]


def test_suggest_alignment_for_manifest_no_waveforms(
    tmp_path: Path,
    sample_wav: Path,
) -> None:
    audio_dir, manifest = _ingest_manifest(tmp_path, sample_wav)
    with (
        patch("podcast_mcp.services.ingest.sweep_session_starts", return_value=[]),
        patch(
            "podcast_mcp.services.ingest.sweep_content_offset",
            return_value=0.0,
        ),
        patch(
            "podcast_mcp.services.ingest.check_drift",
            return_value=DriftReport(0.0, 0.0, 0.0, None),
        ),
    ):
        result = suggest_alignment_for_manifest(
            manifest,
            audio_dir,
            waveform_top_n=0,
        )
    assert result.candidates == []
    assert result.waveform_paths == []


def test_suggest_alignment_scores_all_non_reference_guests(
    tmp_path: Path, sample_wav: Path
) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    for name in ("ref.wav", "audra.wav", "lana.wav"):
        (audio_dir / name).write_bytes(sample_wav.read_bytes())
    manifest = IngestManifest.model_validate(
        {
            "session": {"reference_speaker": "Ref"},
            "speakers": [
                {"name": "Ref", "sources": ["ref.wav"], "session_start_in_file_sec": 0.0},
                {"name": "Audra", "sources": ["audra.wav"]},
                {"name": "Lana", "sources": ["lana.wav"]},
            ],
        }
    )
    scored_a = [
        SessionStartScore(
            session_start_in_file_sec=30.0,
            simultaneous_speech_sec=2.0,
            correlation_peak=0.8,
        )
    ]
    scored_b = [
        SessionStartScore(
            session_start_in_file_sec=12.0,
            simultaneous_speech_sec=1.5,
            correlation_peak=0.6,
        )
    ]

    with (
        patch(
            "podcast_mcp.services.ingest.sweep_session_starts",
            side_effect=lambda ref, guest, candidates, **kw: (
                scored_a if Path(guest).name == "audra.wav" else scored_b
            ),
        ),
        patch(
            "podcast_mcp.services.ingest.sweep_content_offset",
            return_value=0.0,
        ),
        patch(
            "podcast_mcp.services.ingest.check_drift",
            return_value=DriftReport(0.0, 0.0, 0.0, None),
        ),
    ):
        result = suggest_alignment_for_manifest(
            manifest,
            audio_dir,
            waveform_top_n=0,
            sweep_start_max=30.0,
            sweep_step=5.0,
        )

    assert result.source_speaker == "Audra"
    assert result.recommended_session_starts["Audra"] == 30.0
    assert result.recommended_session_starts["Lana"] == 12.0
    assert "Lana" in result.yaml_snippet
    assert "session_start_in_file_sec: 12.0" in result.yaml_snippet


def test_verify_alignment_absolute_media_paths(
    minimal_project: Path,
    sample_wav: Path,
) -> None:
    ws = _two_track_workspace(minimal_project, sample_wav)
    ws_path = ws.project.workspace_path()
    abs_host = ws_path / "raw" / "host.wav"
    abs_guest = ws_path / "raw" / "guest.wav"
    proj = load_project(minimal_project)
    proj.timeline.tracks[0].media.path = str(abs_host)
    proj.timeline.tracks[1].media.path = str(abs_guest)
    from podcast_mcp.models import save_project

    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    wf = WaveformRenderResult(
        stack_path=None,
        per_speaker={"Host": ws.project.artifacts_dir() / "host.png"},
    )
    with (
        patch(
            "podcast_mcp.services.ingest.vad_speech_intervals",
            return_value=[(0.0, 1.0)],
        ),
        patch(
            "podcast_mcp.services.ingest.simultaneous_speech_sec",
            return_value=0.0,
        ),
        patch(
            "podcast_mcp.services.ingest.render_comparison_waveforms",
            return_value=wf,
        ),
    ):
        result = IngestService(ws).verify_alignment(write_waveforms=True)
    assert result.status == "pass"
    assert result.waveform_paths == [str(wf.per_speaker["Host"])]


def test_apply_consolidated_tracks_absolute_paths(
    minimal_project: Path,
    sample_wav: Path,
) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    ws_path = ws.project.workspace_path()
    out_wav = ws_path / "raw" / "host_consolidated.wav"
    out_wav.write_bytes(sample_wav.read_bytes())
    src_wav = minimal_project.parent.parent / "external_host_source.wav"
    src_wav.write_bytes(sample_wav.read_bytes())
    result = ConsolidateResult(
        speaker_tracks={"Host": out_wav},
        alignments=[
            SpeakerAlignment(
                name="Host",
                reference=src_wav,
                sources=[
                    AlignmentResult(
                        reference=src_wav,
                        source=src_wav,
                        offset_sec=0.0,
                        correlation_peak=1.0,
                    )
                ],
            )
        ],
        cross_speaker_offsets={"Host": 0.0},
    )
    probe = AudioProbe(duration_sec=2.0, sample_rate=48000, channels=1)
    with patch("podcast_mcp.edits.track_media.FFmpegEngine") as eng_cls:
        eng_cls.return_value.probe.return_value = probe
        track_ids = IngestService(ws).apply_consolidated_tracks(result)
    assert track_ids == ["host"]
    proj = load_project(minimal_project)
    assert str(proj.sources[0].path) == src_wav.name
    assert str(proj.timeline.tracks[0].media.path) == str(out_wav.relative_to(ws_path))


@pytest.mark.parametrize("escape", ["absolute", "dotdot", "symlink"])
def test_apply_consolidated_tracks_rejects_workspace_escape(
    minimal_project: Path, sample_wav: Path, escape: str
) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    outside = root.parent / "outside.wav"
    outside.write_bytes(sample_wav.read_bytes())
    if escape == "absolute":
        wav = outside
    elif escape == "dotdot":
        wav = root / ".." / "outside.wav"
    else:
        wav = root / "raw" / "linked.wav"
        wav.symlink_to(outside)
    result = ConsolidateResult(
        speaker_tracks={"Host": wav}, alignments=[], cross_speaker_offsets={}
    )
    with pytest.raises(ValueError, match="consolidated track must be under workspace"):
        IngestService(ws).apply_consolidated_tracks(result)


def test_apply_consolidated_tracks_empty_speaker_tracks(
    minimal_project: Path,
) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    result = ConsolidateResult(
        speaker_tracks={},
        alignments=[],
        cross_speaker_offsets={},
    )
    with patch("podcast_mcp.edits.track_media.FFmpegEngine"):
        track_ids = IngestService(ws).apply_consolidated_tracks(result)
    assert track_ids == []
    proj = load_project(minimal_project)
    assert proj.timeline.tracks == []
    assert proj.meta.ingest_alignment is None


def test_yaml_snippet_without_session(tmp_path: Path, sample_wav: Path) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    ref = audio_dir / "ref.wav"
    ref.write_bytes(sample_wav.read_bytes())
    manifest_path = tmp_path / "ingest.yaml"
    manifest_path.write_text(
        """
speakers:
  - name: Ref
    sources: [ref.wav]
  - name: Guest
    sources: [ref.wav]
""",
        encoding="utf-8",
    )
    manifest = IngestManifest.load(manifest_path)
    snippet = _yaml_snippet_for_manifest(
        manifest,
        {"Guest": 5.0},
        {"Guest": 0.2},
        "Guest",
    )
    assert "session:" not in snippet
    assert "session_start_in_file_sec: 5.0" in snippet
    assert "session_offset_sec: 0.2" in snippet
    assert "session_start_in_file_sec" not in snippet.split("Ref")[1].split("Guest")[0]
