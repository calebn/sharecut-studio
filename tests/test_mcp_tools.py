from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.edit import EditService


def test_comment_tools_mcp(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "cmt_ws"), name="cmt_ep")
    created = json.loads(
        mcp_server.add_comment_tool(
            path,
            body="Trim intro",
            author="agent",
            timeline_start=10.0,
            timeline_end=15.0,
            action_texts_json='["Cut filler"]',
        )
    )
    assert created["author"] == "agent"
    cid = created["id"]
    aid = created["action_items"][0]["id"]

    listed = json.loads(mcp_server.list_comments_tool(path, include_resolved=False))
    assert len(listed) == 1
    got = json.loads(mcp_server.get_comment_tool(path, cid))
    assert got["body"] == "Trim intro"

    updated = json.loads(mcp_server.update_comment_tool(path, cid, body="Trim intro hard"))
    assert updated["body"] == "Trim intro hard"

    added = json.loads(mcp_server.add_comment_action_tool(path, cid, "Check levels"))
    assert added["action_item"]["text"] == "Check levels"

    done = json.loads(
        mcp_server.set_comment_action_done_tool(path, cid, aid, by="agent", done=True)
    )
    assert done["action_item"]["completed_by"] == "agent"

    resolved = json.loads(mcp_server.resolve_comment_tool(path, cid, by="agent", resolved=True))
    assert resolved["resolved"] is True
    assert resolved["resolved_by"] == "agent"

    open_rows = json.loads(mcp_server.list_comments_tool(path, include_resolved=False))
    assert open_rows == []

    deleted = json.loads(mcp_server.delete_comment_tool(path, cid))
    assert deleted["deleted"] is True


def test_episode_create_and_track_add(tmp_path, sample_wav):
    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws), name="mcp_ep")
    assert path.endswith("episode.project.json")
    msg = mcp_server.track_add(
        path,
        "host",
        str(sample_wav),
        role="dialogue",
        speaker="Host",
    )
    assert "host" in msg
    data = json.loads(mcp_server.get_transcript(path, combined=False))
    assert data == []
    status = json.loads(mcp_server.history_status_tool(path))
    assert isinstance(status, dict)
    listed = json.loads(mcp_server.history_list(path))
    assert "entries" in listed
    recorded = json.loads(mcp_server.history_record(path, label="session-test"))
    assert "id_label" in recorded
    md = mcp_server.export_transcript(path)
    assert isinstance(md, str)
    diff = json.loads(mcp_server.history_diff_tool(path))
    assert isinstance(diff, dict)
    undone = json.loads(mcp_server.history_undo(path))
    assert isinstance(undone, dict)
    redone = json.loads(mcp_server.history_redo(path))
    assert isinstance(redone, dict)
    clips = json.loads(mcp_server.list_social_clips_tool(path))
    assert isinstance(clips, list)
    report = mcp_server.social_clip_report_tool(path)
    assert isinstance(report, str)
    proposed = json.loads(mcp_server.propose_social_clips_tool(path))
    assert isinstance(proposed, list)
    approved = mcp_server.approve_social_clips_tool(path, "[]")
    assert "Approved" in approved
    rejected = mcp_server.reject_social_clips_tool(path, "[]")
    assert "Rejected" in rejected
    from unittest.mock import patch

    with patch("podcast_mcp.mcp.tools.clips.ClipService") as clip_svc:
        clip_svc.return_value.export.return_value = []
        exported = json.loads(mcp_server.export_social_clips_tool(path))
        assert exported == []
    with patch("podcast_mcp.mcp.tools.transcript.TranscriptPrecorrectService") as pre:
        pre.return_value.precorrect.return_value = {"ok": True}
        pre_out = json.loads(mcp_server.precorrect_transcript_tool(path, dry_run=True))
        assert pre_out["ok"] is True
    with patch("podcast_mcp.mcp.tools.transcript.TranscriptService") as tr:
        tr.return_value.transcribe.return_value = ["host"]
        ids = json.loads(mcp_server.transcribe_track(path, "host"))
        assert ids == ["host"]
    with patch("podcast_mcp.mcp.tools.pipeline.PipelineService") as pipe:
        pipe.return_value.render_preview.return_value = {"path": "/tmp/p.wav"}
        pipe.return_value.render_final.return_value = Path("/tmp/f.wav")
        pipe.return_value.export_audio.return_value = [Path("/tmp/e.wav")]
        prev = json.loads(mcp_server.render_preview(path))
        assert "path" in prev
        assert str(mcp_server.render_final(path)).endswith("f.wav")
        ex = json.loads(mcp_server.export_audio_tool(path))
        assert len(ex) == 1
        ex2 = json.loads(mcp_server.export_audio_tool(path, formats_json='[{"format":"mp3"}]'))
        assert len(ex2) == 1
    with patch("podcast_mcp.mcp.tools.speaker.SpeakerService") as sp:
        sp.return_value.attribute.return_value = {"ok": True}
        # speaker tools may not all be re-exported; skip if missing
        if hasattr(mcp_server, "attribute_speakers_tool"):
            json.loads(mcp_server.attribute_speakers_tool(path, dry_run=True))


