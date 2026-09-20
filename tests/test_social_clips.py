from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.clips.social import (
    _episode_duration,
    _platform_limits,
    _source_audio,
    _utterance_energy,
    approve_social_clips,
    export_social_clips,
    format_social_clip_report,
    list_social_clips,
    propose_social_clips,
    reject_social_clips,
)
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SocialClipCandidate,
    Track,
)


def test_propose_social_clips_scores_utterance():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=25.0,
                text="Why does this work? Here is the secret in 3 steps.",
            )
        ]
    )
    defaults = {
        "social_clips": {
            "min_sec": 15,
            "default_max_sec": 60,
            "max_candidates": 5,
        }
    }
    clips = propose_social_clips(proj, defaults)
    assert len(clips) == 1
    assert clips[0].score > 0.4
    assert "complete_thought" in clips[0].reasons
    assert clips[0].review_required is True


def test_propose_rejects_mid_sentence_chunks():
    from podcast_mcp.clips.social import _looks_like_complete_thought, _truncate_at_word

    assert not _looks_like_complete_thought("")
    assert not _looks_like_complete_thought("in person anymore which like I'm gonna change")
    assert not _looks_like_complete_thought("And then we kept going forever.")
    assert _looks_like_complete_thought("Why does this work? Here is the secret in 3 steps.")
    assert _truncate_at_word("short", 72) == "short"
    assert _truncate_at_word("We were organizing a bunch of episodes today", 30) == (
        "We were organizing a bunch…"
    )
    assert _truncate_at_word("abcdefghij", 4) == "abc…"
    assert _truncate_at_word("hi", 0) == "hi"
    assert _truncate_at_word("hi there", 1) == "…"

    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=100.0,
                end=125.0,
                text="in person anymore which like I'm gonna change because I love being in",
            ),
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=200.0,
                end=225.0,
                text="Yeah. There's been long delays for certain folks, right?",
            ),
        ]
    )
    clips = propose_social_clips(
        proj, {"social_clips": {"min_sec": 15, "default_max_sec": 60, "max_candidates": 5}}
    )
    texts = [c.transcript_excerpt for c in clips]
    assert all(not t.startswith("in person") for t in texts)
    assert any(t.startswith("Yeah") for t in texts)


def test_approve_and_report():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=20.0,
                text="A good clip?",
            )
        ]
    )
    clips = propose_social_clips(proj, {"social_clips": {"min_sec": 15, "max_candidates": 3}})
    approve_social_clips(proj, [clips[0].id])
    assert proj.social_clip_candidates[0].approved is True
    report = format_social_clip_report(proj)
    assert "approved" in report
    assert "Video export" in report


def test_export_social_clips(tmp_path, monkeypatch):
    proj = EpisodeProject.create("ep", str(tmp_path))
    proj.ensure_dirs()
    src = tmp_path / "source.wav"
    src.write_bytes(b"\x00" * 100)
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=20.0,
                text="Export me please for social?",
            )
        ]
    )
    clips = propose_social_clips(
        proj, {"social_clips": {"min_sec": 15, "padding_ms": 0, "max_candidates": 1}}
    )
    approve_social_clips(proj, [clips[0].id])

    mock_engine = MagicMock()
    mock_engine.extract_segment = MagicMock(
        side_effect=lambda s, o, a, b: o.write_bytes(b"wav") or o
    )
    monkeypatch.setattr(
        "podcast_mcp.clips.social.FFmpegEngine",
        lambda: mock_engine,
    )
    monkeypatch.setattr(
        "podcast_mcp.clips.social._source_audio",
        lambda p: src,
    )

    exported = export_social_clips(proj, {"social_clips": {"padding_ms": 0}})
    assert len(exported) == 1
    json_path = Path(exported[0]["json"])
    assert json_path.is_file()
    data = json.loads(json_path.read_text())
    assert data["id"] == clips[0].id


def test_platform_limits_uses_platform_preset():
    defaults = {
        "social_clips": {
            "min_sec": 15,
            "default_max_sec": 60,
            "platforms": {"tiktok": {"max_sec": 30, "min_sec": 10}},
        }
    }
    assert _platform_limits(defaults, "tiktok") == (10.0, 30.0)
    assert _platform_limits(defaults, None) == (15.0, 60.0)


def test_utterance_energy_handles_empty_peaks(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    peaks_dir = proj.artifacts_dir() / "peaks"
    peaks_dir.mkdir(parents=True)
    (peaks_dir / "host.json").write_text(
        json.dumps({"peaks": [], "duration_sec": 0}),
        encoding="utf-8",
    )
    assert _utterance_energy(proj, "host", 0.0, 2.0) == 0.5


def test_utterance_energy_from_peaks(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    peaks_dir = proj.artifacts_dir() / "peaks"
    peaks_dir.mkdir(parents=True)
    peaks_path = peaks_dir / "host.json"
    peaks_path.write_text(
        json.dumps({"peaks": [0, 64, 255, 10], "duration_sec": 4.0, "encoding": "uint8"}),
        encoding="utf-8",
    )
    assert _utterance_energy(proj, "host", 0.0, 2.0) == 1.0
    assert _utterance_energy(proj, "host", 10.0, 10.0) == 0.5
    assert _utterance_energy(proj, "missing", 0.0, 2.0) == 0.5
    peaks_path.write_text("not json", encoding="utf-8")
    assert _utterance_energy(proj, "host", 0.0, 2.0) == 0.5


def test_propose_skips_low_score_and_truncates_title(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    long_text = (
        "Why does this keep happening every week when we try to ship? " + ("word " * 20)
    ).strip()
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=5.0,
                text="too short",
            ),
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=10.0,
                end=35.0,
                text=long_text,
            ),
        ]
    )
    defaults = {"social_clips": {"min_sec": 15, "max_candidates": 5}}
    clips = propose_social_clips(proj, defaults)
    assert len(clips) == 1
    title = clips[0].title_suggestion or ""
    assert len(title) <= 72
    assert title.endswith("…")
    assert not title[:-1].endswith(" ")


