from __future__ import annotations

import pytest

from podcast_mcp.edits.transcript_correct import TranscriptTextChangedError
from podcast_mcp.edits.transcript_replace import plan_transcript_replacement
from podcast_mcp.models import Track, Transcript, TranscriptWord, load_project
from podcast_mcp.services import EditService, HistoryService, ProjectWorkspace


def _word(text: str, start: float, **fields) -> TranscriptWord:
    return TranscriptWord(text=text, start=start, end=start + 0.5, **fields)


def _project(path):
    project = load_project(path)
    project.tracks = [Track(id="host", label="Host", role="dialogue", speaker="Host")]
    project.transcripts = [
        Transcript(track_id="host", words=[_word("Ada,", 0), _word("ADA", 1), _word("Adaline", 2)]),
        Transcript(track_id="host", source_id="take2", words=[_word("\u2018Ada\u2019", 10)]),
    ]
    return project


def test_preview_matches_whole_tokens_case_and_unicode_punctuation_on_every_source(minimal_project):
    project = _project(minimal_project)
    preview = plan_transcript_replacement(project, "Ada", "Mira").preview()
    assert [(row["source_id"], row["before"], row["after"]) for row in preview["matches"]] == [
        (None, "Ada,", "Mira,"),
        (None, "ADA", "Mira"),
        ("take2", "\u2018Ada\u2019", "\u2018Mira\u2019"),
    ]
    assert (
        plan_transcript_replacement(project, "Ada", "Mira", match_case=True).preview()["count"] == 2
    )
    assert project.transcripts[0].words[0].text == "Ada,"


def test_preview_never_matches_across_suppressed_or_ignored_words(minimal_project):
    project = _project(minimal_project)
    project.transcripts[0].words = [
        _word("Ada", 0, suppressed=True),
        _word("Ada", 1, ignored=True),
        _word("Ada", 2),
        _word("Lovelace", 3, suppressed=True),
        _word("Ada", 4),
        _word("Lovelace", 5),
    ]
    preview = plan_transcript_replacement(project, "Ada Lovelace", "Mira Chen").preview()
    assert preview["count"] == 1
    assert preview["matches"][0]["start_word_index"] == 4
    assert preview["skipped_words"] == 3


def _workspace(path):
    ws = ProjectWorkspace.open(path)
    ws.project.tracks = _project(path).tracks
    ws.project.transcripts = _project(path).transcripts
    ws.save()
    return ws


def test_replace_all_sources_preserves_times_flags_and_is_one_undo(minimal_project):
    ws = _workspace(minimal_project)
    word = ws.project.transcripts[0].words[0]
    word.audibility_locked = True
    word.alignment_score = 0.3
    ws.save()
    before = [transcript.model_dump(mode="json") for transcript in ws.project.transcripts]
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada", "Mira")
    assert svc.replace_transcript_matches("Ada", "Mira", preview["preview_token"]) == 3
    assert [w.text for w in ws.project.transcripts[0].words] == ["Mira,", "Mira", "Adaline"]
    assert ws.project.transcripts[1].words[0].text == "\u2018Mira\u2019"
    assert ws.project.transcripts[0].words[0].start == 0
    assert ws.project.transcripts[0].words[0].end == 0.5
    assert ws.project.transcripts[0].words[0].audibility_locked
    assert ws.project.transcripts[0].words[0].alignment_score is None
    assert all(transcript.user_edited for transcript in ws.project.transcripts)
    assert ws.project.transcripts[1].source_id == "take2"
    HistoryService(ws).undo(rerender=False)
    assert [transcript.model_dump(mode="json") for transcript in ws.project.transcripts] == before


def test_different_token_counts_apply_reverse_indices_and_preserve_outer_spans(minimal_project):
    ws = _workspace(minimal_project)
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                _word("Ada", 0),
                _word("Lovelace,", 1),
                _word("and", 2),
                _word("Ada", 3),
                _word("Lovelace.", 4),
            ],
        )
    ]
    ws.save()
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada Lovelace", "Mira")
    assert all(row["retimes_words"] for row in preview["matches"])
    assert svc.replace_transcript_matches("Ada Lovelace", "Mira", preview["preview_token"]) == 2
    assert [(w.text, w.start, w.end) for w in ws.project.transcripts[0].words] == [
        ("Mira,", 0, 1.5),
        ("and", 2, 2.5),
        ("Mira.", 3, 4.5),
    ]