def test_set_envelope(tmp_path):
    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    points = json.dumps([{"time": 0, "value": 0}, {"time": 1, "value": 1}])
    result = mcp_server.set_envelope(path, "music", points)
    assert "music" in result


def test_propose_and_apply_edits(tmp_path):
    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    proj = load_project(Path(path))
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="um", start=0.0, end=0.1),
                TranscriptWord(text="uh", start=0.15, end=0.25),
            ],
        )
    )
    save_project(proj, Path(path))
    muted = json.loads(mcp_server.propose_edits(path, edit_mode="mute"))
    assert muted["operation"] == "propose_edits"
    assert muted["edits"]
    assert all(e["type"] == "mute" for e in muted["edits"])
    out = mcp_server.propose_edits(path)
    proposed = json.loads(out)
    assert proposed["operation"] == "propose_edits"
    assert "edits" in proposed
    assert "skip_counts" in proposed
    assert "summary" in proposed
    assert any("um" in str(e) or "filler" in str(e) for e in proposed["edits"])
    applied = json.loads(mcp_server.apply_edits(path))
    assert applied["operation"] == "apply_auto_edits"
    assert applied["applied_count"] >= 0


def test_update_pending_and_revert_mcp_tools(tmp_path, monkeypatch):
    from podcast_mcp.models import EditDecision

    path = mcp_server.episode_create(str(tmp_path / "pending_ws"))
    fake = EditDecision(id="e1", track_id="host", start=0.2, end=0.4, reason="filler:um")

    def _update(self, edit_id, start, end, snap=True):
        assert edit_id == "e1"
        return fake.model_copy(update={"start": start, "end": end})

    monkeypatch.setattr(
        "podcast_mcp.mcp.tools.edits.EditService.update_pending",
        _update,
    )
    monkeypatch.setattr(
        "podcast_mcp.mcp.tools.edits.EditService.revert_applied",
        lambda self, record_id: {"operation": "revert_applied_edit", "id": record_id},
    )
    updated = json.loads(mcp_server.update_pending_edit_tool(path, "e1", 0.25, 0.55, snap=False))
    assert updated["operation"] == "update_pending_edit"
    assert updated["edit"]["start"] == 0.25
    reverted = json.loads(mcp_server.revert_applied_edit_tool(path, "alog_1"))
    assert reverted["operation"] == "revert_applied_edit"
    assert reverted["id"] == "alog_1"


def test_mcp_update_and_revert_mute(tmp_path):
    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    proj = load_project(Path(path))
    proj.edit_decisions.append(
        EditDecision(
            id="e1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0.2,
            end=0.5,
            reason="filler:um",
            review_required=True,
            applied=False,
        )
    )
    save_project(proj, Path(path))
    updated = json.loads(mcp_server.update_pending_edit_tool(path, "e1", 0.25, 0.55, snap=False))
    assert updated["edit"]["type"] == "mute"
    assert updated["edit"]["start"] == pytest.approx(0.25)
    with patch.object(
        EditService,
        "revert_applied",
        lambda self, record_id: {"operation": "revert_applied_edit", "id": record_id},
    ):
        reverted = json.loads(mcp_server.revert_applied_edit_tool(path, "alog_1"))
    assert reverted["operation"] == "revert_applied_edit"
    with patch.object(EditService, "join_label", return_value={"ok": True}):
        labeled = json.loads(
            mcp_server.join_label_tool(path, join_sec=1.0, verdict="pass", track_id="host")
        )
    assert labeled["ok"] is True


