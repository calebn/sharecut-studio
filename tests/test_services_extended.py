from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange
from podcast_mcp.edits.transcript_cuts import TranscriptMatch
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.play import PlayRequest, PlayService
from podcast_mcp.services.workspace import ProjectWorkspace


def _dialogue_workspace(
    project_path: Path,
    sample_wav: Path,
    *,
    track_id: str = "host",
    utterance_text: str = "hello podcast world",
) -> ProjectWorkspace:
    proj = load_project(project_path)
    raw = proj.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / f"{track_id}.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id=track_id,
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=2.0),
        )
    ]
    proj.clips = [
        Clip(
            id="full",
            track_id=track_id,
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    proj.transcripts = [
        Transcript(
            track_id=track_id,
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.4, confidence=0.9),
                TranscriptWord(text="podcast", start=0.5, end=1.0, confidence=0.9),
                TranscriptWord(text="world", start=1.1, end=1.6, confidence=0.9),
            ],
        )
    ]
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id=track_id,
                speaker="Host",
                start=0.0,
                end=1.6,
                text=utterance_text,
            )
        ]
    )
    save_project(proj, project_path)
    return ProjectWorkspace.open(project_path)


# --- PlayService ---


def test_play_resolve_search_processed(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    svc = PlayService(ws)
    seg_out = ws.project.artifacts_dir() / "seg.wav"
    with patch(
        "podcast_mcp.services.play.render_track_segment",
        return_value=seg_out,
    ):
        seg_out.touch()
        result = svc.play(
            PlayRequest(
                source="processed:host",
                start_sec=0.0,
                end_sec=1.0,
                query="podcast",
            ),
            dry_run=True,
        )
    assert result.source_label == "processed:host"
    assert result.start_sec == pytest.approx(0.0)
    assert result.end_sec == pytest.approx(2.6)


def test_play_search_raw_uses_track_source(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    svc = PlayService(ws)
    mock_extract = MagicMock(side_effect=lambda _src, out, *_a: out.touch() or out)
    with patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls:
        eng_cls.return_value.extract_segment = mock_extract
        result = svc.play(
            PlayRequest(
                source="processed:host",
                start_sec=0.0,
                end_sec=1.0,
                query="podcast",
                raw=True,
            ),
            dry_run=True,
        )
    assert result.source_label == "track:host"
    assert result.tier == "raw"


def test_play_search_premix_source(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())
    mock_extract = MagicMock(side_effect=lambda _src, out, *_a: out.touch() or out)
    with patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls:
        eng_cls.return_value.extract_segment = mock_extract
        result = PlayService(ws).play(
            PlayRequest(
                source="premix",
                start_sec=0.0,
                end_sec=1.0,
                query="world",
                padding_sec=0.2,
            ),
            dry_run=True,
        )
    assert result.source_label == "premix"
    assert result.tier == "premix"


def test_play_search_no_match_raises(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="no transcript match"):
        PlayService(ws).play(
            PlayRequest(source="processed:host", start_sec=0.0, end_sec=1.0, query="zzz"),
            dry_run=True,
        )


def test_play_search_bad_index_raises(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="match index"):
        PlayService(ws).play(
            PlayRequest(
                source="processed:host",
                start_sec=0.0,
                end_sec=1.0,
                query="hello",
                match_index=5,
            ),
            dry_run=True,
        )


def test_play_invalid_time_range_raises(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="end must be after start"):
        PlayService(ws).play(
            PlayRequest(source="track:host", start_sec=2.0, end_sec=1.0),
            dry_run=True,
        )


def test_play_premix_rerender(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    premix = ws.project.artifacts_dir() / "premix.wav"
    mock_extract = MagicMock(side_effect=lambda _src, out, *_a: out.touch() or out)
    with (
        patch("podcast_mcp.services.play.rerender_preview") as rerender,
        patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls,
    ):
        rerender.side_effect = lambda _p: premix.write_bytes(sample_wav.read_bytes())
        eng_cls.return_value.extract_segment = mock_extract
        result = PlayService(ws).play(
            PlayRequest(source="premix", start_sec=0.0, end_sec=0.5, rerender=True),
            dry_run=True,
        )
    rerender.assert_called_once()
    assert result.tier == "premix"


def test_play_export_source(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    export_dir = ws.project.export_dir()
    export_dir.mkdir(parents=True, exist_ok=True)
    (export_dir / "master.wav").write_bytes(sample_wav.read_bytes())
    mock_extract = MagicMock(side_effect=lambda _src, out, *_a: out.touch() or out)
    with patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls:
        eng_cls.return_value.extract_segment = mock_extract
        result = PlayService(ws).play(
            PlayRequest(source="export", start_sec=0.0, end_sec=0.5),
            dry_run=True,
        )
    assert result.tier == "export"


def test_play_compare_dry_run(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())
    seg_out = ws.project.artifacts_dir() / "seg.wav"
    mock_extract = MagicMock(side_effect=lambda _src, out, *_a: out.touch() or out)
    with (
        patch(
            "podcast_mcp.services.play.render_track_segment",
            return_value=seg_out,
        ),
        patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls,
    ):
        seg_out.touch()
        eng_cls.return_value.extract_segment = mock_extract
        result = PlayService(ws).play(
            PlayRequest(
                source="premix",
                start_sec=0.0,
                end_sec=0.5,
                compare=True,
            ),
            dry_run=True,
        )
    assert result.tier == "compare"
    assert result.compare_segments
    sources = {s["source"] for s in result.compare_segments}
    assert "track:host" in sources
    assert "premix" in sources


def test_play_compare_requires_dialogue(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="compare requires dialogue"):
        PlayService(ws).play(
            PlayRequest(source="premix", start_sec=0.0, end_sec=1.0, compare=True),
            dry_run=True,
        )


def test_play_follow_transcript_track(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    seg_out = ws.project.artifacts_dir() / "seg.wav"
    ws.project.artifacts_dir() / "gated.wav"
    with (
        patch(
            "podcast_mcp.services.play.render_track_segment",
            return_value=seg_out,
        ),
        patch(
            "podcast_mcp.services.play.render_gated_track",
            side_effect=lambda _seg, _iv, out, **_kw: out.touch() or None,
        ),
        patch(
            "podcast_mcp.services.play.word_intervals",
            return_value=[(0.0, 0.4), (0.5, 1.0)],
        ),
    ):
        seg_out.touch()
        result = PlayService(ws).play(
            PlayRequest(
                source="processed:host",
                start_sec=0.0,
                end_sec=1.0,
                follow_transcript=True,
            ),
            dry_run=True,
        )
    assert result.tier == "transcript_gated"
    assert "follow-transcript:processed:host" in result.source_label


def test_play_follow_transcript_mix(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    seg_out = ws.project.artifacts_dir() / "seg.wav"
    with (
        patch(
            "podcast_mcp.services.play.render_track_segment",
            return_value=seg_out,
        ),
        patch(
            "podcast_mcp.services.play.render_gated_mix",
            side_effect=lambda _segs, _iv, out, **_kw: out.touch() or None,
        ),
        patch(
            "podcast_mcp.services.play.word_intervals",
            return_value=[(0.0, 0.4)],
        ),
        patch(
            "podcast_mcp.services.play.dialogue_tracks_for_play",
            return_value=["host"],
        ),
    ):
        seg_out.touch()
        result = PlayService(ws).play(
            PlayRequest(
                source="premix",
                start_sec=0.0,
                end_sec=1.0,
                follow_transcript=True,
            ),
            dry_run=True,
        )
    assert result.tier == "transcript_gated_mix"
    assert result.source_label == "follow-transcript:mix"


def test_play_ensure_stem(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with patch("podcast_mcp.engines.ffmpeg.FFmpegEngine") as eng_cls:
        eng_cls.return_value.render_dialogue_track = MagicMock()
        stem = PlayService(ws).ensure_stem("host")
    assert stem.suffix == ".wav"
    eng_cls.return_value.render_dialogue_track.assert_called_once()


def test_play_player_command_override(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    svc = PlayService(ws)
    cmd = svc._player_command("mplayer", Path("/tmp/x.wav"))
    assert cmd == ["mplayer", "/tmp/x.wav"]


def test_play_runs_player_when_not_dry_run(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    mock_extract = MagicMock(side_effect=lambda _src, out, *_a: out.touch() or out)
    with (
        patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls,
        patch("podcast_mcp.services.play.run") as run_player,
    ):
        eng_cls.return_value.extract_segment = mock_extract
        PlayService(ws).play(
            PlayRequest(source="track:host", start_sec=0.0, end_sec=0.5),
            dry_run=False,
            player="afplay",
        )
    run_player.assert_called_once()


def test_play_raw_rewrites_processed_source(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    mock_extract = MagicMock(side_effect=lambda _src, out, *_a: out.touch() or out)
    with patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls:
        eng_cls.return_value.extract_segment = mock_extract
        result = PlayService(ws).play(
            PlayRequest(
                source="processed:host",
                start_sec=0.0,
                end_sec=0.5,
                raw=True,
            ),
            dry_run=True,
        )
    assert result.source_label == "track:host"
    assert result.tier == "raw"


def test_play_unknown_source_raises(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="unknown source"):
        PlayService(ws).play(
            PlayRequest(source="bogus", start_sec=0.0, end_sec=0.5),
            dry_run=True,
        )


def test_play_timeline_map_error(minimal_project, sample_wav) -> None:
    from podcast_mcp.engines.timemap import TimelineMapError

    ws = _dialogue_workspace(minimal_project, sample_wav)
    with (
        patch(
            "podcast_mcp.services.play.timeline_range_to_source",
            side_effect=TimelineMapError("bad range"),
        ),
        pytest.raises(ValueError, match="bad range"),
    ):
        PlayService(ws).play(
            PlayRequest(source="track:host", start_sec=0.0, end_sec=0.5),
            dry_run=True,
        )


def test_play_premix_missing_raises(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with patch("podcast_mcp.services.play.rerender_preview"):
        with pytest.raises(FileNotFoundError, match=r"premix\.wav not found"):
            PlayService(ws).play(
                PlayRequest(source="premix", start_sec=0.0, end_sec=0.5, rerender=True),
                dry_run=True,
            )


def test_play_export_missing_raises(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with pytest.raises(FileNotFoundError, match="no WAV files"):
        PlayService(ws).play(
            PlayRequest(source="export", start_sec=0.0, end_sec=0.5),
            dry_run=True,
        )


def test_play_processed_stem_fresh_path(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    stem = ws.project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    from podcast_mcp.engines.play_audit import write_stem_hash

    write_stem_hash(ws.project, "host")

    def _extract(_src, out, *_a):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(sample_wav.read_bytes())
        return out

    mock_extract = MagicMock(side_effect=_extract)
    with patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls:
        eng_cls.return_value.extract_segment = mock_extract
        result = PlayService(ws).play(
            PlayRequest(source="processed:host", start_sec=0.0, end_sec=0.5),
            dry_run=True,
        )
    assert result.tier == "stem"
    mock_extract.assert_called_once()


def test_play_silent_stem_extract_falls_back_to_segment(minimal_project, sample_wav) -> None:
    """All-zero stem slices must not be played; fall back to segment render."""
    ws = _dialogue_workspace(minimal_project, sample_wav)
    stem = ws.project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    from podcast_mcp.engines.play_audit import write_stem_hash

    write_stem_hash(ws.project, "host")

    def _silent_extract(_src, out, *_a):
        import wave

        out.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(48000)
            w.writeframes(b"\x00\x00" * 24000)  # 0.5s silence
        return out

    with (
        patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls,
        patch("podcast_mcp.services.play.render_track_segment") as seg,
    ):
        eng_cls.return_value.extract_segment = MagicMock(side_effect=_silent_extract)

        def _seg(_project, _tid, _start, _end, cache, _defaults):
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(sample_wav.read_bytes())
            return cache

        seg.side_effect = _seg
        result = PlayService(ws).play(
            PlayRequest(source="processed:host", start_sec=0.0, end_sec=0.5),
            dry_run=True,
        )
    assert result.tier == "segment_render"
    seg.assert_called_once()


def test_play_stem_cache_invalidates_on_stem_mtime(minimal_project, sample_wav) -> None:
    import time

    ws = _dialogue_workspace(minimal_project, sample_wav)
    stem = ws.project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    from podcast_mcp.engines.play_audit import write_stem_hash

    write_stem_hash(ws.project, "host")
    svc = PlayService(ws)
    first = svc._cache_path("stem_host_hash", 0.0, 0.5, stem)
    first.parent.mkdir(parents=True, exist_ok=True)
    first.write_bytes(b"old")
    time.sleep(0.01)
    stem.write_bytes(sample_wav.read_bytes())
    second = svc._cache_path("stem_host_hash", 0.0, 0.5, stem)
    assert first != second


def test_play_processed_segment_cache_hit(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    from podcast_mcp.engines.play_audit import track_render_hash

    edit_hash = track_render_hash(ws.project, "host")
    cache = ws.project.artifacts_dir() / "play_cache" / f"processed_host_0.00_0.50_{edit_hash}.wav"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(sample_wav.read_bytes())
    result = PlayService(ws).play(
        PlayRequest(source="processed:host", start_sec=0.0, end_sec=0.5),
        dry_run=True,
    )
    assert result.tier == "segment_cache"
    assert result.wav_path == cache


def test_play_segment_cache_key_and_render_use_same_snapshot(minimal_project, sample_wav) -> None:
    from podcast_mcp.engines.play_audit import track_render_hash

    ws = _dialogue_workspace(minimal_project, sample_wav)
    before_hash = track_render_hash(ws.project, "host")
    rendered = []

    def change_live_project(_snapshot, _track_id):
        ws.mutate(
            "before cut",
            "after cut",
            lambda live: setattr(live.clips[0], "source_end", 1.0),
        )
        return False

    def render(snapshot, _track_id, _start, _end, cache, _defaults):
        rendered.append((snapshot.clips[0].source_end, track_render_hash(snapshot, "host")))
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(sample_wav.read_bytes())
        return cache

    with (
        patch("podcast_mcp.services.play.stem_is_fresh", side_effect=change_live_project),
        patch("podcast_mcp.services.play.render_track_segment", side_effect=render),
    ):
        result = PlayService(ws)._processed_audio("host", 0.0, 0.5, rerender=False)

    assert rendered == [(2.0, before_hash)]
    assert before_hash in result[0].name
    assert track_render_hash(ws.project, "host") != before_hash


def test_play_processed_rerender_invalidates_cache(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    stem = ws.project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    from podcast_mcp.engines.play_audit import write_stem_hash

    write_stem_hash(ws.project, "host")
    cache_dir = ws.project.artifacts_dir() / "play_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    stale = cache_dir / "stem_host_abc.wav"
    stale.write_bytes(b"x")
    mock_render = MagicMock(return_value=stem)
    with (
        patch.object(PlayService, "ensure_stem", mock_render),
        patch("podcast_mcp.services.play.render_track_segment") as seg,
    ):

        def _seg(_project, _track_id, _start, _end, cache, _defaults):
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(sample_wav.read_bytes())
            return cache

        seg.side_effect = _seg
        PlayService(ws).play(
            PlayRequest(
                source="processed:host",
                start_sec=0.0,
                end_sec=0.5,
                rerender=True,
            ),
            dry_run=True,
        )
    # Short audition: invalidate + segment render, no full-stem rebuild.
    mock_render.assert_not_called()
    seg.assert_called_once()
    assert not stale.is_file()


def test_play_long_rerender_rebuilds_stem(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    stem = ws.project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    from podcast_mcp.engines.play_audit import write_stem_hash

    write_stem_hash(ws.project, "host")
    mock_render = MagicMock(return_value=stem)

    def _extract(_src, out, *_a):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(sample_wav.read_bytes())
        return out

    with (
        patch.object(PlayService, "ensure_stem", mock_render),
        patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls,
        patch("podcast_mcp.services.play.stem_is_fresh", return_value=True),
    ):
        eng_cls.return_value.extract_segment = MagicMock(side_effect=_extract)
        result = PlayService(ws).play(
            PlayRequest(
                source="processed:host",
                start_sec=0.0,
                end_sec=90.0,
                rerender=True,
            ),
            dry_run=True,
        )
    mock_render.assert_called_once()
    assert result.tier == "stem"


def test_play_ensure_stem_unknown_track(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="unknown track"):
        PlayService(ws).ensure_stem("missing")


def test_play_follow_transcript_compare(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    seg_out = ws.project.artifacts_dir() / "seg.wav"
    with (
        patch(
            "podcast_mcp.services.play.render_track_segment",
            return_value=seg_out,
        ),
        patch(
            "podcast_mcp.services.play.render_gated_track",
            side_effect=lambda _seg, _iv, out, **_kw: out.touch() or None,
        ),
        patch(
            "podcast_mcp.services.play.render_gated_mix",
            side_effect=lambda _segs, _iv, out, **_kw: out.touch() or None,
        ),
        patch(
            "podcast_mcp.services.play.word_intervals",
            return_value=[(0.0, 0.4)],
        ),
        patch(
            "podcast_mcp.services.play.dialogue_tracks_for_play",
            return_value=["host"],
        ),
    ):
        seg_out.touch()
        result = PlayService(ws).play(
            PlayRequest(
                source="premix",
                start_sec=0.0,
                end_sec=1.0,
                follow_transcript=True,
                compare=True,
            ),
            dry_run=True,
        )
    assert result.tier == "transcript_gated_compare"
    assert len(result.compare_segments) == 2


def test_play_follow_transcript_track_source(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    seg_out = ws.project.artifacts_dir() / "seg.wav"
    with (
        patch(
            "podcast_mcp.services.play.render_track_segment",
            return_value=seg_out,
        ),
        patch(
            "podcast_mcp.services.play.render_gated_track",
            side_effect=lambda _seg, _iv, out, **_kw: out.touch() or None,
        ),
        patch(
            "podcast_mcp.services.play.word_intervals",
            return_value=[(0.0, 0.4)],
        ),
    ):
        seg_out.touch()
        result = PlayService(ws).play(
            PlayRequest(
                source="track:host",
                start_sec=0.0,
                end_sec=1.0,
                follow_transcript=True,
            ),
            dry_run=True,
        )
    assert result.tier == "transcript_gated"


def test_play_follow_transcript_mix_requires_tracks(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    with (
        patch(
            "podcast_mcp.services.play.dialogue_tracks_for_play",
            return_value=[],
        ),
        pytest.raises(ValueError, match="requires dialogue tracks"),
    ):
        PlayService(ws).play(
            PlayRequest(
                source="premix",
                start_sec=0.0,
                end_sec=1.0,
                follow_transcript=True,
            ),
            dry_run=True,
        )


def test_play_compare_invalid_range(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="end must be after start"):
        PlayService(ws).play(
            PlayRequest(
                source="premix",
                start_sec=2.0,
                end_sec=1.0,
                compare=True,
            ),
            dry_run=True,
        )


def test_play_player_command_linux(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with patch("podcast_mcp.services.play.platform.system", return_value="Linux"):
        cmd = PlayService(ws)._player_command(None, Path("/tmp/x.wav"))
    assert cmd == ["ffplay", "-nodisp", "-autoexit", "/tmp/x.wav"]


# --- EditService ---


def test_edit_build_context(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    ctx = EditService(ws).build_context(max_utterances=10)
    assert "hello podcast world" in ctx


def test_edit_search_with_speaker_filter(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    matches = EditService(ws).search("podcast", speaker="Host")
    assert matches
    assert all(m.track_id == "host" for m in matches)
    assert any(m.utterance_index is not None for m in matches)


def test_edit_cut_text_match(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    fake = [MagicMock()]
    with patch("podcast_mcp.services.edit.cut_text_match", return_value=fake) as cut:
        out = EditService(ws).cut_text_match("podcast", speaker="Host")
    cut.assert_called_once()
    assert out is fake


def test_edit_strip_silence(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"removed_sec": 0.3, "clips": 2}
    with patch("podcast_mcp.services.edit.strip_silence", return_value=report) as strip:
        out = EditService(ws).strip_silence(speaker="Host", threshold_db=-35.0)
    strip.assert_called_once()
    assert out == report


def test_edit_verify_transcript(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    corrections = [{"word_index": 1, "text": "Podcast"}]
    with patch("podcast_mcp.services.edit.verify_words", return_value=1) as verify:
        n = EditService(ws).verify_transcript("host", corrections)
    verify.assert_called_once()
    assert n == 1


def test_edit_apply_transcript_cleanup(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with patch(
        "podcast_mcp.services.edit.apply_transcript_corrections",
        return_value=2,
    ) as apply:
        n = EditService(ws).apply_transcript_cleanup(
            "host",
            words=[{"word_index": 0, "text": "Hi"}],
        )
    apply.assert_called_once()
    assert n == 2


def test_edit_transcript_timestamps(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    text = EditService(ws).transcript_timestamps()
    assert "hello" in text.lower() or "0.0" in text


def test_edit_remove_effect(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    EditService(ws).add_effect(speaker="Host", preset="gate")
    out = EditService(ws).remove_effect(speaker="Host", effect="agate")
    assert out["track_id"] == "host"
    assert out["removed"] >= 0


def test_edit_list_effects_presets_only(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    out = EditService(ws).list_effects()
    assert "presets" in out


def test_edit_add_effect_requires_arg(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="preset or effect is required"):
        EditService(ws).add_effect(speaker="Host")


def test_edit_analyze_cleanup(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"tracks": ["host"], "issues": []}
    with patch(
        "podcast_mcp.services.edit.cleanup_analysis_report",
        return_value=report,
    ) as analyze:
        out = EditService(ws).analyze_cleanup(speaker="Host")
    analyze.assert_called_once()
    assert out == report


def test_edit_audio_diagnostics(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"track_id": "host", "spectrogram_png": "spec.png", "waveform_png": "wave.png"}
    with patch(
        "podcast_mcp.services.edit.audio_diagnostics_report",
        return_value=report,
    ) as diag:
        out = EditService(ws).audio_diagnostics(speaker="Host", start_sec=1.0, end_sec=2.0)
    diag.assert_called_once()
    assert out == report


def test_edit_recommend_fades(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    recs = [{"clip_id": "full", "recommended_fade_in_ms": 15}]
    with patch(
        "podcast_mcp.services.edit.fade_recommendations",
        return_value=recs,
    ) as fades:
        out = EditService(ws).recommend_fades(track_id="host")
    fades.assert_called_once()
    assert out == recs


def test_edit_apply_fade_recommendations(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    recs = [{"clip_id": "full", "recommended_fade_in_ms": 20}]
    with patch(
        "podcast_mcp.services.edit.apply_fade_recommendations",
        return_value={"applied_fade_updates": 1},
    ) as apply:
        out = EditService(ws).apply_fade_recommendations(recs)
    apply.assert_called_once()
    assert out["applied_fade_updates"] == 1


def test_edit_preview_inaudible_cut(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    opt = OptimizedCutRange(
        start=0.1,
        end=0.9,
        mode="waveform_only",
        shifted_start_ms=2.0,
        shifted_end_ms=-3.0,
        confidence=0.8,
        details={"energy": 0.5},
    )
    with patch(
        "podcast_mcp.services.edit.optimize_source_cut_range",
        return_value=opt,
    ):
        out = EditService(ws).preview_inaudible_cut(
            speaker="Host",
            start=0.0,
            end=1.0,
        )
    assert out["track_id"] == "host"
    assert out["mode"] == "waveform_only"
    assert out["confidence"] == pytest.approx(0.8)


def test_edit_join_quality_proposed_cut(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with patch("podcast_mcp.services.edit.assess_proposed_cut") as assess:
        assess.return_value.to_dict.return_value = {
            "track_id": "host",
            "verdict": "fail",
            "risk": 0.7,
        }
        out = EditService(ws).join_quality(
            track_id="host", cut_start=0.1, cut_end=0.3, timebase="source"
        )
    assert out["verdict"] == "fail"
    with pytest.raises(ValueError, match="join_sec"):
        EditService(ws).join_quality(track_id="host")


def test_edit_join_label_play(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with (
        patch("podcast_mcp.services.edit.assess_existing_join") as assess,
        patch("podcast_mcp.services.play.PlayService.play", return_value=None) as play,
    ):
        assess.return_value.to_dict.return_value = {
            "track_id": "host",
            "risk": 0.4,
            "detectors": [],
            "neural": None,
        }
        out = EditService(ws).join_label(track_id="host", join_sec=1.0, verdict="pass", play=True)
    assert out["played"] is True
    play.assert_called_once()


def test_edit_check_loudness(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())
    loud = {"integrated_lufs": -16.0}
    with patch("podcast_mcp.services.edit.check_loudness", return_value=loud) as chk:
        out = EditService(ws).check_loudness()
    chk.assert_called_once()
    assert out["integrated_lufs"] == pytest.approx(-16.0)


def test_edit_check_loudness_missing_file_raises(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(FileNotFoundError, match="no audio to measure"):
        EditService(ws).check_loudness()


def test_edit_reconcile_transcript(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"changed": 0, "dry_run": True}
    with patch(
        "podcast_mcp.services.edit.run_reconciliation",
        return_value=report,
    ) as reconcile:
        out = EditService(ws).reconcile_transcript(speaker="Host", dry_run=True)
    reconcile.assert_called_once()
    assert out == report


def test_edit_reconciliation_status(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    status = {"stale": False}
    with patch(
        "podcast_mcp.services.edit.reconciliation_status_report",
        return_value=status,
    ):
        out = EditService(ws).reconciliation_status()
    assert out == status


def test_edit_suppress_bleed_dry_run(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    preview = {"would_suppress": 2}
    with patch(
        "podcast_mcp.services.edit.suppress_bleed_words",
        return_value=preview,
    ) as suppress:
        out = EditService(ws).suppress_bleed(speaker="Host", apply=False)
    suppress.assert_called_once()
    assert out == preview


def test_edit_overlap_duplicates(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"pairs": []}
    with patch(
        "podcast_mcp.services.edit.overlap_duplicate_report",
        return_value=report,
    ):
        out = EditService(ws).overlap_duplicates(start_sec=0.0, end_sec=2.0)
    assert out == report


def test_edit_apply_bleed_mute_dry_run(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    stem = ws.project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    preview = {"dry_run": True, "candidate_count": 1, "candidates": []}
    with patch(
        "podcast_mcp.services.edit.apply_transcript_bleed_mute",
        return_value=preview,
    ) as mute:
        out = EditService(ws).apply_bleed_mute(speaker="Host", apply=False)
    mute.assert_called_once()
    assert out == preview


def test_edit_apply_bleed_mute_apply(minimal_project, sample_wav) -> None:
    from podcast_mcp.engines.play_audit import write_stem_hash

    ws = _dialogue_workspace(minimal_project, sample_wav)
    stem = ws.project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(ws.project, "host")

    def _copy_gate(src, intervals, dest, **kwargs) -> None:
        Path(dest).write_bytes(Path(src).read_bytes())

    with (
        patch(
            "podcast_mcp.edits.transcript_bleed_mute.gate_stem_window",
            side_effect=_copy_gate,
        ),
        patch("podcast_mcp.edits.transcript_bleed_mute.write_stem_hash"),
    ):
        out = EditService(ws).apply_bleed_mute(speaker="Host", apply=True)
    assert out["applied_count"] == 1
    assert ws.project.track_by_id("host").transcript_gate is True


def test_edit_gate_overreach(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"overreach_ms": 0}
    with patch(
        "podcast_mcp.services.edit.gate_overreach_report",
        return_value=report,
    ):
        out = EditService(ws).gate_overreach(speaker="Host")
    assert out == report


def test_edit_audibility_map(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    rows = [{"word": "hello", "audible": True}]
    with patch(
        "podcast_mcp.services.edit.build_audibility_map",
        return_value=rows,
    ):
        out = EditService(ws).audibility_map(track_id="host")
    assert out == rows


def test_edit_flagged_words(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    flagged = [{"word_index": 0, "reason": "low_confidence"}]
    with patch(
        "podcast_mcp.services.edit.list_flagged_transcript_words",
        return_value=flagged,
    ):
        out = EditService(ws).flagged_words(speaker="Host")
    assert out == flagged


def test_edit_low_audibility_words(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    words = [{"text": "hello"}]
    with patch(
        "podcast_mcp.services.edit.audit_low_audibility_words",
        return_value=words,
    ) as low:
        svc = EditService(ws)
        assert svc.low_audibility_words(speaker="Host") == words
    low.assert_called_once()


def test_edit_list_bleed_words(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    bleed = [{"text": "world", "track_id": "host"}]
    with patch("podcast_mcp.services.edit.bleed_words", return_value=bleed) as bleed_fn:
        out = EditService(ws).list_bleed_words(speaker="Host", start_sec=0.0, end_sec=2.0)
    bleed_fn.assert_called_once()
    assert out == bleed


def test_edit_preview_inaudible_cut_timeline_mode(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    opt = OptimizedCutRange(
        start=2.0,
        end=4.0,
        mode="vocal_transcript_guided",
        shifted_start_ms=1.0,
        shifted_end_ms=-1.0,
        confidence=0.7,
        details={"strategy": "word+waveform"},
    )
    with patch(
        "podcast_mcp.services.edit.optimize_timeline_cut_range",
        return_value=opt,
    ) as timeline_opt:
        out = EditService(ws).preview_inaudible_cut(
            track_id="host",
            start=2.0,
            end=4.0,
            timeline=True,
        )
    timeline_opt.assert_called_once()
    assert out["timeline_mode"] is True
    assert out["mode"] == "vocal_transcript_guided"


def test_edit_split_clip_and_fill_room_tone(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    split_report = {"operation": "split_clip", "clip_id": "full"}
    fill_report = {"operation": "fill_with_room_tone", "filled_sec": 0.5}
    with patch("podcast_mcp.services.edit.split_clips_at", return_value=split_report):
        out = EditService(ws).split_clip(at_time=1.0, speaker="Host")
    assert out == split_report
    with patch("podcast_mcp.services.edit.fill_with_room_tone", return_value=fill_report):
        out = EditService(ws).fill_room_tone(track_id="host")
    assert out == fill_report


def test_edit_check_loudness_prefers_mastered_export(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    mastered = ws.project.export_dir() / f"{ws.project.name}.wav"
    mastered.parent.mkdir(parents=True, exist_ok=True)
    mastered.write_bytes(sample_wav.read_bytes())
    loud = {"integrated_lufs": -14.0}
    with patch("podcast_mcp.services.edit.check_loudness", return_value=loud) as chk:
        out = EditService(ws).check_loudness()
    chk.assert_called_once_with(mastered)
    assert out["integrated_lufs"] == pytest.approx(-14.0)


def test_edit_add_effect_custom(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    chain = ProcessingChain(
        track_id="host",
        effects=[ProcessingEffect(effect="eq", params={"gain_db": 2})],
    )
    with patch("podcast_mcp.services.edit.add_effect", return_value=chain):
        out = EditService(ws).add_effect(
            speaker="Host",
            effect="eq",
            params={"gain_db": 2},
        )
    assert out["effects"][0]["effect"] == "eq"


def test_edit_optional_track_filters_without_speaker(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    with patch(
        "podcast_mcp.services.edit.fade_recommendations",
        return_value=[],
    ) as fades:
        assert EditService(ws).recommend_fades() == []
    fades.assert_called_once_with(ws.project, track_id=None)
    with patch(
        "podcast_mcp.services.edit.audit_low_audibility_words",
        return_value=[],
    ) as low:
        assert EditService(ws).low_audibility_words() == []
    low.assert_called_once_with(ws.project, track_id=None, progress=None)
    with patch(
        "podcast_mcp.services.edit.bleed_words",
        return_value=[],
    ) as bleed:
        assert EditService(ws).list_bleed_words() == []
    bleed.assert_called_once()
    with patch(
        "podcast_mcp.services.edit.build_audibility_map",
        return_value=[],
    ) as aud:
        assert EditService(ws).audibility_map() == []
    aud.assert_called_once_with(ws.project, track_id=None, progress=None)
    with patch(
        "podcast_mcp.services.edit.list_flagged_transcript_words",
        return_value=[],
    ) as flagged:
        assert EditService(ws).flagged_words() == []
    flagged.assert_called_once_with(ws.project, track_id=None, progress=None)


def test_edit_suppress_low_audibility_mutates(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"suppressed": 1}
    with patch(
        "podcast_mcp.services.edit.suppress_low_audibility_words",
        return_value=report,
    ) as suppress:
        out = EditService(ws).suppress_low_audibility(track_id="host")
    suppress.assert_called_once()
    assert out == report


def test_edit_suppress_bleed_apply_true(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"suppressed": 2}
    with patch(
        "podcast_mcp.services.edit.suppress_bleed_words",
        return_value=report,
    ) as suppress:
        out = EditService(ws).suppress_bleed(speaker="Host", apply=True)
    suppress.assert_called_once()
    assert out == report


def test_edit_reconcile_transcript_all_tracks(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    report = {"changed": 0}
    with patch(
        "podcast_mcp.services.edit.run_reconciliation",
        return_value=report,
    ) as reconcile:
        out = EditService(ws).reconcile_transcript(dry_run=True)
    reconcile.assert_called_once()
    assert reconcile.call_args.kwargs["track_id"] is None
    assert out == report


def test_edit_check_loudness_explicit_path(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    audio = ws.project.workspace_path() / "custom.wav"
    audio.write_bytes(sample_wav.read_bytes())
    loud = {"integrated_lufs": -18.0}
    with patch("podcast_mcp.services.edit.check_loudness", return_value=loud) as chk:
        out = EditService(ws).check_loudness(str(audio))
    chk.assert_called_once_with(audio)
    assert out["integrated_lufs"] == pytest.approx(-18.0)


def test_edit_suppress_bleed_dry_run_all_tracks(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    preview = {"would_suppress": 3}
    with patch(
        "podcast_mcp.services.edit.suppress_bleed_words",
        return_value=preview,
    ) as suppress:
        out = EditService(ws).suppress_bleed(apply=False)
    suppress.assert_called_once()
    assert suppress.call_args.kwargs["track_id"] is None
    assert out == preview


def test_play_resolve_source_with_mocked_search(minimal_project, sample_wav) -> None:
    ws = _dialogue_workspace(minimal_project, sample_wav)
    match = TranscriptMatch(
        track_id="host",
        start=1.0,
        end=2.0,
        text="podcast",
        speaker="Host",
        timeline_start=1.0,
        timeline_end=2.0,
    )
    with patch("podcast_mcp.services.play.search_transcript", return_value=[match]):
        source, start, end = PlayService(ws)._resolve_source_and_times(
            PlayRequest(source="export", start_sec=0.0, end_sec=1.0, query="podcast")
        )
    assert source == "export"
    assert start == pytest.approx(0.0)
    assert end == pytest.approx(3.0)
