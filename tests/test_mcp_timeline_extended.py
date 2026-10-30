from __future__ import annotations

import json
import shutil
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import timeline as mcp_timeline
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


def _seed_project(path: str, sample_wav) -> None:
    proj = load_project(Path(path))
    workspace = proj.workspace_path()
    media_path = workspace / "raw" / "host.wav"
    media_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(sample_wav, media_path)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(text="world", start=2.0, end=2.5, confidence=0.4),
            ],
        )
    ]
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=0.5,
                text="hello",
            ),
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=2.0,
                end=2.5,
                text="world",
            ),
        ]
    )
    save_project(proj, Path(path))


def test_mcp_transcript_correction_expected_text_guard(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)

    with pytest.raises(ValueError, match="changed since you read it"):
        mcp_timeline.correct_transcript_tool(path, "host", 0, "Hi", expected_text="world")
    proj = load_project(Path(path))
    assert proj.transcripts[0].words[0].text == "hello"

    corrected = json.loads(
        mcp_timeline.correct_transcript_tool(path, "host", 0, "Hi", expected_text="hello")
    )
    assert corrected["text"] == "Hi"

    with pytest.raises(ValueError, match="changed since you read"):
        mcp_timeline.correct_transcript_phrase_tool(
            path, "host", 0, 1, "Hi earth", expected_text="nope"
        )

    phrase = json.loads(
        mcp_timeline.correct_transcript_phrase_tool(
            path, "host", 0, 1, "Hi earth", expected_text="Hi world"
        )
    )
    assert phrase["text"] == "Hi earth"


def test_mcp_suppress_and_ignore_expected_text_guard(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)

    with pytest.raises(ValueError, match="changed since you read it"):
        mcp_timeline.set_word_suppressed_tool(path, "host", 0, True, expected_text="world")
    proj = load_project(Path(path))
    assert proj.transcripts[0].words[0].suppressed is False

    suppressed = json.loads(
        mcp_timeline.set_word_suppressed_tool(path, "host", 0, True, expected_text="hello")
    )
    assert suppressed["suppressed"] is True

    with pytest.raises(ValueError, match="changed since you read"):
        mcp_timeline.set_words_ignored_tool(path, "host", 0, 1, True, expected_text="nope")
    proj = load_project(Path(path))
    assert not any(w.ignored for w in proj.transcripts[0].words)

    ignored = json.loads(
        mcp_timeline.set_words_ignored_tool(path, "host", 0, 1, True, expected_text="hello world")
    )
    assert ignored["changed"] == 2


def test_mcp_set_word_automatic_clears_lock(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)

    locked = json.loads(mcp_timeline.set_word_suppressed_tool(path, "host", 0, True))
    assert locked["suppressed"] is True
    proj = load_project(Path(path))
    assert proj.transcripts[0].words[0].audibility_locked is True

    with pytest.raises(ValueError, match="changed since you read it"):
        mcp_timeline.set_word_automatic_tool(path, "host", 0, expected_text="world")
    proj = load_project(Path(path))
    assert proj.transcripts[0].words[0].audibility_locked is True

    unlocked = json.loads(
        mcp_timeline.set_word_automatic_tool(path, "host", 0, expected_text="hello")
    )
    assert unlocked["audibility_locked"] is False
    assert unlocked["suppressed"] is True
    proj = load_project(Path(path))
    assert proj.transcripts[0].words[0].audibility_locked is False
    assert proj.transcripts[0].words[0].suppressed is True


def test_mcp_timeline_move_and_duplicate(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)
    out = json.loads(mcp_timeline.move_segment_tool(path, 0.0, 0.5, 5.0))
    assert out["operation"] == "move_segment"
    out = json.loads(mcp_timeline.duplicate_segment_tool(path, 0.0, 0.5, 6.0))
    assert out["operation"] == "duplicate_segment"


def test_mcp_timeline_text_and_gap_tools(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)
    out = json.loads(mcp_timeline.ripple_delete_text_tool(path, "hello"))
    assert out["operation"] == "ripple_delete_text"
    out = json.loads(mcp_timeline.insert_gap_tool(path, 3.0, 0.5))
    assert out["operation"] == "insert_gap"
    out = json.loads(mcp_timeline.shorten_gaps_tool(path, 0.2))
    assert out["operation"] == "shorten_word_gaps"