def test_build_edit_context_mcp(tmp_path):
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    proj = load_project(Path(path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="Hi",
            )
        ]
    )
    save_project(proj, Path(path))
    out = mcp_server.build_edit_context(path)
    assert "tools_hint" in out


def test_search_and_cut_mcp(tmp_path):
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    proj = load_project(Path(path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=1.0,
                end=3.0,
                text="talking about coffee beans",
            )
        ]
    )
    save_project(proj, Path(path))
    found = mcp_server.search_transcript_tool(path, "coffee")
    assert "coffee" in found
    mcp_server.cut_text_match_tool(path, "coffee", review_required=True)
    proj2 = load_project(Path(path))
    assert any(e.reason.startswith("nl:match") for e in proj2.edit_decisions)


def test_play_transcript_query_mcp(tmp_path):
    from unittest.mock import patch

    from podcast_mcp.models import CombinedTranscript, CombinedUtterance
    from podcast_mcp.services.play import PlayResult

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    proj = load_project(Path(path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=2.0,
                end=5.0,
                text="talking about family",
            )
        ]
    )
    save_project(proj, Path(path))
    fake = PlayResult(
        wav_path=Path("/tmp/x.wav"),
        player_cmd=None,
        source_label="processed:host",
        start_sec=1.0,
        end_sec=6.0,
        tier="segment_render",
    )
    with patch("podcast_mcp.mcp.tools.play.PlayService") as svc:
        svc.return_value.play.return_value = fake
        out = mcp_server.play_transcript_query_tool(path, "family", dry_run=True)
    data = json.loads(out)
    assert data["ok"] is True
    assert data["match"]["text"] == "talking about family"
    assert data["play"]["tier"] == "segment_render"


def test_play_audio_mcp(tmp_path):
    from unittest.mock import patch

    from podcast_mcp.services.play import PlayResult

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    fake = PlayResult(
        wav_path=Path("/tmp/y.wav"),
        player_cmd=None,
        source_label="premix",
        start_sec=0.0,
        end_sec=2.0,
        tier="premix",
        compare_segments=[{"track_id": "host"}],
    )
    with patch("podcast_mcp.mcp.tools.play.PlayService") as svc:
        svc.return_value.play.return_value = fake
        out = mcp_server.play_audio_tool(
            path,
            source="premix",
            start_sec=0.0,
            end_sec=2.0,
            dry_run=True,
        )
    data = json.loads(out)
    assert data["source"] == "premix"
    assert data["tier"] == "premix"
    assert data["wav"].endswith("y.wav")
    assert data["compare_segments"]


def test_play_compose_mcp(tmp_path):
    from unittest.mock import patch

    from podcast_mcp.services.play import PlayResult

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    fake = PlayResult(
        wav_path=Path("/tmp/compose.wav"),
        player_cmd=None,
        source_label="compose:processed:host,guest",
        start_sec=1.0,
        end_sec=4.0,
        tier="compose",
    )
    with patch("podcast_mcp.mcp.tools.play.PlayService") as svc:
        svc.return_value.play_compose.return_value = fake
        out = mcp_server.play_compose_tool(
            path,
            track_ids=["host", "guest"],
            start_sec=1.0,
            end_sec=4.0,
            dry_run=True,
        )
    data = json.loads(out)
    assert data["tier"] == "compose"
    assert data["track_ids"] == ["host", "guest"]
    svc.return_value.play_compose.assert_called_once()


