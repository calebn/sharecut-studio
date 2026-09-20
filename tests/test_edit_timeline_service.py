from __future__ import annotations

from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services import EditService, ProjectWorkspace


def _ws_with_audio(tmp_path, sample_wav) -> ProjectWorkspace:
    ws_dir = tmp_path / "ep"
    raw = ws_dir / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    p = EpisodeProject.create("tl_svc", str(ws_dir))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="full",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=0.5, confidence=0.5)],
        )
    ]
    p.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=0.5,
                text="hi",
            )
        ]
    )
    from podcast_mcp.models import save_project

    save_project(p, ws_dir / "episode.project.json")
    return ProjectWorkspace.open(ws_dir / "episode.project.json")


def test_edit_service_timeline_and_transcript(tmp_path, sample_wav) -> None:
    ws = _ws_with_audio(tmp_path, sample_wav)
    svc = EditService(ws)

    # List before timeline ops - later remaps may drop words depending on cut opts.
    low = svc.low_confidence_words(0.8)
    assert low

    r = svc.ripple_delete(0.5, 1.0)
    assert r["operation"] == "ripple_delete"

    svc.insert_gap(1.0, 0.5)
    faded = svc.fade_joins(dry_run=True)
    assert faded["operation"] == "fade_joins"
    applied = svc.fade_joins(fade_ms=10)
    assert applied["operation"] == "fade_joins"
    cross = svc.crossfade_joins(fade_ms=25)
    assert cross["operation"] == "crossfade_joins"
    clips = svc.list_clips(track_id="host")
    clip_id = clips["tracks"]["host"][0]["id"]
    joined = svc.set_join_mode(clip_id, "fade")
    assert joined["operation"] == "set_clip_join_mode"
    svc.add_chapter(0.0, "Intro")
    assert svc.list_chapters()
    assert svc.remove_chapter("Intro")["removed"] is True
    assert svc.list_chapters() == []
    if ws.project.transcripts and ws.project.transcripts[0].words:
        svc.correct_word("host", 0, "hello")
    svc.add_effect(speaker="Host", preset="gate")
    fx = svc.list_effects(speaker="Host")
    assert fx["effects"]
    svc.remove_effect(speaker="Host", effect="agate")