@pytest.mark.parametrize("change", ["text", "new match", "flags", "source", "timing"])
def test_stale_preview_rejects_every_replacement_before_history(minimal_project, change):
    ws = _workspace(minimal_project)
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada", "Mira")
    if change == "text":
        ws.project.transcripts[1].words[0].text = "Lin"
    elif change == "new match":
        ws.project.transcripts[0].words.append(_word("Ada", 5))
    elif change == "flags":
        ws.project.transcripts[0].words[0].ignored = True
    elif change == "source":
        ws.project.transcripts[1].source_id = "different"
    else:
        ws.project.transcripts[0].words[0].end = 0.8
    ws.save()
    before = ws.project.model_dump(mode="json")
    with pytest.raises(TranscriptTextChangedError, match="Preview again"):
        svc.replace_transcript_matches("Ada", "Mira", preview["preview_token"])
    assert ws.project.model_dump(mode="json") == before


@pytest.mark.parametrize("search,replacement", [("", "Mira"), ("...", "Mira"), ("Ada", "")])
def test_empty_search_or_replacement_is_rejected(minimal_project, search, replacement):
    with pytest.raises(ValueError):
        plan_transcript_replacement(_project(minimal_project), search, replacement)


def test_preview_route_and_durable_batch_command_share_the_service(minimal_project):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand

    ws = _workspace(minimal_project)
    client = TestClient(create_app(served_project=ws.path))
    response = client.post(
        "/api/transcript/replacement-preview",
        json={
            "path": str(ws.path),
            "search": "Ada",
            "replacement": "Mira",
            "match_case": False,
        },
    )
    assert response.status_code == 200
    preview = response.json()
    payload = {
        "search": "Ada",
        "replacement": "Mira",
        "match_case": False,
        "preview_token": preview["preview_token"],
    }
    sync = DocumentSyncService(ws)
    with pytest.raises(PermissionError):
        sync.submit(
            DocumentCommand(
                type="ReplaceTranscriptMatches",
                payload=payload,
                client_id="guest",
                role="guest",
                client_seq=1,
            ),
            capabilities=["edit"],
        )
    result = sync.submit(
        DocumentCommand(
            type="ReplaceTranscriptMatches",
            payload=payload,
            client_id="host",
            role="viewer",
            client_seq=1,
        )
    )
    assert result["command"]["payload"]["result"]["replaced"] == 3
    assert ws.project.transcripts[1].words[0].text == "\u2018Mira\u2019"


def test_preview_noop_has_no_history_or_confidence_change(minimal_project):
    ws = _workspace(minimal_project)
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada", "Ada", match_case=True)
    assert preview["count"] == 0
    before = ws.project.model_dump(mode="json")
    assert (
        svc.replace_transcript_matches("Ada", "Ada", preview["preview_token"], match_case=True) == 0
    )
    assert ws.project.model_dump(mode="json") == before


@pytest.mark.parametrize(
    "old,search,new,expected",
    [
        ("Ada,", "Ada", "Bea,", "Bea,"),
        ("\u2018Ada\u2019", "Ada", '"Bea"', '"Bea"'),
        ("\u2018Ada", "Ada Lovelace", '"Bea!"', '"Bea!"'),
    ],
)
def test_explicit_replacement_punctuation_takes_precedence(
    minimal_project, old, search, new, expected
):
    project = _project(minimal_project)
    project.transcripts = [Transcript(track_id="host", words=[_word(old, 0)])]
    if " " in search:
        project.transcripts[0].words.append(_word("Lovelace\u2019", 1))
    preview = plan_transcript_replacement(project, search, new).preview()
    assert preview["matches"][0]["after"] == expected


def test_replace_common_term_is_not_capped_at_two_thousand(minimal_project):
    project = _project(minimal_project)
    project.transcripts = [
        Transcript(track_id="host", words=[_word("Ada", index) for index in range(2001)])
    ]
    assert plan_transcript_replacement(project, "Ada", "Mira").preview()["count"] == 2001


@pytest.mark.parametrize("replacement", ["Bea ,", "Bea \u200b", "..."])
def test_invalid_replacement_tokens_rejected_at_preview_without_mutation(
    minimal_project, replacement
):
    ws = _workspace(minimal_project)
    before = ws.project.model_dump(mode="json")
    with pytest.raises(ValueError, match="Each replacement token"):
        EditService(ws).preview_transcript_replacement("Ada", replacement)
    assert ws.project.model_dump(mode="json") == before


def test_phrase_expansion_preserves_explicit_lock_and_outer_span(minimal_project):
    ws = _workspace(minimal_project)
    ws.project.transcripts[0].words[0].audibility_locked = True
    ws.save()
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada", "Ada Lovelace")
    svc.replace_transcript_matches("Ada", "Ada Lovelace", preview["preview_token"])
    words = ws.project.transcripts[0].words
    assert [(w.text, w.start, w.end) for w in words[:2]] == [
        ("Ada", 0, 0.25),
        ("Lovelace,", 0.25, 0.5),
    ]
    assert all(w.audibility_locked for w in words[:2])
    assert not any(w.audibility_locked for w in words[2:])
    assert not any(w.audibility_locked for w in ws.project.transcripts[1].words)