def test_play_ab_mcp_tools(tmp_path, sample_wav):
    from unittest.mock import patch

    from podcast_mcp.services.play import PlayResult

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    fake = PlayResult(
        wav_path=Path("/tmp/ab.wav"),
        player_cmd=None,
        source_label="ab",
        start_sec=1.0,
        end_sec=2.0,
        tier="ab_concat",
        compare_segments=[{"label": "A"}],
    )
    with patch("podcast_mcp.mcp.tools.play.PlayService") as svc:
        svc.return_value.play_history_ab.return_value = fake
        out = json.loads(
            mcp_server.play_ab_tool(
                path,
                before_index=1,
                after_index=2,
                source="track:host",
                start_sec=1.0,
                end_sec=2.0,
                dry_run=True,
            )
        )
    assert out["tier"] == "ab_concat"
    assert out["before_index"] == 1
    assert out["after_index"] == 2
    assert out["compare_segments"]

    with patch("podcast_mcp.mcp.tools.play.PlayService") as svc:
        svc.return_value.play_ab_wavs.return_value = fake
        out2 = json.loads(
            mcp_server.play_ab_wavs_tool(
                path,
                wav_a=str(sample_wav),
                wav_b=str(sample_wav),
                gap_sec=0.2,
                dry_run=True,
            )
        )
    assert out2["tier"] == "ab_concat"
    assert out2["gap_sec"] == 0.2


def test_play_pending_preview_mcp(tmp_path):
    from unittest.mock import patch

    from podcast_mcp.services.play import PlayResult

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    fake = PlayResult(
        wav_path=Path("/tmp/pending.wav"),
        player_cmd=None,
        source_label="pending:suggested",
        start_sec=0.5,
        end_sec=1.5,
        tier="pending_suggested",
    )
    with patch("podcast_mcp.mcp.tools.play.PlayService") as svc:
        svc.return_value.play_pending_preview.return_value = fake
        out = json.loads(
            mcp_server.play_pending_preview_tool(
                path, edit_id="cut1", mode="suggested", dry_run=True
            )
        )
    assert out["tier"] == "pending_suggested"
    assert out["edit_id"] == "cut1"
    svc.return_value.play_pending_preview.assert_called_once()


def test_play_transcript_query_errors_mcp(tmp_path):
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    none = json.loads(mcp_server.play_transcript_query_tool(path, "zzz", dry_run=True))
    assert none["ok"] is False

    proj = load_project(Path(path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=2.0,
                end=5.0,
                text="hello world",
            )
        ]
    )
    save_project(proj, Path(path))
    bad_idx = json.loads(
        mcp_server.play_transcript_query_tool(path, "hello", match_index=9, dry_run=True)
    )
    assert bad_idx["ok"] is False
    assert "match_index" in bad_idx["error"]


def test_play_transcript_query_removed_timeline_mcp(tmp_path):
    from unittest.mock import patch

    from podcast_mcp.edits.transcript_cuts import TranscriptMatch

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    match = TranscriptMatch(
        track_id="host",
        start=1.0,
        end=2.0,
        text="gone",
        speaker="Host",
        timeline_start=None,
        timeline_end=None,
    )
    with patch("podcast_mcp.mcp.tools.play.EditService") as edit_cls:
        edit_cls.return_value.search.return_value = [match]
        out = json.loads(mcp_server.play_transcript_query_tool(path, "gone", dry_run=True))
    assert out["ok"] is False
    assert "removed" in out["error"]


