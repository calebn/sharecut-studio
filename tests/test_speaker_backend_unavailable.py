"""The speaker features say "unavailable" when no real backend is installed, not run on the mock (#1999)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from podcast_mcp.engines import speaker_id
from podcast_mcp.engines.speaker_id import (
    MockSpeakerBackend,
    SpeakerBackendUnavailable,
    resolve_speaker_backend,
    speaker_doctor,
)
from podcast_mcp.models import EpisodeProject, Track, TrackRole, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media import SpeakerService


@pytest.fixture
def no_real_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """A machine with neither torch/speechbrain nor resemblyzer, and no mock opt-in."""
    monkeypatch.delenv(speaker_id.MOCK_BACKEND_ENV, raising=False)
    monkeypatch.setitem(sys.modules, "torch", None)

    def missing() -> object:
        raise ImportError("no resemblyzer", name="resemblyzer")

    monkeypatch.setattr(speaker_id, "_import_voice_encoder", missing)


def test_auto_without_a_real_backend_is_unavailable(no_real_backend: None) -> None:
    for name in (None, "auto"):
        with pytest.raises(SpeakerBackendUnavailable) as caught:
            resolve_speaker_backend(name)
        assert caught.value.code == "speaker_backend_unavailable"
        assert "isn't available on this computer" in str(caught.value)
        assert isinstance(caught.value, ImportError)


def test_the_mock_is_still_there_when_asked_for(
    no_real_backend: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert isinstance(resolve_speaker_backend("mock"), MockSpeakerBackend)
    assert isinstance(resolve_speaker_backend(prefer_mock=True), MockSpeakerBackend)
    monkeypatch.setenv(speaker_id.MOCK_BACKEND_ENV, "mock")
    assert isinstance(resolve_speaker_backend(), MockSpeakerBackend)


def test_doctor_does_not_offer_the_mock_as_a_backend(no_real_backend: None) -> None:
    assert speaker_doctor() == {"available_backends": [], "recommended": None}


def _service(tmp_path: Path) -> SpeakerService:
    project = EpisodeProject.create("spk_unavailable", str(tmp_path))
    project.tracks = [Track(id="host", role=TrackRole.DIALOGUE, label="Host")]
    path = tmp_path / "episode.project.json"
    save_project(project, path)
    return SpeakerService(ProjectWorkspace.open(path))


def test_service_calls_report_unavailable(no_real_backend: None, tmp_path: Path) -> None:
    service = _service(tmp_path)
    with pytest.raises(SpeakerBackendUnavailable) as caught:
        service.enroll(track_id="host", speaker_id="Ann", start_sec=0.0, end_sec=3.0)
    assert caught.value.code == "speaker_backend_unavailable"


def test_audition_context_leaves_speaker_roles_out(
    no_real_backend: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from podcast_mcp.edits import audition_context

    project = EpisodeProject.create("spk_unavailable", str(tmp_path))
    monkeypatch.setattr(speaker_id, "load_all_profiles", lambda _project: {"Ann": object()})
    assert audition_context._speaker_roles_for_window(project, ["host"], 0.0, 1.0) is None