def test_propose_applies_edge_penalty_and_filler_dense(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    peaks_dir = proj.artifacts_dir() / "peaks"
    peaks_dir.mkdir(parents=True)
    (peaks_dir / "host.json").write_text(
        json.dumps({"peaks": [0.2] * 100, "duration_sec": 100.0}),
        encoding="utf-8",
    )
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=25.0,
                text="Why does this work? Here is the secret in 3 steps.",
            )
        ]
    )
    proj.edit_decisions = [
        EditDecision(
            id=f"f{i}",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="filler: um",
        )
        for i in range(3)
    ]
    clips = propose_social_clips(proj, {"social_clips": {"min_sec": 15, "max_candidates": 3}})
    assert clips
    assert "edge_penalty" in clips[0].reasons
    assert "filler_dense" in clips[0].reasons


def test_propose_extend_existing_and_list_filters(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=20.0,
                text="What if we tried this approach today?",
            )
        ]
    )
    defaults = {"social_clips": {"min_sec": 15, "max_candidates": 1}}
    first = propose_social_clips(proj, defaults)
    second = propose_social_clips(proj, defaults, replace_existing=False)
    assert len(proj.social_clip_candidates) == 2
    assert len(second) == 1
    approve_social_clips(proj, [first[0].id])
    assert list_social_clips(proj, approved=True) == [first[0]]
    assert list_social_clips(proj, review_required=True)


def test_episode_duration_returns_zero_without_sources(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    assert _episode_duration(proj) == 0.0


def test_episode_duration_from_tracks_and_combined(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="host.wav", duration_sec=120.0),
        )
    ]
    assert _episode_duration(proj) == 120.0
    proj.tracks = []
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=45.0,
                text="fallback duration",
            )
        ]
    )
    assert _episode_duration(proj) == 45.0


def test_reject_social_clips():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.social_clip_candidates = [
        SocialClipCandidate(id="a", track_id="host", start=0.0, end=20.0),
        SocialClipCandidate(id="b", track_id="host", start=30.0, end=50.0),
    ]
    removed = reject_social_clips(proj, ["a"])
    assert removed == 1
    assert [c.id for c in proj.social_clip_candidates] == ["b"]


def test_source_audio_prefers_export_then_premix_then_track(tmp_path):
    proj = EpisodeProject.create("ep", str(tmp_path))
    proj.ensure_dirs()
    export_wav = proj.export_dir() / f"{proj.name}.wav"
    export_wav.write_bytes(b"export")
    assert _source_audio(proj) == export_wav
    export_wav.unlink()
    premix = proj.artifacts_dir() / "premix.wav"
    premix.write_bytes(b"premix")
    assert _source_audio(proj) == premix
    premix.unlink()
    track_wav = tmp_path / "host.wav"
    track_wav.write_bytes(b"track")
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="host.wav"),
        )
    ]
    assert _source_audio(proj) == track_wav


def test_export_social_clips_no_source_raises(tmp_path):
    proj = EpisodeProject.create("ep", str(tmp_path))
    proj.ensure_dirs()
    with pytest.raises(ValueError, match="No audio source"):
        export_social_clips(proj, {"social_clips": {}})


def test_export_social_clips_by_id_skips_unapproved(tmp_path, monkeypatch):
    proj = EpisodeProject.create("ep", str(tmp_path))
    proj.ensure_dirs()
    src = tmp_path / "source.wav"
    src.write_bytes(b"\x00" * 100)
    proj.social_clip_candidates = [
        SocialClipCandidate(
            id="pending",
            track_id="host",
            start=0.0,
            end=20.0,
            title_suggestion="Pending clip",
            review_required=True,
            approved=False,
        ),
        SocialClipCandidate(
            id="ready",
            track_id="host",
            start=30.0,
            end=50.0,
            title_suggestion="Ready clip",
            review_required=False,
            approved=False,
        ),
    ]
    mock_engine = MagicMock()
    mock_engine.extract_segment = MagicMock(
        side_effect=lambda s, o, a, b: o.write_bytes(b"wav") or o
    )
    monkeypatch.setattr("podcast_mcp.clips.social.FFmpegEngine", lambda: mock_engine)
    monkeypatch.setattr("podcast_mcp.clips.social._source_audio", lambda p: src)

    all_exported = export_social_clips(proj, {"social_clips": {"padding_ms": 0}})
    assert len(all_exported) == 1
    assert all_exported[0]["id"] == "ready"

    by_id = export_social_clips(proj, {"social_clips": {"padding_ms": 0}}, ids=["pending"])
    assert len(by_id) == 1
    assert by_id[0]["id"] == "pending"


def test_format_social_clip_report_statuses_and_reasons():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.social_clip_candidates = [
        SocialClipCandidate(
            id="a",
            track_id="host",
            start=0.0,
            end=20.0,
            score=0.9,
            reasons=["hook_pattern"],
            title_suggestion="Hook",
            review_required=False,
            approved=False,
        ),
        SocialClipCandidate(
            id="b",
            track_id="guest",
            start=30.0,
            end=50.0,
            score=0.5,
            review_required=True,
            approved=False,
        ),
    ]
    report = format_social_clip_report(proj)
    assert "draft" in report
    assert "pending" in report
    assert "hook_pattern" in report