def test_session_state_mcp_tools(tmp_path):
    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    missing = json.loads(mcp_server.get_session_state_tool(path))
    assert missing["available"] is False
    empty_presence = json.loads(mcp_server.get_session_presence_tool(path))
    assert empty_presence["available"] is True
    assert empty_presence["clients"] == []
    assert "hint" in empty_presence

    seeked = json.loads(mcp_server.seek_session_tool(path, 42.0))
    assert seeked["playhead_sec"] == 42.0
    assert seeked["origin"] == "agent"

    region = json.loads(mcp_server.set_session_region_tool(path, 10.0, 20.0, playing=True))
    assert region["region"]["start_sec"] == 10.0
    assert region["is_playing"] is True

    mode = json.loads(mcp_server.set_session_mode_tool(path, "raw"))
    assert mode["audition_mode"] == "raw"

    stopped = json.loads(mcp_server.stop_session_tool(path))
    assert stopped["is_playing"] is False
    assert stopped["region"] is None

    got = json.loads(mcp_server.get_session_state_tool(path))
    assert got["available"] is True
    assert got["playhead_sec"] == 10.0

    presence = json.loads(mcp_server.get_session_presence_tool(path))
    assert presence["available"] is True
    assert "clients" in presence
    names = {c.get("display_name") for c in presence["clients"]}
    assert "Agent" in names or any(c.get("role") == "agent" for c in presence["clients"])

    playing = json.loads(mcp_server.set_session_playing_tool(path, False))
    assert playing["is_playing"] is False


def test_ingest_suggest_alignment_mcp(tmp_path, sample_wav):
    import shutil

    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    ref = audio_dir / "ref.wav"
    guest = audio_dir / "guest.wav"
    shutil.copy(sample_wav, ref)
    shutil.copy(sample_wav, guest)
    manifest = tmp_path / "ingest.yaml"
    manifest.write_text(
        """
session:
  reference_speaker: Ref
speakers:
  - name: Ref
    sources: [ref.wav]
  - name: Guest
    sources: [guest.wav]
""",
        encoding="utf-8",
    )
    out = mcp_server.ingest_suggest_alignment_tool(
        str(audio_dir),
        str(manifest),
        analysis_duration_sec=1.5,
        sweep_start_max=0.5,
        sweep_step=0.5,
        waveform_top_n=0,
    )
    data = json.loads(out)
    assert data["reference_speaker"] == "Ref"
    assert "recommended_session_starts" in data
    assert "yaml_snippet" in data


def test_play_compare_mcp(tmp_path, sample_wav):
    from unittest.mock import patch

    from podcast_mcp.services.play import PlayResult

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    mcp_server.track_add(path, "host", str(sample_wav), speaker="Host")
    fake = PlayResult(
        wav_path=Path("/tmp/x.wav"),
        player_cmd=None,
        source_label="compare",
        start_sec=0.0,
        end_sec=5.0,
        tier="compare",
        compare_segments=[{"source": "track:host", "wav": "/tmp/a.wav"}],
    )
    with patch("podcast_mcp.mcp.tools.ingest.PlayService") as svc:
        svc.return_value.play.return_value = fake
        out = mcp_server.play_compare_tool(path, start_sec=0.0, end_sec=5.0, dry_run=True)
    data = json.loads(out)
    assert data["source"] == "compare"
    assert data["compare_segments"]


def test_cut_utterance_and_words_mcp(tmp_path):
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance, Transcript, TranscriptWord

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    proj = load_project(Path(path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="remove me",
            )
        ]
    )
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="remove", start=0.0, end=0.4),
                TranscriptWord(text="me", start=0.5, end=0.9),
            ],
        )
    ]
    save_project(proj, Path(path))
    out = mcp_server.cut_utterance_tool(path, 0, review_required=False)
    assert json.loads(out)["operation"] == "cut_utterance"
    out2 = mcp_server.cut_words_tool(path, "host", 0, 0, review_required=False)
    assert json.loads(out2)["operation"] == "cut_words"


def test_apply_edit_plan_mcp(tmp_path):
    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws))
    plan = json.dumps(
        [
            {
                "track_id": "host",
                "type": "remove",
                "start": 0.0,
                "end": 0.5,
                "reason": "test",
            }
        ]
    )
    out = mcp_server.apply_edit_plan_tool(path, plan, review_required=False)
    data = json.loads(out)
    assert data["operation"] == "apply_edit_plan"
    assert data["entries_added"] >= 1


def test_export_transcript_mcp(tmp_path):
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance

    ws = tmp_path / "workspace"
    path = mcp_server.episode_create(str(ws), name="show")
    proj = load_project(Path(path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="Line",
            )
        ]
    )
    save_project(proj, Path(path))
    out = mcp_server.export_transcript(path)
    assert out.endswith(".md")