def test_mcp_timeline_transcript_correction_tools(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)
    phrase = json.loads(
        mcp_timeline.correct_transcript_phrase_tool(path, "host", 0, 1, "goodbye earth")
    )
    assert phrase["text"] == "goodbye earth"
    out = json.loads(mcp_timeline.low_confidence_words_tool(path, 0.7))
    assert isinstance(out, list)
    corrected = mcp_timeline.correct_transcript_tool(path, "host", 1, "earth")
    data = json.loads(corrected)
    assert data["text"] == "earth"
    batch = mcp_timeline.apply_transcript_cleanup_tool(
        path,
        "host",
        {"words": [{"word_index": 0, "text": "hi"}], "phrases": []},
    )
    assert json.loads(batch)["applied"] >= 1


def test_mcp_timeline_effects_and_chapters(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    project = load_project(Path(path))
    project.processing_chains.append(
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="volume", params={})],
        )
    )
    save_project(project, Path(path))
    out = json.loads(mcp_timeline.add_effect_tool(path, track_id="host", preset="deess"))
    assert "host" in str(out)
    listed = json.loads(mcp_timeline.list_effects_tool(path, track_id="host"))
    assert listed["track_id"] == "host"
    assert listed["effects"]
    assert "highpass" in listed["supported_effects"]
    unknown = next(item for item in listed["effects"] if item["effect"] == "volume")
    assert unknown["supported"] is False
    assert "will not be rendered" in unknown["warning"]
    ch = json.loads(mcp_timeline.add_chapter_tool(path, 0.0, "Intro"))
    assert ch["title"] == "Intro"
    chapters = json.loads(mcp_timeline.list_chapters_tool(path))
    assert len(chapters) >= 1
    removed = json.loads(mcp_timeline.remove_chapter_tool(path, "Intro"))
    assert removed["removed"] is True
    assert json.loads(mcp_timeline.list_chapters_tool(path)) == []


@pytest.mark.parametrize("effect", ["volume", "alimiter"])
def test_mcp_add_unsupported_effect_returns_coded_refusal(tmp_path, sample_wav, effect):
    from podcast_mcp.util.coded_error import CodedValueError

    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)
    with pytest.raises(CodedValueError) as caught:
        mcp_timeline.add_effect_tool(path, track_id="host", effect=effect)
    assert caught.value.code == "unsupported_effect"
    assert "highpass" in str(caught.value)


