from __future__ import annotations

import json
import threading
from unittest.mock import MagicMock, patch

from podcast_mcp.models import CombinedTranscript, CombinedUtterance, Transcript, TranscriptWord
from podcast_mcp.services import (
    ClipService,
    EditService,
    EpisodeService,
    HistoryService,
    PipelineService,
    ProjectWorkspace,
    SpeakerService,
    TranscriptPrecorrectService,
    TranscriptService,
)


def test_edit_service_list_applied_and_render_status(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    svc = EditService(ws)
    applied = svc.list_applied_edits(track_id="host", timeline_start=0.0, timeline_end=1.0)
    assert applied["count"] == 0
    status = svc.render_status()
    assert "needs_rerender" in status


def test_edit_service_search_and_impact(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=2.0,
                text="hello world",
            )
        ]
    )
    matches = EditService(ws).search("world")
    assert matches
    report = EditService(ws).impact_report()
    assert "total_removed_sec" in report
    md = EditService(ws).impact_report(markdown=True)
    assert isinstance(md, str)
    assert "Edit impact" in md


def test_clip_service_propose(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=20.0,
                text="Why is this a great clip for social media?",
            )
        ]
    )
    clips = ClipService(ws).propose(max_clips=3)
    assert len(clips) >= 1


def test_history_service_list(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.record_snapshot("test", force=True)
    data = HistoryService(ws).list_entries()
    assert "entries" in data
    assert "groups" in data


def test_history_service_status_goto_diff_undo(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.record_snapshot("one", force=True)
    ws.record_snapshot("two", force=True)
    svc = HistoryService(ws)
    status = svc.status()
    assert "cursor" in status
    listing = svc.list_entries()
    assert listing["groups"]
    goto = svc.goto(0)
    assert goto["cursor"] == 0
    ws.record_snapshot("three", force=True)
    undo = svc.undo()
    assert "can_redo" in undo
    reloaded = ProjectWorkspace.open(minimal_project)
    assert reloaded.project.reconciliation_stale is True
    diff = svc.diff(from_index=0, to_index=1)
    assert "diff" in diff
    assert "summary" in diff
    assert isinstance(diff["summary"], list)


def test_history_goto_invalidates_stem_hashes(minimal_project, sample_wav) -> None:
    from podcast_mcp.engines.play_audit import (
        invalidate_stem_hashes,
        stem_hash_path,
        write_stem_hash,
    )
    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, save_project

    ws = ProjectWorkspace.open(minimal_project)
    proj = ws.project
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    stem_dir = ws.project.artifacts_dir() / "tracks"
    stem_dir.mkdir(parents=True, exist_ok=True)
    (stem_dir / "host.wav").write_bytes(sample_wav.read_bytes())
    write_stem_hash(ws.project, "host")
    assert stem_hash_path(ws.project, "host").is_file()
    ws.record_snapshot("a", force=True)
    ws.record_snapshot("b", force=True)
    HistoryService(ws).goto(0)
    assert not stem_hash_path(ws.project, "host").is_file()
    # helper still works on empty
    assert invalidate_stem_hashes(ws.project) == []


def test_history_service_mutation_groups_and_rerender(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    EditService(ws).ripple_delete(0.0, 0.1)
    groups = HistoryService(ws).list_entries()["groups"]
    mut = next(g for g in groups if g.get("kind") == "mutation")
    assert mut.get("title")
    assert "ripple" in mut["title"].lower()
    with (
        patch("podcast_mcp.services.history.rerender_preview"),
        patch(
            "podcast_mcp.services.history.render_preview_result",
            return_value='{"ok": true}',
        ),
    ):
        out = HistoryService(ws).undo(rerender=True)
    assert "preview" in out
    with (
        patch("podcast_mcp.services.history.rerender_preview"),
        patch(
            "podcast_mcp.services.history.render_preview_result",
            return_value='{"ok": true}',
        ),
    ):
        out = HistoryService(ws).redo(rerender=True)
    assert "preview" in out


def test_history_goto_rerender_flag(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    ws.record_snapshot("one", force=True)
    ws.record_snapshot("two", force=True)
    with (
        patch("podcast_mcp.services.history.rerender_preview") as rr,
        patch(
            "podcast_mcp.services.history.render_preview_result",
            return_value='{"ok": true}',
        ),
    ):
        out = HistoryService(ws).goto(0, rerender=True)
    rr.assert_called_once()
    assert out["cursor"] == 0
    assert "preview" in out


def test_transcript_service_get_formats(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=0.5)],
        )
    ]
    svc = TranscriptService(ws)
    assert '"hi"' in svc.get(combined=False)
    assert "0.0" in svc.get(format="timestamps")


def test_transcript_service_resolves_model_for_standalone_transcribe(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    with (
        patch(
            "podcast_mcp.services.transcript.resolve_whisper_model",
            return_value="base.en",
        ) as resolve,
        patch("podcast_mcp.services.transcript.TranscriptionEngine") as engine,
    ):
        TranscriptService(ws, model="base.en")

    resolve.assert_called_once_with(requested="base.en")
    engine.assert_called_once_with("base.en")


def test_transcript_service_export_subtitles(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="line one",
            )
        ]
    )
    srt = TranscriptService(ws).export_subtitles("srt")
    vtt = TranscriptService(ws).export_subtitles("vtt")
    assert srt.suffix == ".srt"
    assert vtt.suffix == ".vtt"
    assert "line one" in srt.read_text(encoding="utf-8")


