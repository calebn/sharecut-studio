from __future__ import annotations

import json
import logging
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import (
    mastered_is_fresh,
    premix_stale_vs_mix,
    read_mastered_hash,
)
from podcast_mcp.models import (
    ChapterMarker,
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import steps
from podcast_mcp.services.workspace import ProjectWorkspace


def _dialogue_project(minimal_project: Path, sample_wav: Path, tmp_workspace: Path):
    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav"),
        ),
        Track(
            id="bed",
            label="Bed",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/host.wav"),
        ),
    ]
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="hello",
            )
        ]
    )
    save_project(proj, minimal_project)
    return load_project(minimal_project)


def test_analyze_focus_cuts_writes_outline(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    defaults = {**defaults, "focus": {"enabled": True, "segment_merge_gap_sec": 2.5}}
    steps.analyze_focus_cuts(proj, defaults)
    assert (proj.artifacts_dir() / "focus_outline.json").is_file()


def test_focus_from_transcript_auto_apply(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = {"focus": {"auto_apply": False}}
    steps.focus_from_transcript(proj, defaults)
    defaults["focus"]["auto_apply"] = True
    steps.focus_from_transcript(proj, defaults)


def test_reconcile_transcript_off_mode(minimal_project):
    proj = load_project(minimal_project)
    defaults = {"analysis": {"transcript_mode": "off"}}
    steps.reconcile_transcript(proj, defaults)


def test_precorrect_transcript_step(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    from podcast_mcp.models import Transcript, TranscriptWord

    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="um", start=0.0, end=0.2)],
        )
    ]
    steps.precorrect_transcript(proj, load_defaults())