def test_equal_count_phrase_preserves_individual_times_and_flags(minimal_project):
    ws = _workspace(minimal_project)
    ws.project.transcripts[0].words = [
        _word("Ada", 0, audibility_locked=True),
        _word("Lovelace,", 2),
    ]
    ws.save()
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada Lovelace", "Mira Chen")
    assert not preview["matches"][0]["retimes_words"]
    svc.replace_transcript_matches("Ada Lovelace", "Mira Chen", preview["preview_token"])
    words = ws.project.transcripts[0].words
    assert [(w.text, w.start, w.end, w.audibility_locked) for w in words] == [
        ("Mira", 0, 0.5, True),
        ("Chen,", 2, 2.5, False),
    ]


def test_manual_track_correction_retains_primary_source_scope(minimal_project):
    from podcast_mcp.edits.transcript_correct import correct_word

    project = _project(minimal_project)
    correct_word(project, "host", 0, "Mira")
    assert project.transcripts[0].words[0].text == "Mira"
    assert project.transcripts[1].words[0].text == "\u2018Ada\u2019"


def test_locked_suppressed_and_ignored_words_are_unchanged_by_phrase_expansion(minimal_project):
    ws = _workspace(minimal_project)
    ws.project.transcripts[0].words = [
        _word("Ada", 0, suppressed=True, audibility_locked=True),
        _word("Ada", 1, ignored=True, audibility_locked=True),
        _word("Ada", 2, audibility_locked=True),
    ]
    ws.save()
    before = [word.model_dump() for word in ws.project.transcripts[0].words[:2]]
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada", "Ada Lovelace")
    assert preview["skipped_words"] == 2
    svc.replace_transcript_matches("Ada", "Ada Lovelace", preview["preview_token"])
    words = ws.project.transcripts[0].words
    assert [word.model_dump() for word in words[:2]] == before
    assert all(
        word.audibility_locked and not word.suppressed and not word.ignored for word in words[2:]
    )


def test_relayed_guest_cannot_read_private_replacement_preview(minimal_project):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    ws = _workspace(minimal_project)
    client = TestClient(create_app(served_project=ws.path))
    response = client.post(
        "/api/transcript/replacement-preview",
        headers={"X-Sharecut-Relayed": "1"},
        json={"path": str(ws.path), "search": "Ada", "replacement": "Mira"},
    )
    assert response.status_code == 403
    assert "Ada" not in response.text


def test_stale_batch_http_command_returns_conflict_without_partial_edits(minimal_project):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    ws = _workspace(minimal_project)
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada", "Mira")
    ws.project.transcripts[1].words[0].text = "Lin"
    ws.save()
    before = ws.project.model_dump(mode="json")
    client = TestClient(create_app(served_project=ws.path))
    response = client.post(
        "/api/document/command",
        params={"path": str(ws.path)},
        json={
            "type": "ReplaceTranscriptMatches",
            "client_id": "host",
            "role": "viewer",
            "client_seq": 1,
            "payload": {
                "search": "Ada",
                "replacement": "Mira",
                "preview_token": preview["preview_token"],
            },
        },
    )
    assert response.status_code == 409
    assert load_project(ws.path).model_dump(mode="json") == before


@pytest.mark.parametrize("replacement", ["Mira", "Mira Chen", "Mira Chen Analyst"])
def test_batch_phrase_words_match_existing_manual_phrase_policy(minimal_project, replacement):
    from podcast_mcp.edits.transcript_correct import correct_transcript_phrase

    ws = _workspace(minimal_project)
    ws.project.transcripts[0].words = [
        _word("Ada", 0, alignment_score=0.2, suspect_hallucination=True),
        _word("Lovelace,", 1),
        _word("and", 2),
        _word("Ada", 3),
        _word("Lovelace.", 4),
    ]
    ws.project.transcripts[1].words = [_word("Ada", 10), _word("Lovelace", 11)]
    ws.save()
    svc = EditService(ws)
    preview = svc.preview_transcript_replacement("Ada Lovelace", replacement)
    expected = [transcript.model_copy(deep=True) for transcript in ws.project.transcripts]
    for row in reversed(preview["matches"]):
        transcript = next(tr for tr in expected if tr.source_id == row["source_id"])
        if len(replacement.split()) != 2:
            correct_transcript_phrase(
                transcript, row["start_word_index"], row["end_word_index"], row["after"]
            )
        else:
            from podcast_mcp.edits.transcript_correct import correct_transcript_word

            for index, token in enumerate(row["after"].split(), row["start_word_index"]):
                correct_transcript_word(transcript, index, token)
    svc.replace_transcript_matches("Ada Lovelace", replacement, preview["preview_token"])
    assert [[word.model_dump() for word in tr.words] for tr in ws.project.transcripts] == [
        [word.model_dump() for word in tr.words] for tr in expected
    ]