def test_transcript_service_transcribe_all_and_combined_get(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    from podcast_mcp.models import Transcript, TranscriptWord

    with patch("podcast_mcp.services.transcript.TranscriptionEngine") as eng_cls:
        eng_cls.return_value.transcribe_all_dialogue.return_value = [
            Transcript(
                track_id="host",
                words=[TranscriptWord(text="hi", start=0.0, end=0.5)],
            )
        ]
        ids = TranscriptService(ws).transcribe()
    assert ids == ["host"]
    body = TranscriptService(ws).get(combined=True)
    assert "hi" in body


def test_transcript_service_export_markdown_and_vtt(minimal_project):
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance

    ws = ProjectWorkspace.open(minimal_project)
    combined = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="line",
            )
        ]
    )
    ws.project.transcripts = []
    with patch(
        "podcast_mcp.services.transcript.TranscriptionEngine.merge_transcripts",
        return_value=combined,
    ):
        path = TranscriptService(ws).export_markdown()
        vtt = TranscriptService(ws).export_subtitles("vtt")
    assert path.suffix == ".md"
    assert vtt.suffix == ".vtt"


def test_transcript_precorrect_service_dry_run(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    result = TranscriptPrecorrectService(ws).precorrect(dry_run=True)
    assert isinstance(result, dict)


def test_pipeline_service_set_envelope(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    n = PipelineService(ws).set_envelope(
        "host",
        [{"time": 0.0, "value": 0.0}, {"time": 5.0, "value": -6.0}],
    )
    assert n == 2
    assert ws.project.automation_envelopes[0].track_id == "host"


def test_speaker_service_doctor_and_profiles(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    doc = SpeakerService(ws).doctor()
    assert "available_backends" in doc
    assert SpeakerService.doctor_static() == doc
    assert SpeakerService(ws).profiles() == []


def test_speaker_service_score_error(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    with patch("podcast_mcp.services.speaker.score_window", return_value=None):
        result = SpeakerService(ws).score("host", 0.0, 1.0)
    assert result["error"] == "could not score window"


def test_episode_service_add_track(minimal_project, sample_wav, tmp_path):
    ws = ProjectWorkspace.open(minimal_project)
    msg = EpisodeService(ws).add_track("guest", str(sample_wav), speaker="Guest")
    assert "guest" in msg
    track = ws.project.track_by_id("guest")
    assert track is not None
    assert track.media is not None
    assert track.media.duration_sec is not None and track.media.duration_sec > 0
    clips = [c for c in ws.project.clips if c.track_id == "guest"]
    assert len(clips) == 1
    assert clips[0].source_start == 0.0
    assert clips[0].source_end == track.media.duration_sec
    from podcast_mcp.engines.peaks import wait_peaks_jobs

    wait_peaks_jobs()
    peaks_path = ws.project.artifacts_dir() / "peaks" / "guest.json"
    assert peaks_path.is_file()


def test_episode_service_add_track_returns_before_peaks(minimal_project, sample_wav):
    from unittest.mock import patch

    from podcast_mcp.engines.peaks import wait_peaks_jobs

    ws = ProjectWorkspace.open(minimal_project)
    release = threading.Event()
    started = threading.Event()

    def _gated_generate(audio_path, output_json, samples_per_pixel=None):
        started.set()
        assert release.wait(timeout=5.0)
        output_json.parent.mkdir(parents=True, exist_ok=True)
        output_json.write_text("{}", encoding="utf-8")
        return output_json

    with patch("podcast_mcp.engines.peaks.generate_peaks", side_effect=_gated_generate):
        EpisodeService(ws).add_track("slow", str(sample_wav), speaker="Slow")
        assert started.wait(timeout=5.0)
        assert not release.is_set()
        release.set()
        wait_peaks_jobs()
        assert started.is_set()


def test_episode_service_empty_set_meta_remove(minimal_project, sample_wav):
    from podcast_mcp.edits.clips_ops import clips_for_track

    ws = ProjectWorkspace.open(minimal_project)
    svc = EpisodeService(ws)
    out = svc.add_empty_track("narrator", label="Narrator", speaker="Narrator")
    assert out["track_id"] == "narrator"
    assert ws.project.track_by_id("narrator").media is None
    assert clips_for_track(ws.project, "narrator") == []

    media = svc.set_track_media("narrator", str(sample_wav))
    assert media["duration_sec"] and media["duration_sec"] > 0
    assert len(clips_for_track(ws.project, "narrator")) == 1
    from podcast_mcp.engines.peaks import wait_peaks_jobs

    wait_peaks_jobs()
    peaks = ws.project.artifacts_dir() / "peaks" / "narrator.json"
    assert peaks.is_file()
    payload = json.loads(peaks.read_text(encoding="utf-8"))
    assert isinstance(payload.get("peaks"), list)
    assert payload["peaks"]

    meta = svc.set_track_meta("narrator", label="Voiceover", role="sfx")
    assert meta["label"] == "Voiceover"
    assert meta["role"] == "sfx"

    removed = svc.remove_track("narrator")
    assert removed["removed"] is True
    assert ws.project.track_by_id("narrator") is None
    assert clips_for_track(ws.project, "narrator") == []


def test_episode_service_reorder_track(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    svc = EpisodeService(ws)
    svc.add_empty_track("a", label="A")
    svc.add_empty_track("b", label="B")
    svc.add_empty_track("c", label="C")
    assert [t.id for t in ws.project.tracks] == ["a", "b", "c"]

    out = svc.reorder_track("c", 0)
    assert out == {"track_id": "c", "index": 0, "track_ids": ["c", "a", "b"]}

    out = svc.reorder_track("b", 1)
    assert out["track_ids"] == ["c", "b", "a"]
    assert out["index"] == 1

    out = svc.reorder_track("a", 99)
    assert out["track_ids"] == ["c", "b", "a"]
    assert out["index"] == 2


def test_episode_service_add_empty_duplicate_raises(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    svc = EpisodeService(ws)
    svc.add_empty_track("solo")
    try:
        svc.add_empty_track("solo")
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "already exists" in str(exc)


def test_pipeline_service_render_preview_no_rerender(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    info = PipelineService(ws).render_preview(rerender=False)
    assert info["ok"] is False


def test_pipeline_service_export_audio_creates_master(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import MediaAsset, Track, TrackRole, save_project

    ws = ProjectWorkspace.open(minimal_project)
    raw = ws.project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    wav = raw / "host.wav"
    wav.write_bytes(sample_wav.read_bytes())
    ws.project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    premix = ws.project.artifacts_dir() / "premix.wav"
    mastered = ws.project.artifacts_dir() / "mastered.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())

    def _master(project, defaults):
        mastered.write_bytes(sample_wav.read_bytes())

    with (
        patch(
            "podcast_mcp.services.pipeline.pipeline_steps.master_loudness",
            side_effect=_master,
        ),
        patch("podcast_mcp.export.audio.export_episode_audio") as export,
    ):
        export.return_value = [ws.project.export_dir() / "demo.mp3"]
        paths = PipelineService(ws).export_audio([{"ext": "mp3"}])
    assert paths
    assert mastered.is_file()
    export.assert_called_once()


def test_pipeline_service_export_audio_emits_progress(minimal_project):
    from podcast_mcp.util.progress import RecordingProgress, bind_progress

    ws = ProjectWorkspace.open(minimal_project)
    mastered = ws.project.artifacts_dir() / "mastered.wav"
    mastered.parent.mkdir(parents=True, exist_ok=True)
    mastered.write_bytes(b"RIFF")
    rec = RecordingProgress()
    with (
        patch(
            "podcast_mcp.export.audio.export_episode_audio",
            return_value=[ws.project.export_dir() / "demo.wav"],
        ),
        bind_progress(rec),
    ):
        PipelineService(ws).export_audio()
    assert any(e.task_id == "export" and e.kind == "start" for e in rec.events)
    assert any(e.phase == "encode" for e in rec.events)


def test_pipeline_service_render_final(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    with patch("podcast_mcp.services.pipeline.PipelineRunner") as runner:
        runner.return_value.run = MagicMock()
        out = PipelineService(ws).render_final()
    assert out == ws.project.export_dir()