def test_mcp_timeline_heavy_edit_tools_mocked(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)

    with (
        patch("podcast_mcp.mcp.tools.timeline.EditService") as svc_cls,
        patch("podcast_mcp.mcp.tools.timeline.TimelineService", svc_cls),
        patch("podcast_mcp.mcp.tools.timeline.AnalysisService", svc_cls),
        patch("podcast_mcp.mcp.tools.timeline.TranscriptService", svc_cls),
    ):
        svc = svc_cls.return_value
        svc.split_clip.return_value = {"operation": "split_clip", "clip_id": "c1"}
        svc.check_loudness.return_value = {"integrated_lufs": -16.0}
        svc.analyze_cleanup.return_value = {"tracks": ["host"], "issues": []}
        svc.audio_diagnostics.return_value = {
            "track_id": "host",
            "spectrogram_png": "spec.png",
            "waveform_png": "wave.png",
        }
        svc.recommend_fades.return_value = [{"clip_id": "c1", "recommended_fade_in_ms": 15}]

        with patch(
            "podcast_mcp.mcp.tools.timeline.submit_host_command_result",
            return_value={"operation": "strip_silence", "removed_sec": 0.3},
        ) as strip_submit:
            strip = json.loads(
                mcp_timeline.strip_silence_tool(
                    path, track_id="host", over_voice_floor_db=3.0, min_duration_sec=0.4
                )
            )
        with patch(
            "podcast_mcp.mcp.tools.timeline.submit_host_command_result",
            return_value={"operation": "fill_with_room_tone", "filled_sec": 0.2},
        ) as fill_submit:
            fill = json.loads(mcp_timeline.fill_with_room_tone_tool(path, speaker="Host"))
        loud = json.loads(mcp_timeline.check_loudness_tool(path))
        verified = json.loads(
            mcp_timeline.verify_transcript_tool(path, "host", [{"word_index": 0, "text": "hi"}])
        )
        removed = json.loads(mcp_timeline.remove_effect_tool(path, track_id="host", effect="agate"))
        analyzed = json.loads(mcp_timeline.analyze_cleanup_tool(path, speaker="Host"))
        diagnostics = json.loads(
            mcp_timeline.audio_diagnostics_tool(path, track_id="host", start_sec=1.0, end_sec=2.0)
        )
        recs = json.loads(mcp_timeline.recommend_fades_tool(path, track_id="host"))
        with patch(
            "podcast_mcp.mcp.tools.timeline.submit_host_command_result",
            return_value={"applied_fade_updates": 1},
        ) as submit:
            applied = json.loads(
                mcp_timeline.apply_fade_recommendations_tool(
                    path,
                    [{"clip_id": "c1", "recommended_fade_in_ms": 20}],
                )
            )

    split = json.loads(mcp_timeline.split_clip_tool(path, 1.5, track_id="host"))

    assert strip["operation"] == "strip_silence"
    assert split["operation"] == "split_clips_at"
    assert fill["operation"] == "fill_with_room_tone"
    fill_submit.assert_called_once_with(path, "FillRoomTone", {"speaker": "Host"})
    assert loud["integrated_lufs"] == pytest.approx(-16.0)
    assert verified["verified"] == 1
    assert removed["track_id"] == "host"
    assert removed["removed"] == 0
    assert analyzed["tracks"] == ["host"]
    assert diagnostics["track_id"] == "host"
    assert recs[0]["clip_id"] == "c1"
    assert applied["applied_fade_updates"] == 1

    strip_submit.assert_called_once_with(
        path,
        "StripSilence",
        {
            "track_id": "host",
            "speaker": None,
            "over_voice_floor_db": 3.0,
            "min_duration_sec": 0.4,
            "use_inaudible_opt": None,
        },
    )
    submit.assert_called_once_with(
        path,
        "ApplyFadeRecommendationList",
        {"recommendations": [{"clip_id": "c1", "recommended_fade_in_ms": 20}]},
    )


def test_mcp_timeline_clip_and_edit_tools(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)

    clips = json.loads(mcp_timeline.list_clips_tool(path, track_id="host"))
    assert clips

    moved = json.loads(mcp_timeline.move_by_text_tool(path, "hello", "world", position="before"))
    assert moved["operation"] == "move_segment"

    out = json.loads(mcp_timeline.ripple_delete_tool(path, 0.5, 1.0))
    assert out["operation"] == "ripple_delete"

    faded = json.loads(mcp_timeline.fade_joins_tool(path, dry_run=True))
    assert faded["operation"] == "fade_joins"
    assert faded["dry_run"] is True

    crossfaded = json.loads(mcp_timeline.crossfade_joins_tool(path, fade_ms=25, dry_run=True))
    assert crossfaded["operation"] == "crossfade_joins"
    assert crossfaded["fade_ms"] == 25

    listed = json.loads(mcp_timeline.list_clips_tool(path, track_id="host"))
    clip_id = listed["tracks"]["host"][0]["id"]
    assert listed["tracks"]["host"][0]["track_id"] == "host"
    faded = json.loads(mcp_timeline.set_clip_fade_tool(path, clip_id, 10, 15))
    assert faded["operation"] == "set_clip_fade"
    joined = json.loads(mcp_timeline.set_join_mode_tool(path, clip_id, "crossfade"))
    assert joined["operation"] == "set_clip_join_mode"


