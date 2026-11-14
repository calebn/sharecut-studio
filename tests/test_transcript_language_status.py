from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Track, Transcript, load_project, save_project


def _project(path: Path, transcripts: list[Transcript]) -> Path:
    project = load_project(path)
    project.tracks = [
        Track(id="host", label="Track 1", speaker="Priya"),
        Track(id="guest", label="Track 2"),
        Track(id="cohost", label="Track 3", speaker="Sam"),
    ]
    project.transcripts = transcripts
    save_project(project, path)
    return path


def _get(path: Path, **params: str):
    client = TestClient(create_app(), raise_server_exceptions=False)
    return client.get("/api/transcript/language-status", params={"path": str(path), **params})


def test_stale_and_edited_stale_tracks_are_listed_in_track_order(minimal_project) -> None:
    _project(
        minimal_project,
        [
            Transcript(track_id="guest", language="en", asr_language="en"),
            Transcript(track_id="host", language="en", asr_language="en", user_edited=True),
            Transcript(track_id="cohost", language="es", asr_language="es"),
        ],
    )
    response = _get(minimal_project, language="es")
    assert response.status_code == 200
    assert response.json() == {
        "language": "es",
        "stale_tracks": [
            {"track_id": "host", "name": "Priya", "recorded": "en"},
            {"track_id": "guest", "name": "Track 2", "recorded": "en"},
        ],
        "edited_stale_tracks": [{"track_id": "host", "name": "Priya", "recorded": "en"}],
    }


@pytest.mark.parametrize("language", [None, "", "auto", "AUTO"])
def test_auto_and_empty_language_never_make_a_track_stale(minimal_project, language) -> None:
    _project(minimal_project, [Transcript(track_id="host", language="en", asr_language="en")])
    params = {} if language is None else {"language": language}
    assert _get(minimal_project, **params).json() == {
        "language": None,
        "stale_tracks": [],
        "edited_stale_tracks": [],
    }


def test_same_language_in_another_spelling_is_not_stale(minimal_project) -> None:
    _project(minimal_project, [Transcript(track_id="host", language="en", asr_language="en")])
    assert _get(minimal_project, language="EN-us").json() == {
        "language": "en",
        "stale_tracks": [],
        "edited_stale_tracks": [],
    }


@pytest.mark.parametrize(
    ("language", "stale"),
    [("en", False), ("de", True)],
)
def test_legacy_transcript_is_compared_by_its_language(minimal_project, language, stale) -> None:
    _project(minimal_project, [Transcript(track_id="host", language="en", asr_language=None)])
    body = _get(minimal_project, language=language).json()
    assert [row["track_id"] for row in body["stale_tracks"]] == (["host"] if stale else [])


def test_asr_language_wins_over_the_legacy_language_field(minimal_project) -> None:
    _project(minimal_project, [Transcript(track_id="host", language="en", asr_language="de")])
    assert _get(minimal_project, language="en").json()["stale_tracks"] == [
        {"track_id": "host", "name": "Priya", "recorded": "de"}
    ]


def test_unknown_language_code_is_normalized_and_differs(minimal_project) -> None:
    _project(minimal_project, [Transcript(track_id="host", language="en", asr_language="en")])
    body = _get(minimal_project, language="Xx_YY").json()
    assert body["language"] == "xx"
    assert [row["track_id"] for row in body["stale_tracks"]] == ["host"]


def test_transcript_without_a_track_is_ignored(minimal_project) -> None:
    _project(minimal_project, [Transcript(track_id="gone", language="en", asr_language="en")])
    assert _get(minimal_project, language="es").json()["stale_tracks"] == []


def test_two_transcripts_of_one_track_list_it_once(minimal_project) -> None:
    _project(
        minimal_project,
        [
            Transcript(track_id="host", source_id="a", language="en", asr_language="en"),
            Transcript(
                track_id="host", source_id="b", language="en", asr_language="en", user_edited=True
            ),
        ],
    )
    body = _get(minimal_project, language="es").json()
    assert len(body["stale_tracks"]) == 1
    assert len(body["edited_stale_tracks"]) == 1


def test_route_requires_a_project_path() -> None:
    client = TestClient(create_app(), raise_server_exceptions=False)
    assert client.get("/api/transcript/language-status").status_code == 422
