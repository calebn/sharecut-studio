from __future__ import annotations

import pytest

from pause_policy_public_helpers import configure, defaults, files, pause, project, workspace
from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.models import ClipMuteRegion, Transcript, TranscriptWord
from podcast_mcp.services.document import EditService
from podcast_mcp.util.coded_error import CodedError


@pytest.mark.parametrize("delivery", ["saved", "automatic", "suggested"])
@pytest.mark.parametrize("mask", ["mute", "ignored"])
def test_unreadable_masked_peer_holds_without_mutating(tmp_path, monkeypatch, delivery, mask):
    configure(monkeypatch, defaults(acoustic=True))
    result = project(tmp_path, guest="corrupt")
    if mask == "mute":
        result.clips[-1].mute_regions = [ClipMuteRegion(start_s=0.2, end_s=0.3)]
    else:
        result.transcripts.append(
            Transcript(
                track_id="guest",
                words=[TranscriptWord(text="ignored", start=0.2, end=0.3, ignored=True)],
            )
        )
    result.edit_decisions = [pause("unreadable-mask", start=0.3, end=4.7, gap=None)]
    ws = workspace(result)
    before = ws.project.model_dump(mode="json")
    before_files = files(tmp_path)
    if delivery == "automatic":
        assert EditService(ws).apply_auto() == 0
    else:
        with pytest.raises(CodedError) as held:
            if delivery == "saved":
                EditService(ws).approve(["unreadable-mask"])
            else:
                apply_for_suggested(
                    ws.project, resolve_pending_preview(ws.project, "unreadable-mask")
                )
        assert held.value.code == "cut_scope_changed"
    assert ws.project.model_dump(mode="json") == before
    assert files(tmp_path) == before_files