def test_mcp_timeline_reconcile_and_bleed_tools_mocked(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)

    with (
        patch("podcast_mcp.mcp.tools.timeline.EditService") as svc_cls,
        patch("podcast_mcp.mcp.tools.timeline.TimelineService", svc_cls),
        patch("podcast_mcp.mcp.tools.timeline.AnalysisService", svc_cls),
        patch("podcast_mcp.mcp.tools.timeline.TranscriptService", svc_cls),
    ):
        svc = svc_cls.return_value
        svc.reconciliation_status.return_value = {"stale": False}
        svc.preview_reconcile_transcript.return_value = {"changed": 0, "dry_run": True}
        svc.list_bleed_words.return_value = [{"text": "bleed"}]
        svc.preview_suppress_bleed.return_value = {"would_suppress": 1}
        svc.overlap_duplicates.return_value = {"pairs": []}
        svc.preview_bleed_mute.return_value = {"dry_run": True, "candidate_count": 0}
        svc.low_audibility_words.return_value = []
        svc.gate_overreach.return_value = {"clips": []}
        svc.audibility_map.return_value = []
        svc.flagged_words.return_value = []

        status = json.loads(mcp_timeline.reconciliation_status_tool(path))
        reconcile = json.loads(
            mcp_timeline.reconcile_transcript_tool(path, speaker="Host", dry_run=True)
        )
        bleed = json.loads(mcp_timeline.bleed_words_tool(path, track_id="host"))
        suppressed = json.loads(
            mcp_timeline.apply_bleed_suppression_tool(
                path,
                speaker="Host",
                words=[{"track_id": "host", "word_index": 0}],
                dry_run=True,
            )
        )
        overlap = json.loads(mcp_timeline.overlap_duplicates_tool(path, start_sec=0.0))
        gate_preview = json.loads(
            mcp_timeline.apply_transcript_gate_tool(path, speaker="Host", dry_run=True)
        )
        svc.preview_bleed_mute.assert_called_once()
        low_aud = json.loads(mcp_timeline.low_audibility_words_tool(path, track_id="host"))
        suppressed_low = json.loads(
            mcp_timeline.apply_low_audibility_suppression_tool(path, track_id="host")
        )
        gate = json.loads(mcp_timeline.gate_overreach_tool(path, speaker="Host"))
        aud_map = json.loads(mcp_timeline.audibility_map_tool(path, track_id="host"))
        flagged = json.loads(mcp_timeline.flagged_words_tool(path, speaker="Host"))

    assert status["stale"] is False
    assert reconcile["dry_run"] is True
    assert bleed[0]["text"] == "bleed"
    assert suppressed["would_suppress"] == 1
    assert overlap["pairs"] == []
    assert gate_preview["dry_run"] is True
    assert low_aud == []
    assert suppressed_low["suppressed_count"] == 0
    assert gate["clips"] == []
    assert aud_map == []
    assert flagged == []


def test_mcp_timeline_register():
    mcp = MagicMock()
    decorator = MagicMock(side_effect=lambda fn: fn)
    mcp.tool.return_value = decorator
    mcp_timeline.register(mcp)
    assert mcp.tool.call_count >= 30


