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
from podcast_mcp.pipeline.runner import PipelineRunner
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.project_state import project_state_lock


def _blocks(value: float) -> list[tuple[float, float]]:
    return [(0.1 * i, value) for i in range(1, 61)]


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


def test_mix_with_music_hashes_the_faded_music_stem(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.engines.play_audit import read_stem_hash, track_render_hash

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    steps.mix_with_music(proj, defaults)
    envelope = proj.volume_envelope_for("bed")
    assert envelope is not None and len(envelope.points) == 4
    assert read_stem_hash(proj, "bed") == track_render_hash(proj, "bed")
    envelope.points[1].value = 0.5
    assert read_stem_hash(proj, "bed") != track_render_hash(proj, "bed")


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


def test_runner_stem_step_rejects_live_in_memory_edit_during_render(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks = proj.tracks[:1]
    proj.clips = [
        Clip(id="host-clip", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0)
    ]

    class MutatingEngine:
        def render_dialogue_track(self, _snapshot, _track, out, _defaults):
            # Uncommitted edit to the live project while the step renders its private copy.
            with project_state_lock(proj):
                proj.clips[0].source_end = 0.5
            out.write_bytes(b"old cut")
            return out

    monkeypatch.setattr(steps, "ffmpeg", MutatingEngine)
    monkeypatch.setattr(steps, "schedule_stem_waveforms", lambda *_a, **_k: None)
    with pytest.raises(RuntimeError, match="project changed during stem rendering"):
        PipelineRunner(defaults={"performance": {"max_workers": 2}}).run(
            proj, only_step="assemble_timeline"
        )
    assert proj.clips[0].source_end == 0.5
    assert not (proj.artifacts_dir() / "track_outputs.json").exists()
    assert proj.pipeline_runs[-1].steps[-1].status == "error"


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
    with patch.object(FFmpegEngine, "measure_loudness_blocks", return_value=[]):
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
        ff.return_value.render_dialogue_track = MagicMock(
            side_effect=lambda _p, _t, out, _d: out.write_bytes(b"RIFF") or out
        )
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
    assert qc["normalization_type"] in {"linear", "dynamic", None}


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
    with patch.object(FFmpegEngine, "measure_loudness_blocks", side_effect=[_blocks(-22.0)]):
        steps.balance_tracks(proj, load_defaults())
    assert host.gain_db != 0.0


def test_balance_tracks_skips_when_loudness_missing(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    with patch.object(FFmpegEngine, "measure_loudness_blocks", return_value=[]):
        steps.balance_tracks(proj, load_defaults())
    assert proj.track_by_id("host").gain_db == 0.0


def test_render_stems_skips_track_without_media(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.track_by_id("bed").media = None
    with (
        patch("podcast_mcp.pipeline.steps.ffmpeg") as ff,
        patch("podcast_mcp.pipeline.steps.schedule_stem_waveforms") as waveforms,
    ):
        ff.return_value.render_dialogue_track = MagicMock(
            side_effect=lambda _p, _t, out, _d: out.write_bytes(b"RIFF") or out
        )
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


def _asr_result():
    from podcast_mcp.models import Transcript, TranscriptWord

    return Transcript(track_id="", words=[TranscriptWord(text="teh", start=0.0, end=0.5)])


def test_transcribe_tracks_second_run_reuses_and_keeps_corrections(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.engines import TranscriptionEngine as Engine

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    with patch.object(Engine, "transcribe_file", return_value=_asr_result()):
        first = steps.transcribe_tracks(proj, load_defaults())
    assert "1 transcribed, 0 reused" in first
    assert proj.transcripts[0].audio_sha256
    assert proj.transcripts[0].audio_size == (tmp_workspace / "raw" / "host.wav").stat().st_size
    proj.transcripts[0].words[0].text = "the"
    with patch("podcast_mcp.pipeline.steps.TranscriptionEngine") as eng_cls:
        second = steps.transcribe_tracks(proj, load_defaults())
    eng_cls.assert_not_called()
    assert "0 transcribed, 1 reused" in second
    assert proj.transcripts[0].words[0].text == "the"


def test_transcribe_tracks_honours_legacy_cache(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.engines import TranscriptionEngine as Engine
    from podcast_mcp.engines.transcribe import legacy_cache_path
    from podcast_mcp.models import Transcript, TranscriptWord
    from podcast_mcp.util.hashing import sha256_file

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    legacy = legacy_cache_path(proj, "host", sha256_file(tmp_workspace / "raw" / "host.wav"))
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text(
        Transcript(
            track_id="host", words=[TranscriptWord(text="old", start=0, end=0.5)]
        ).model_dump_json(),
        encoding="utf-8",
    )
    with patch.object(Engine, "transcribe_file") as asr:
        steps.transcribe_tracks(proj, load_defaults())
    asr.assert_not_called()
    assert proj.transcripts[0].words[0].text == "old"


def test_transcribe_tracks_force_bypasses_asr_cache(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.engines import TranscriptionEngine as Engine
    from podcast_mcp.services.pipeline_config import transcribe_run_config

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    with patch.object(Engine, "transcribe_file", side_effect=lambda *a, **k: _asr_result()) as asr:
        steps.transcribe_tracks(proj, load_defaults())
        assert any(proj.transcripts_dir().glob("host_*.json"))
        summary = steps.transcribe_tracks(proj, transcribe_run_config(None, force=True))
    assert asr.call_count == 2
    assert "1 transcribed, 0 reused" in summary


def test_transcribe_tracks_confirmed_overwrite_replaces_edited_in_batch(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.engines import TranscriptionEngine as Engine
    from podcast_mcp.services.pipeline_config import transcribe_run_config

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    _edited_stale_transcript(proj)
    defaults = {
        **transcribe_run_config(None, force=True, overwrite_edited=True),
        "_pipeline_unattended": True,
    }
    with patch.object(Engine, "transcribe_file", return_value=_asr_result()):
        summary = steps.transcribe_tracks(proj, defaults)
    assert "1 edited overwritten" in summary
    assert proj.transcripts[0].words[0].text == "teh"


def _edited_stale_transcript(proj):
    from podcast_mcp.models import Transcript, TranscriptWord

    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="mine", start=0, end=0.5)],
            audio_sha256="0" * 64,
            user_edited=True,
        )
    ]


def test_transcribe_tracks_refuses_edited_overwrite_unattended(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.edits.transcript_reuse import TranscriptOverwriteRefused

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    _edited_stale_transcript(proj)
    defaults = {**load_defaults(), "_pipeline_unattended": True}
    with patch("podcast_mcp.pipeline.steps.TranscriptionEngine") as eng_cls:
        with pytest.raises(TranscriptOverwriteRefused):
            steps.transcribe_tracks(proj, defaults)
    eng_cls.assert_not_called()
    assert proj.transcripts[0].words[0].text == "mine"


def test_transcribe_tracks_attended_overwrite_warns(
    minimal_project, sample_wav, tmp_workspace, caplog, monkeypatch
):
    from podcast_mcp.engines import TranscriptionEngine as Engine

    monkeypatch.delenv("PODCAST_BATCH", raising=False)
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    _edited_stale_transcript(proj)
    with (
        patch.object(Engine, "transcribe_file", return_value=_asr_result()),
        caplog.at_level("WARNING"),
    ):
        summary = steps.transcribe_tracks(proj, load_defaults())
    assert "1 edited overwritten" in summary
    assert "overwrites edited transcript" in caplog.text
    assert proj.transcripts[0].words[0].text == "teh"


def _words_project(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import Transcript, TranscriptWord

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    words = [TranscriptWord(text=f"w{i}", start=1.0 + i, end=2.0 + i) for i in range(5)]
    words.append(TranscriptWord(text="bleed", start=10.0, end=15.0, suppressed=True))
    proj.transcript_data.per_track = [Transcript(track_id="host", words=words)]
    return proj


def test_balance_measures_through_the_track_chain(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(effect="highpass", params={"frequency": 80}),
                ProcessingEffect(effect="acompressor", params={"threshold_db": -20, "ratio": 3}),
            ],
        )
    ]
    with patch.object(
        FFmpegEngine, "measure_loudness_blocks", return_value=_blocks(-20.0)
    ) as measure:
        steps.balance_tracks(proj, load_defaults())
    af = measure.call_args[0][1]
    assert "highpass=f=" in af and "acompressor=" in af


def test_balance_gates_to_own_non_suppressed_words(minimal_project, sample_wav, tmp_workspace):
    proj = _words_project(minimal_project, sample_wav, tmp_workspace)
    blocks = (
        [(1.2 + 0.1 * i, -20.0) for i in range(50)]
        + [(10.2 + 0.1 * i, -30.0) for i in range(50)]
        + [(20.0 + 0.1 * i, -60.0) for i in range(50)]
    )
    with patch.object(FFmpegEngine, "measure_loudness_blocks", return_value=blocks):
        summary = steps.balance_tracks(proj, {"balance": {"dialogue_lufs": -20.0}})
    assert proj.track_by_id("host").gain_db == 0.0
    assert "speech-gated" in summary
    assert "host -20 LUFS (+0.0 dB)" in summary


def test_balance_reports_ungated_without_a_transcript(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    with patch.object(FFmpegEngine, "measure_loudness_blocks", return_value=_blocks(-24.0)):
        summary = steps.balance_tracks(proj, {"balance": {"dialogue_lufs": -20.0}})
    assert "ungated" in summary


def test_balance_keeps_gain_and_names_an_unmeasured_track(
    minimal_project, sample_wav, tmp_workspace
):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.track_by_id("host").gain_db = 4.0
    with patch.object(FFmpegEngine, "measure_loudness_blocks", return_value=[]):
        summary = steps.balance_tracks(proj, {"balance": {"dialogue_lufs": -20.0}})
    assert proj.track_by_id("host").gain_db == 4.0
    assert "not measured, gain kept: host" in summary


def test_balance_cancel_midway_changes_no_gain(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.util.progress import CancelledProgress

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    proj.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    with (
        patch.object(
            FFmpegEngine,
            "measure_loudness_blocks",
            side_effect=[_blocks(-26.0), CancelledProgress()],
        ),
        pytest.raises(CancelledProgress),
    ):
        steps.balance_tracks(proj, {"balance": {"dialogue_lufs": -20.0}})
    assert proj.track_by_id("host").gain_db == 0.0
    assert proj.track_by_id("guest").gain_db == 0.0


def test_balance_gates_to_words_the_clips_keep(minimal_project, sample_wav, tmp_workspace):
    proj = _words_project(minimal_project, sample_wav, tmp_workspace)  # words 1.0-6.0
    proj.clips = [
        Clip(id="c_host", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0)
    ]
    blocks = [(1.5 + 0.1 * i, -20.0) for i in range(30)] + [
        (5.5 + 0.1 * i, -30.0) for i in range(10)
    ]
    with patch.object(FFmpegEngine, "measure_loudness_blocks", return_value=blocks):
        summary = steps.balance_tracks(proj, {"balance": {"dialogue_lufs": -20.0}})
    assert proj.track_by_id("host").gain_db == 0.0  # the cut -30 LUFS words don't count
    assert "speech-gated" in summary


def test_balance_keeps_gain_when_every_word_is_cut(minimal_project, sample_wav, tmp_workspace):
    proj = _words_project(minimal_project, sample_wav, tmp_workspace)  # words 1.0-6.0
    proj.track_by_id("host").gain_db = 3.0
    proj.clips = [
        Clip(id="c_host", track_id="host", source_start=20.0, source_end=30.0, timeline_start=0.0)
    ]
    with patch.object(
        FFmpegEngine, "measure_loudness_blocks", return_value=_blocks(-30.0)
    ) as measure:
        summary = steps.balance_tracks(proj, {"balance": {"dialogue_lufs": -20.0}})
    measure.assert_not_called()
    assert proj.track_by_id("host").gain_db == 3.0
    assert "not measured, gain kept: host" in summary
    assert "speech-gated" not in summary