def test_mix_with_music_builds_premix(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    assert (proj.artifacts_dir() / "premix.wav").is_file()


def test_stem_uses_pre_mutation_snapshot_for_audio_and_hash(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.engines.play_audit import read_stem_hash, track_render_hash

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks = proj.tracks[:1]
    proj.clips = [
        Clip(
            id="host-clip",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        )
    ]
    ProjectWorkspace(minimal_project, proj).save()  # mutate() adopts the saved project
    before_hash = track_render_hash(proj, "host")
    rendered: list[tuple[float, str]] = []

    class MutatingEngine:
        def render_dialogue_track(self, render_project, track, out, defaults):
            rendered.append(
                (render_project.clips[0].source_end, track_render_hash(render_project, track.id))
            )
            ProjectWorkspace(minimal_project, proj).mutate(
                "before cut",
                "after cut",
                lambda live: setattr(live.clips[0], "source_end", 0.5),
            )
            out.write_bytes(b"rendered from the snapshot")
            return out

    monkeypatch.setattr(steps, "ffmpeg", MutatingEngine)
    with pytest.raises(RuntimeError, match="project changed during stem rendering"):
        steps.assemble_timeline(proj, {"performance": {"max_workers": 2}})

    assert rendered == [(1.0, before_hash)]
    assert read_stem_hash(proj, "host") == before_hash
    assert track_render_hash(proj, "host") != before_hash
    assert not (proj.artifacts_dir() / "track_outputs.json").exists()


def test_stem_rejects_other_workspace_commit_during_render(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks = proj.tracks[:1]
    proj.clips = [
        Clip(
            id="host-clip",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    other = ProjectWorkspace.open(minimal_project)

    class MutatingEngine:
        def render_dialogue_track(self, _snapshot, _track, out, _defaults):
            other.mutate(
                "before cut",
                "after cut",
                lambda live: setattr(live.clips[0], "source_end", 0.5),
            )
            out.write_bytes(b"old audio")
            return out

    monkeypatch.setattr(steps, "ffmpeg", MutatingEngine)
    with pytest.raises(RuntimeError, match="project changed during stem rendering"):
        steps.assemble_timeline(proj, {"performance": {"max_workers": 2}})
    assert proj.clips[0].source_end == 1.0
    assert not (proj.artifacts_dir() / "track_outputs.json").exists()


def test_stem_allows_volume_saved_during_render(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks = proj.tracks[:1]
    proj.clips = [
        Clip(
            id="host-clip",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    other = ProjectWorkspace.open(minimal_project)

    class MutatingEngine:
        def render_dialogue_track(self, _snapshot, _track, out, _defaults):
            other.mutate(
                "before volume",
                "after volume",
                lambda live: setattr(live.track_by_id("host"), "fader_db", -6.0),
            )
            out.write_bytes(b"old audio")
            return out

    monkeypatch.setattr(steps, "ffmpeg", MutatingEngine)
    steps.assemble_timeline(proj, {"performance": {"max_workers": 2}})
    assert (proj.artifacts_dir() / "track_outputs.json").is_file()


def test_stem_rejects_unreadable_project_saved_during_render(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks = proj.tracks[:1]
    proj.clips = [
        Clip(
            id="host-clip",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)

    class CorruptingEngine:
        def render_dialogue_track(self, _snapshot, _track, out, _defaults):
            Path(minimal_project).write_text("{", encoding="utf-8")
            out.write_bytes(b"old audio")
            return out

    monkeypatch.setattr(steps, "ffmpeg", CorruptingEngine)
    with (
        caplog.at_level(logging.WARNING, logger="podcast_mcp.pipeline.steps"),
        pytest.raises(RuntimeError, match="project changed during stem rendering"),
    ):
        steps.assemble_timeline(proj, {"performance": {"max_workers": 2}})
    assert "saved project unreadable" in caplog.text
    assert not (proj.artifacts_dir() / "track_outputs.json").exists()


def test_stem_rejects_track_added_during_render(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks = proj.tracks[:1]

    class MutatingEngine:
        def render_dialogue_track(self, _snapshot, _track, out, _defaults):
            # Pipeline steps can change their in-memory project before commit.
            proj.tracks.append(
                Track(
                    id="late",
                    label="Late",
                    role=TrackRole.DIALOGUE,
                    media=MediaAsset(path="raw/host.wav"),
                )
            )
            out.write_bytes(b"old track set")
            return out

    monkeypatch.setattr(steps, "ffmpeg", MutatingEngine)
    with pytest.raises(RuntimeError, match="project changed during stem rendering"):
        steps.assemble_timeline(proj, {"performance": {"max_workers": 2}})
    assert not (proj.artifacts_dir() / "track_outputs.json").exists()


def test_export_deliverables_with_chapters(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.chapters = [ChapterMarker(time=0.0, title="Start")]
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    steps.master_loudness(proj, defaults)
    steps.export_deliverables(proj, defaults)
    assert (proj.export_dir() / f"{proj.name}.chapters.json").is_file()
    assert (proj.export_dir() / f"{proj.name}.srt").is_file()


def test_ingest_waveform_failure_tolerated(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    with patch(
        "podcast_mcp.pipeline.steps.ensure_project_waveforms",
        return_value=0,
    ):
        summary = steps.ingest_tracks(proj, load_defaults())
    assert proj.track_by_id("host").media.duration_sec
    assert "0 waveforms" in summary


def test_transcribe_tracks_mock(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    from podcast_mcp.transcript_context import TranscriptContext, load_transcript_context

    ctx = TranscriptContext(terms=["Kaczynski"], vocabulary_revision="revision-one")
    ctx.save(proj.workspace_path())
    mock_tr = MagicMock()
    mock_tr.track_id = "host"
    mock_tr.words = []
    with patch("podcast_mcp.pipeline.steps.TranscriptionEngine") as eng_cls:
        eng_cls.return_value.transcribe_all_dialogue.return_value = [mock_tr]
        steps.transcribe_tracks(proj, load_defaults())
        assert (
            eng_cls.return_value.transcribe_all_dialogue.call_args.kwargs["initial_prompt"]
            == "Kaczynski"
        )
    assert proj.transcripts
    assert mock_tr.vocabulary_revision == "revision-one"
    assert load_transcript_context(proj.workspace_path()).vocabulary_revision == "revision-one"


def test_transcribe_keeps_revision_stale_when_vocabulary_changes_during_run(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.transcript_context import TranscriptContext, load_transcript_context

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    TranscriptContext(terms=["Old"], vocabulary_revision="revision-one").save(proj.workspace_path())

    def transcribe(*_args, **_kwargs):
        TranscriptContext(terms=["New"], vocabulary_revision="revision-two").save(
            proj.workspace_path()
        )
        return []

    with patch("podcast_mcp.pipeline.steps.TranscriptionEngine") as eng_cls:
        eng_cls.return_value.transcribe_all_dialogue.side_effect = transcribe
        steps.transcribe_tracks(proj, load_defaults())

    ctx = load_transcript_context(proj.workspace_path())
    assert ctx.terms == ["New"]
    assert ctx.vocabulary_revision == "revision-two"
    assert all(t.vocabulary_revision is None for t in proj.transcripts)


def test_transcribe_records_started_revision_when_vocabulary_changes_during_run(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.models import Transcript
    from podcast_mcp.transcript_context import TranscriptContext, load_transcript_context

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    TranscriptContext(terms=["Old"], vocabulary_revision="revision-one").save(proj.workspace_path())

    def transcribe(*_args, **_kwargs):
        TranscriptContext(terms=["New"], vocabulary_revision="revision-two").save(
            proj.workspace_path()
        )
        return [Transcript(track_id="host", words=[])]

    with patch("podcast_mcp.pipeline.steps.TranscriptionEngine") as eng_cls:
        eng_cls.return_value.transcribe_all_dialogue.side_effect = transcribe
        steps.transcribe_tracks(proj, load_defaults())

    assert [t.vocabulary_revision for t in proj.transcripts if t.track_id == "host"] == [
        "revision-one"
    ]
    assert load_transcript_context(proj.workspace_path()).vocabulary_revision == "revision-two"


def test_transcribe_tracks_writes_timing_report(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import Transcript, TranscriptWord

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    stretched = Transcript(
        track_id="host",
        words=[TranscriptWord(text="don't", start=1.0, end=10.0)],
    )
    with patch("podcast_mcp.pipeline.steps.TranscriptionEngine") as eng_cls:
        eng_cls.return_value.transcribe_all_dialogue.return_value = [stretched]
        steps.transcribe_tracks(proj, load_defaults())
    timing = proj.artifacts_dir() / "transcript_timing.json"
    assert timing.is_file()
    data = json.loads(timing.read_text(encoding="utf-8"))
    assert data["flag_count"] == 1
    assert data["flags"][0]["reason"] == "anomalous_word_duration"
    assert data["flags"][0]["end"] == 10.0


def test_ingest_skips_track_without_media(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks.append(Track(id="empty", label="Empty", role=TrackRole.DIALOGUE, media=None))
    with patch("podcast_mcp.pipeline.steps.ffmpeg") as ff:
        steps.ingest_tracks(proj, load_defaults())
    probed_paths = [call.args[0].name for call in ff.return_value.probe.call_args_list]
    assert "host.wav" in probed_paths
    assert all("empty" not in str(p) for p in probed_paths)


def test_ingest_raises_when_media_missing(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.track_by_id("host").media.path = "raw/missing.wav"
    with pytest.raises(FileNotFoundError):
        steps.ingest_tracks(proj, load_defaults())


def test_clean_audio_skips_non_dialogue_and_existing_highpass(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="highpass", params={"frequency": 80})],
        )
    ]
    steps.clean_audio(proj, load_defaults())
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    assert len(chain.effects) == 1


def test_balance_tracks_skips_non_dialogue_and_none_loudness(
    minimal_project, sample_wav, tmp_workspace
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks[0].media = None
    proj.tracks.append(
        Track(
            id="music",
            label="Music",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    with patch.object(FFmpegEngine, "measure_loudness", return_value=None):
        steps.balance_tracks(proj, load_defaults())
    assert proj.track_by_id("host").gain_db == 0.0


def test_compress_tracks_skips_non_dialogue(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks = [t for t in proj.tracks if t.role != TrackRole.DIALOGUE]
    steps.compress_tracks(proj, load_defaults())
    assert not proj.processing_chains


def test_render_stems_skips_unsupported_role_and_no_media(
    minimal_project, sample_wav, tmp_workspace
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    ghost = Track(id="ghost", label="Ghost", role=TrackRole.DIALOGUE, media=None)
    ghost.role = "unknown"  # type: ignore[assignment]
    proj.tracks.append(ghost)
    with patch("podcast_mcp.pipeline.steps.ffmpeg") as ff:
        ff.return_value.render_dialogue_track = MagicMock()
        steps.render_dialogue_stems(proj, load_defaults())
    ff.return_value.render_dialogue_track.assert_called()


def test_mix_with_music_assembles_when_meta_missing(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    meta = proj.artifacts_dir() / "track_outputs.json"
    if meta.is_file():
        meta.unlink()
    steps.mix_with_music(proj, defaults)
    assert meta.is_file()
    assert (proj.artifacts_dir() / "premix.wav").is_file()


def test_mix_with_music_skips_muted_track(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.assemble_timeline(proj, defaults)
    proj.track_by_id("host").muted = True
    steps.mix_with_music(proj, defaults)
    assert (proj.artifacts_dir() / "premix.wav").is_file()


def test_master_loudness_mixes_when_no_premix(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    premix = proj.artifacts_dir() / "premix.wav"
    if premix.is_file():
        premix.unlink()
    steps.master_loudness(proj, defaults)
    assert (proj.artifacts_dir() / "mastered.wav").is_file()


def test_master_loudness_writes_qc_report(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.master_loudness(proj, defaults)
    qc_path = proj.artifacts_dir() / "master_qc.json"
    assert qc_path.is_file()
    qc = json.loads(qc_path.read_text(encoding="utf-8"))
    assert qc["target_integrated_lufs"] == -16.0
    assert qc["target_true_peak_db"] == -1.5
    assert "issues" in qc


def test_master_loudness_qc_flags_out_of_tolerance(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    with patch(
        "podcast_mcp.engines.ffmpeg.FFmpegEngine.measure_loudness_full",
        return_value={"integrated_lufs": -10.0, "true_peak_db": 0.0, "lra": 5.0},
    ):
        steps.master_loudness(proj, defaults)
    qc = json.loads((proj.artifacts_dir() / "master_qc.json").read_text(encoding="utf-8"))
    assert qc["within_tolerance"] is False
    assert len(qc["issues"]) == 2
    assert qc.get("crest_tame_af")


def test_master_loudness_skips_crest_tame_when_disabled(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    defaults = {**defaults, "master": {**defaults.get("master", {}), "crest_tame_af": ""}}
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    with (
        patch(
            "podcast_mcp.engines.ffmpeg.FFmpegEngine.measure_loudness_full",
            return_value={"integrated_lufs": -20.0, "true_peak_db": -1.5, "lra": 5.0},
        ),
        patch.object(FFmpegEngine, "filter_audio") as filter_audio,
    ):
        steps.master_loudness(proj, defaults)
    filter_audio.assert_not_called()
    qc = json.loads((proj.artifacts_dir() / "master_qc.json").read_text(encoding="utf-8"))
    assert qc["within_tolerance"] is False
    assert "crest_tame_af" not in qc


def test_export_deliverables_without_combined_transcript(
    minimal_project, sample_wav, tmp_workspace
):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.combined_transcript = None
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    steps.master_loudness(proj, defaults)
    steps.export_deliverables(proj, defaults)
    assert not (proj.export_dir() / f"{proj.name}.srt").is_file()


def test_utterances_to_srt_empty(minimal_project):
    from podcast_mcp.export.transcript import utterances_to_srt

    proj = load_project(minimal_project)
    proj.combined_transcript = None
    assert utterances_to_srt(proj) == ""


def test_analyze_focus_cuts_skips_outline_when_disabled(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = {**load_defaults(), "focus": {"enabled": False}}
    steps.analyze_focus_cuts(proj, defaults)
    assert not (proj.artifacts_dir() / "focus_outline.json").is_file()


def test_balance_tracks_absolute_path_and_none_measurement(
    minimal_project, sample_wav, tmp_workspace
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    host = proj.track_by_id("host")
    host.media.path = str((proj.workspace_path() / "raw" / "host.wav").resolve())
    with patch.object(FFmpegEngine, "measure_loudness", side_effect=[-22.0, None]):
        steps.balance_tracks(proj, load_defaults())
    assert host.gain_db != 0.0


def test_balance_tracks_skips_when_loudness_missing(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    with patch.object(FFmpegEngine, "measure_loudness", return_value=None):
        steps.balance_tracks(proj, load_defaults())
    assert proj.track_by_id("host").gain_db == 0.0


def test_render_stems_skips_track_without_media(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.track_by_id("bed").media = None
    with (
        patch("podcast_mcp.pipeline.steps.ffmpeg") as ff,
        patch("podcast_mcp.pipeline.steps.schedule_stem_waveforms") as waveforms,
    ):
        ff.return_value.render_dialogue_track = MagicMock()
        steps.assemble_timeline(proj, load_defaults())
    assert ff.return_value.render_dialogue_track.call_count == 1
    assert waveforms.call_args.args[1] == ["host"]


def test_mix_with_music_skips_music_without_media(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.track_by_id("bed").media = None
    defaults = load_defaults()
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    assert (proj.artifacts_dir() / "premix.wav").is_file()


def test_export_deliverables_creates_master_when_missing(
    minimal_project, sample_wav, tmp_workspace
):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    mastered = proj.artifacts_dir() / "mastered.wav"
    if mastered.is_file():
        mastered.unlink()
    steps.export_deliverables(proj, defaults)
    assert mastered.is_file()


def test_export_deliverables_remasters_after_a_remix(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    steps.master_loudness(proj, defaults)
    before = read_mastered_hash(proj)
    assert before is not None
    proj.track_by_id("host").fader_db = -6.0
    steps.export_deliverables(proj, defaults)
    assert premix_stale_vs_mix(proj) is False
    assert mastered_is_fresh(proj)
    assert read_mastered_hash(proj) != before


def test_export_deliverables_writes_qc_stale_warning(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    steps.master_loudness(proj, defaults)
    steps.export_deliverables(proj, defaults)
    qc = json.loads((proj.artifacts_dir() / "export_qc.json").read_text(encoding="utf-8"))
    assert qc["reconciliation"]["stale"] is True
    assert qc["ok"] is False
    assert any("reconciliation is stale" in issue.lower() for issue in qc["issues"])


def test_export_deliverables_writes_qc_ok_when_reconciled_and_within_tolerance(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    steps.master_loudness(proj, defaults)
    mark_reconciliation_fresh(proj)
    steps.export_deliverables(proj, defaults)
    qc = json.loads((proj.artifacts_dir() / "export_qc.json").read_text(encoding="utf-8"))
    assert qc["reconciliation"]["stale"] is False
    assert qc["ok"] is True
    assert qc["issues"] == []


def test_export_deliverables_qc_rolls_up_master_qc_issues(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    steps.master_loudness(proj, defaults)
    mark_reconciliation_fresh(proj)
    (proj.artifacts_dir() / "master_qc.json").write_text(
        json.dumps({"within_tolerance": False, "issues": ["True peak exceeds target"]}),
        encoding="utf-8",
    )
    steps.export_deliverables(proj, defaults)
    qc = json.loads((proj.artifacts_dir() / "export_qc.json").read_text(encoding="utf-8"))
    assert qc["ok"] is False
    assert "True peak exceeds target" in qc["issues"]
    assert qc["master_qc"]["within_tolerance"] is False


def test_write_export_qc_tolerates_corrupt_master_qc(minimal_project, tmp_workspace):
    from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh

    proj = load_project(minimal_project)
    mark_reconciliation_fresh(proj)
    (proj.artifacts_dir() / "master_qc.json").write_text("not json", encoding="utf-8")
    qc = steps.write_export_qc(proj)
    assert qc["master_qc"] is None
    assert qc["ok"] is True
    assert "timebase" in qc
    assert "tracks" in qc["timebase"]


def test_write_export_qc_timebase_issues(minimal_project, tmp_workspace):
    from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh
    from podcast_mcp.models import Clip, Transcript, TranscriptWord

    proj = load_project(minimal_project)
    mark_reconciliation_fresh(proj)
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=60.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=90.0,
            source_end=200.0,
            timeline_start=60.0,
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="gap", start=70.0, end=72.0)],
        )
    ]
    qc = steps.write_export_qc(proj)
    assert qc["timebase"]["ok"] is False
    assert not qc["ok"]


def test_ingest_tracks_resolves_relative_media_path(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    host = proj.track_by_id("host")
    host.media.path = str((proj.workspace_path() / "raw" / "host.wav").resolve())
    with patch("podcast_mcp.pipeline.steps.ensure_project_waveforms", return_value=0):
        steps.ingest_tracks(proj, load_defaults())
    assert host.media.duration_sec is not None


def test_transcribe_tracks_keeps_old_revision_on_rows_not_rerun(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.models import Transcript
    from podcast_mcp.transcript_context import TranscriptContext

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.transcripts = [Transcript(track_id="guest", words=[], vocabulary_revision="revision-zero")]
    TranscriptContext(terms=["New"], vocabulary_revision="revision-one").save(proj.workspace_path())
    with patch("podcast_mcp.pipeline.steps.TranscriptionEngine") as eng_cls:
        eng_cls.return_value.transcribe_all_dialogue.return_value = [
            Transcript(track_id="host", words=[])
        ]
        steps.transcribe_tracks(proj, load_defaults())
    revisions = {t.track_id: t.vocabulary_revision for t in proj.transcripts}
    assert revisions == {"guest": "revision-zero", "host": "revision-one"}