def test_mcp_timeline_optional_params_mocked(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)

    with (
        patch("podcast_mcp.mcp.tools.timeline.EditService") as svc_cls,
        patch("podcast_mcp.mcp.tools.timeline.TimelineService", svc_cls),
        patch("podcast_mcp.mcp.tools.timeline.AnalysisService", svc_cls),
        patch("podcast_mcp.mcp.tools.timeline.TranscriptService", svc_cls),
    ):
        svc = svc_cls.return_value
        svc.split_clip.return_value = {"operation": "split_clip"}
        svc.check_loudness.return_value = {"integrated_lufs": -14.0}
        svc.cut_range.return_value = {"operation": "ripple_delete"}
        svc.preview_suppress_bleed.return_value = {"suppressed": 0}

        with patch(
            "podcast_mcp.mcp.tools.timeline.submit_host_command_result",
            return_value={"operation": "strip_silence", "removed_sec": 0.3},
        ) as strip_submit:
            json.loads(
                mcp_timeline.strip_silence_tool(
                    path,
                    speaker="Host",
                    use_inaudible_opt=True,
                )
            )
        json.loads(mcp_timeline.check_loudness_tool(path, audio_path="/tmp/mix.wav"))
        json.loads(
            mcp_timeline.add_effect_tool(
                path,
                track_id="host",
                effect="equalizer",
                params={"g": 3},
            )
        )
        json.loads(mcp_timeline.ripple_delete_tool(path, 1.0, 2.0, use_inaudible_opt=False))
        shortened = json.loads(mcp_timeline.shorten_gaps_tool(path, use_inaudible_opt=True))
        assert shortened["operation"] == "shorten_word_gaps"
        json.loads(
            mcp_timeline.reconcile_transcript_tool(
                path,
                track_id="host",
                start_sec=0.0,
                end_sec=5.0,
            )
        )
        json.loads(
            mcp_timeline.apply_bleed_suppression_tool(
                path,
                exclude_words=[{"track_id": "host", "word_index": 1}],
                apply=False,
            )
        )
        json.loads(
            mcp_timeline.apply_low_audibility_suppression_tool(
                path,
                track_id="host",
                words=[{"track_id": "host", "word_index": 0}],
            )
        )
        batch = json.loads(
            mcp_timeline.apply_transcript_cleanup_tool(
                path,
                "host",
                {
                    "words": [],
                    "phrases": [
                        {
                            "start_word_index": 0,
                            "end_word_index": 1,
                            "text": "hi world",
                        }
                    ],
                },
            )
        )

    split = json.loads(mcp_timeline.split_clip_tool(path, 2.0, speaker="Host"))
    assert split["operation"] == "split_clips_at"

    strip_submit.assert_called_once_with(
        path,
        "StripSilence",
        {
            "track_id": None,
            "speaker": "Host",
            "over_voice_floor_db": 0.0,
            "min_duration_sec": 0.5,
            "use_inaudible_opt": True,
        },
    )
    svc.check_loudness.assert_called_once_with("/tmp/mix.wav")
    assert batch["track_id"] == "host"


def test_mcp_timeline_heavy_tools_use_inaudible_and_speaker(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)

    with (
        patch("podcast_mcp.mcp.tools.timeline.EditService") as svc_cls,
        patch("podcast_mcp.mcp.tools.timeline.TimelineService", svc_cls),
        patch("podcast_mcp.mcp.tools.timeline.AnalysisService", svc_cls),
        patch("podcast_mcp.mcp.tools.timeline.TranscriptService", svc_cls),
    ):
        svc = svc_cls.return_value
        svc.analyze_cleanup.return_value = {"tracks": ["host"]}
        svc.recommend_fades.return_value = []

        with patch(
            "podcast_mcp.mcp.tools.timeline.submit_host_command_result",
            return_value={"operation": "fill_with_room_tone"},
        ) as fill_submit:
            json.loads(mcp_timeline.fill_with_room_tone_tool(path, track_id="host"))
        json.loads(
            mcp_timeline.verify_transcript_tool(path, "host", [{"word_index": 1, "text": "there"}])
        )
        json.loads(mcp_timeline.remove_effect_tool(path, speaker="Host"))
        json.loads(mcp_timeline.analyze_cleanup_tool(path, track_id="host"))
        json.loads(mcp_timeline.recommend_fades_tool(path, speaker="Host"))

    assert json.loads(mcp_timeline.apply_fade_recommendations_tool(path, [])) == {
        "applied_fade_updates": 0
    }
    fill_submit.assert_called_once_with(path, "FillRoomTone", {"track_id": "host"})


def test_transcript_word_tools_journal_through_the_document_plane(tmp_path, sample_wav):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_project(path, sample_wav)
    mcp_timeline.correct_transcript_tool(path, "host", 0, "Hi")
    mcp_timeline.correct_transcript_phrase_tool(path, "host", 0, 1, "good bye")
    mcp_timeline.set_word_suppressed_tool(path, "host", 0, True)
    mcp_timeline.set_word_automatic_tool(path, "host", 0)
    mcp_timeline.set_words_ignored_tool(path, "host", 0, 1, True)
    types = [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]
    assert types == [
        "CorrectTranscriptWord",
        "CorrectTranscriptPhrase",
        "SetTranscriptWordSuppressed",
        "SetTranscriptWordAutomatic",
        "SetTranscriptWordsIgnored",
    ]
