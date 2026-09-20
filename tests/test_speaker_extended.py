from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines.speaker_id import (
    MockSpeakerBackend,
    ResemblyzerBackend,
    SpeakerProfile,
    SpeechBrainBackend,
    WindowScore,
    _bleed_windows,
    _cosine_similarity,
    enroll_track,
    list_profiles,
    load_profile,
    resolve_speaker_backend,
    run_speaker_attribution,
    score_window,
    speaker_doctor,
)
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services import ProjectWorkspace, SpeakerService
from podcast_mcp.transcript_context import SpeakerIdConfig, TranscriptContext


def _speaker_project(tmp_path: Path, sample_wav: Path):
    from podcast_mcp.models import EpisodeProject, save_project

    project = EpisodeProject.create("speaker", str(tmp_path))
    project.ensure_dirs()
    raw = project.raw_dir()
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.2, end=0.8, confidence=0.95),
                TranscriptWord(text="again", start=1.0, end=1.6, confidence=0.92),
            ],
        )
    ]
    path = save_project(project)
    return path, project


def test_enroll_track_writes_profile(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_enrollment_sec=0.5, min_enrollment_confidence=0.5)
    backend = MockSpeakerBackend()
    with patch(
        "podcast_mcp.engines.speaker_id.load_mono_window",
        return_value=np.linspace(-0.1, 0.1, 8000, dtype=np.float32),
    ):
        profile = enroll_track(project, "host", cfg, backend)
    assert profile is not None
    assert profile.track_id == "host"
    loaded = load_profile(project, "host")
    assert loaded is not None
    assert list_profiles(project)


def test_score_window_with_profiles(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig()
    backend = MockSpeakerBackend()
    emb = backend.embed(np.ones(8000, dtype=np.float32), 16000)
    profiles = {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=emb.tolist(),
            enrollment_sec=1.0,
            stem_hash="abc",
            home_track_id="host",
        )
    }
    with patch(
        "podcast_mcp.engines.speaker_id.load_mono_window",
        return_value=np.ones(8000, dtype=np.float32),
    ):
        ws = score_window(project, "host", 0.0, 1.0, cfg, backend, profiles=profiles)
    assert ws is not None
    assert ws.best_track_id == "host"


def test_speaker_service_compare_and_attribute(tmp_path, sample_wav):
    from podcast_mcp.engines.speaker_id import WindowScore

    path, _ = _speaker_project(tmp_path, sample_wav)
    ws = ProjectWorkspace.open(path)
    ctx = TranscriptContext()
    score = WindowScore(
        track_id="host",
        start_sec=0.0,
        end_sec=1.0,
        scores={"host": 0.9},
        best_track_id="host",
        margin=0.5,
    )
    with (
        patch("podcast_mcp.services.speaker.load_transcript_context", return_value=ctx),
        patch(
            "podcast_mcp.services.speaker.resolve_speaker_backend",
            return_value=MockSpeakerBackend(),
        ),
    ):
        with patch("podcast_mcp.services.speaker.score_window", return_value=score):
            compare = SpeakerService(ws).compare_pair("host", 0.0, 1.0, "host", 1.0, 2.0)
        assert compare["same_speaker_likely"] is True
        with patch(
            "podcast_mcp.services.speaker.run_speaker_attribution",
            return_value={"applied": 0},
        ):
            dry = SpeakerService(ws).attribute(dry_run=True)
            assert dry["applied"] == 0


def test_run_speaker_attribution_dry_run(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    ctx = TranscriptContext(speaker_id=SpeakerIdConfig())
    with patch(
        "podcast_mcp.engines.speaker_id.resolve_speaker_backend",
        return_value=MockSpeakerBackend(),
    ):
        result = run_speaker_attribution(project, ctx, dry_run=True)
    assert isinstance(result, dict)


def _two_speaker_bleed_project(tmp_path: Path, sample_wav: Path):
    from podcast_mcp.models import EpisodeProject, save_project

    project = EpisodeProject.create("speaker_bleed", str(tmp_path))
    project.ensure_dirs()
    raw = project.raw_dir()
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    (raw / "guest.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=5.0),
        ),
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="guest",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="hello",
                    start=0.2,
                    end=0.8,
                    confidence=0.95,
                    audibility_status="bleed",
                ),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="hi", start=0.2, end=0.8, confidence=0.95),
            ],
        ),
    ]
    path = save_project(project)
    return path, project


def test_load_profile_miss_cases(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    assert load_profile(project, "missing") is None
    project.tracks[0].media = None
    assert load_profile(project, "host") is None


def test_list_profiles_reads_json_files(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    profile_dir = project.artifacts_dir() / "speaker_profiles"
    profile_dir.mkdir(parents=True, exist_ok=True)
    profile_path = profile_dir / "host_abc123.json"
    profile_path.write_text(
        '{"track_id": "host", "embedding": [1.0], "enrollment_sec": 1.0, "stem_hash": "abc123"}',
        encoding="utf-8",
    )
    listed = list_profiles(project)
    assert len(listed) == 1
    assert listed[0]["track_id"] == "host"
    assert listed[0]["path"] == str(profile_path)


def test_run_speaker_attribution_apply_path(tmp_path, sample_wav):
    _, project = _two_speaker_bleed_project(tmp_path, sample_wav)
    ctx = TranscriptContext(speaker_id=SpeakerIdConfig(min_margin=0.1, auto_suppress=True))
    host_emb = MockSpeakerBackend().embed(np.linspace(-0.1, 0.1, 8000, dtype=np.float32), 16000)
    guest_emb = MockSpeakerBackend().embed(np.ones(8000, dtype=np.float32), 16000)
    profiles = {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=host_emb.tolist(),
            enrollment_sec=1.0,
            stem_hash="host",
            home_track_id="host",
        ),
        "guest": SpeakerProfile(
            speaker_id="guest",
            track_id="guest",
            embedding=guest_emb.tolist(),
            enrollment_sec=1.0,
            stem_hash="guest",
            home_track_id="guest",
        ),
    }
    bleed_score = WindowScore(
        track_id="host",
        start_sec=0.2,
        end_sec=0.8,
        scores={"host": 0.2, "guest": 0.95},
        best_track_id="guest",
        margin=0.75,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.enroll_track",
            side_effect=lambda _p, tid, *_a, **_k: profiles.get(tid),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=bleed_score,
        ),
        patch("podcast_mcp.edits.transcript_sync.rebuild_combined") as rebuild,
    ):
        result = run_speaker_attribution(
            project,
            ctx,
            dry_run=False,
            backend=MockSpeakerBackend(),
        )
    assert result["attributions_changed"] == 1
    assert result["windows_scored"] == 1
    rebuild.assert_called_once()
    word = project.transcript_for_track("host").words[0]
    assert word.speaker_match_track == "guest"
    assert word.suppressed is True


def test_resolve_speaker_backend_resemblyzer_skip():
    with (
        patch(
            "podcast_mcp.engines.speaker_id.SpeechBrainBackend",
            side_effect=ImportError("no speechbrain"),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.ResemblyzerBackend",
            side_effect=ImportError("no resemblyzer"),
        ),
    ):
        backend = resolve_speaker_backend("auto")
    assert backend.name() == "mock"


def test_resolve_speaker_backend_unavailable_raises():
    with (
        patch(
            "podcast_mcp.engines.speaker_id.SpeechBrainBackend",
            side_effect=ImportError("no speechbrain"),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.ResemblyzerBackend",
            side_effect=ImportError("no resemblyzer"),
        ),
        pytest.raises(ImportError, match="speaker backend unavailable"),
    ):
        resolve_speaker_backend("resemblyzer")


def test_resemblyzer_backend_resamples(monkeypatch):
    backend = ResemblyzerBackend()
    captured: dict[str, object] = {}

    class FakeEncoder:
        def embed_utterance(self, samples):
            captured["size"] = samples.size
            captured["rate"] = samples.dtype
            return np.ones(256, dtype=np.float64)

    monkeypatch.setattr(backend, "_encoder", FakeEncoder())
    samples = np.linspace(-1.0, 1.0, 48000, dtype=np.float32)
    emb = backend.embed(samples, 48000)
    assert emb.dtype == np.float32
    assert captured["size"] == 16000


def test_mock_backend_empty_samples_and_cosine_zero():
    backend = MockSpeakerBackend()
    empty = backend.embed(np.array([], dtype=np.float32), 16000)
    assert empty.shape == (8,)
    assert _cosine_similarity(np.zeros(8), np.ones(8)) == 0.0


def test_speaker_profile_roundtrip():
    profile = SpeakerProfile(
        speaker_id="host",
        track_id="host",
        embedding=[1.0, 2.0],
        enrollment_sec=2.5,
        stem_hash="abc",
        confidence=0.8,
    )
    data = profile.to_dict()
    restored = SpeakerProfile.from_dict(data)
    assert restored.track_id == "host"
    assert restored.embedding == [1.0, 2.0]
    assert restored.confidence == 0.8


def test_enroll_track_miss_no_transcript(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    project.transcripts = []
    cfg = SpeakerIdConfig()
    assert enroll_track(project, "host", cfg, MockSpeakerBackend()) is None


def test_score_window_loads_profiles_from_cache(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig()
    backend = MockSpeakerBackend()
    emb = backend.embed(np.ones(8000, dtype=np.float32), 16000)
    profile_dir = project.artifacts_dir() / "speaker_profiles"
    profile_dir.mkdir(parents=True, exist_ok=True)
    stem_hash = "cached"
    (profile_dir / f"host_{stem_hash}.json").write_text(
        json.dumps(
            SpeakerProfile(
                speaker_id="host",
                track_id="host",
                embedding=emb.tolist(),
                enrollment_sec=1.0,
                stem_hash=stem_hash,
                home_track_id="host",
            ).to_dict()
        ),
        encoding="utf-8",
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id._stem_hash",
            return_value=stem_hash,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.load_mono_window",
            return_value=np.ones(8000, dtype=np.float32),
        ),
    ):
        ws = score_window(project, "host", 0.0, 1.0, cfg, backend)
    assert ws is not None
    assert ws.best_track_id == "host"


def test_enroll_track_miss_no_audio_file(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    (project.workspace_path() / "raw" / "host.wav").unlink()
    cfg = SpeakerIdConfig(min_enrollment_sec=0.5)
    assert enroll_track(project, "host", cfg, MockSpeakerBackend()) is None


def test_enroll_track_filters_ineligible_words(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    project.transcripts[0].words = [
        TranscriptWord(text="skip", start=0.0, end=0.5, suppressed=True),
        TranscriptWord(
            text="bleed",
            start=0.5,
            end=1.0,
            confidence=0.95,
            audibility_status="bleed",
        ),
        TranscriptWord(
            text="quiet",
            start=1.0,
            end=1.5,
            confidence=0.1,
            audibility_status="audible",
        ),
        TranscriptWord(
            text="tiny",
            start=1.5,
            end=1.52,
            confidence=0.95,
            audibility_status="audible",
        ),
    ]
    cfg = SpeakerIdConfig(min_enrollment_sec=0.5, min_enrollment_confidence=0.5)
    assert enroll_track(project, "host", cfg, MockSpeakerBackend()) is None


def test_load_profile_cache_missing(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    assert load_profile(project, "host") is None


def test_list_profiles_empty_when_dir_missing(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    profile_dir = project.artifacts_dir() / "speaker_profiles"
    if profile_dir.exists():
        profile_dir.rmdir()
    assert list_profiles(project) == []


def test_score_window_miss_cases(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig()
    backend = MockSpeakerBackend()
    (project.workspace_path() / "raw" / "host.wav").unlink()
    assert score_window(project, "host", 0.0, 1.0, cfg, backend) is None

    _, project = _speaker_project(tmp_path, sample_wav)
    project.tracks[0].role = TrackRole.MUSIC
    with patch(
        "podcast_mcp.engines.speaker_id.load_mono_window",
        return_value=np.ones(8000, dtype=np.float32),
    ):
        assert score_window(project, "host", 0.0, 1.0, cfg, backend) is None


def test_bleed_windows_filters_short_and_non_bleed(tmp_path, sample_wav):
    _, project = _two_speaker_bleed_project(tmp_path, sample_wav)
    project.transcripts[0].words.extend(
        [
            TranscriptWord(
                text="sup",
                start=2.0,
                end=2.5,
                suppressed=True,
                audibility_status="bleed",
            ),
            TranscriptWord(
                text="audible",
                start=2.5,
                end=3.0,
                audibility_status="audible",
            ),
            TranscriptWord(
                text="short",
                start=3.0,
                end=3.1,
                audibility_status="bleed",
            ),
        ]
    )
    windows = _bleed_windows(project, SpeakerIdConfig(min_window_sec=0.3))
    assert len(windows) == 2
    assert windows[0][0] == "host"


def test_run_speaker_attribution_missing_transcript_word(tmp_path, sample_wav):
    _, project = _two_speaker_bleed_project(tmp_path, sample_wav)
    ctx = TranscriptContext(speaker_id=SpeakerIdConfig(min_margin=0.1))
    profiles = {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=[1.0],
            enrollment_sec=1.0,
            stem_hash="h",
        ),
        "guest": SpeakerProfile(
            speaker_id="guest",
            track_id="guest",
            embedding=[1.0],
            enrollment_sec=1.0,
            stem_hash="g",
        ),
    }
    bleed_score = WindowScore(
        track_id="host",
        start_sec=0.2,
        end_sec=0.8,
        scores={"host": 0.2, "guest": 0.95},
        best_track_id="guest",
        margin=0.75,
    )

    def fake_bleed_windows(_project, _cfg):
        return [("host", 99, 0.2, 0.8)]

    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.enroll_track",
            side_effect=lambda _p, tid, *_a, **_k: profiles.get(tid),
        ),
        patch(
            "podcast_mcp.engines.speaker_id._bleed_windows",
            side_effect=fake_bleed_windows,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=bleed_score,
        ),
    ):
        result = run_speaker_attribution(
            project,
            ctx,
            dry_run=False,
            backend=MockSpeakerBackend(),
        )
    assert result["attributions_changed"] == 0


def test_run_speaker_attribution_skip_branches(tmp_path, sample_wav):
    _, project = _two_speaker_bleed_project(tmp_path, sample_wav)
    project.transcripts[0].words = [
        TranscriptWord(
            text="one",
            start=0.2,
            end=0.8,
            confidence=0.95,
            audibility_status="bleed",
        ),
        TranscriptWord(
            text="two",
            start=1.0,
            end=1.6,
            confidence=0.95,
            audibility_status="bleed",
        ),
        TranscriptWord(
            text="three",
            start=2.0,
            end=2.6,
            confidence=0.95,
            audibility_status="bleed",
        ),
    ]
    ctx = TranscriptContext(speaker_id=SpeakerIdConfig(min_margin=0.5))
    profiles = {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=[1.0],
            enrollment_sec=1.0,
            stem_hash="h",
        ),
        "guest": SpeakerProfile(
            speaker_id="guest",
            track_id="guest",
            embedding=[1.0],
            enrollment_sec=1.0,
            stem_hash="g",
        ),
    }
    low_margin = WindowScore(
        track_id="host",
        start_sec=0.2,
        end_sec=0.8,
        scores={"host": 0.9, "guest": 0.95},
        best_track_id="guest",
        margin=0.05,
    )
    same_track = WindowScore(
        track_id="host",
        start_sec=1.0,
        end_sec=1.6,
        scores={"host": 0.95, "guest": 0.2},
        best_track_id="host",
        margin=0.75,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.enroll_track",
            side_effect=lambda _p, tid, *_a, **_k: profiles.get(tid),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            side_effect=[None, low_margin, same_track],
        ),
    ):
        result = run_speaker_attribution(
            project,
            ctx,
            dry_run=True,
            backend=MockSpeakerBackend(),
        )
    assert result["attributions_changed"] == 0
    assert result["windows_scored"] == 2


def test_run_speaker_attribution_progress_every_fifty(tmp_path, sample_wav):
    _, project = _speaker_project(tmp_path, sample_wav)
    words = [
        TranscriptWord(
            text=f"w{i}",
            start=float(i),
            end=float(i) + 0.5,
            audibility_status="bleed",
            confidence=0.95,
        )
        for i in range(55)
    ]
    project.transcripts[0].words = words
    ctx = TranscriptContext(speaker_id=SpeakerIdConfig(min_margin=0.1))
    profile = SpeakerProfile(
        speaker_id="host",
        track_id="host",
        embedding=[1.0, 2.0],
        enrollment_sec=1.0,
        stem_hash="h",
        home_track_id="host",
    )
    score = WindowScore(
        track_id="host",
        start_sec=0.0,
        end_sec=0.5,
        scores={"host": 0.2, "guest": 0.9},
        best_track_id="guest",
        margin=0.7,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.enroll_track",
            return_value=profile,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=score,
        ),
    ):
        result = run_speaker_attribution(
            project,
            ctx,
            dry_run=True,
            backend=MockSpeakerBackend(),
        )
    assert result["windows_scored"] == 55
    assert result["attributions_would_change"] == 55
    assert result["attributions_changed"] == 0


def test_resolve_speaker_backend_prefer_mock():
    backend = resolve_speaker_backend(prefer_mock=True)
    assert backend.name() == "mock"


def test_speechbrain_backend_lazy_load(monkeypatch):
    import sys

    created: list[str] = []

    class FakeEncoderClassifier:
        @classmethod
        def from_hparams(cls, **_kwargs):
            created.append("loaded")
            return cls()

    fake_sb = type(
        "speechbrain",
        (),
        {
            "inference": type(
                "inference",
                (),
                {"speaker": type("speaker", (), {"EncoderClassifier": FakeEncoderClassifier})()},
            )()
        },
    )()
    monkeypatch.setitem(sys.modules, "speechbrain", fake_sb)
    monkeypatch.setitem(
        sys.modules,
        "speechbrain.inference",
        fake_sb.inference,
    )
    monkeypatch.setitem(
        sys.modules,
        "speechbrain.inference.speaker",
        fake_sb.inference.speaker,
    )
    backend = SpeechBrainBackend()
    assert backend._load() is backend._classifier
    assert created == ["loaded"]


def test_speechbrain_backend_embed(monkeypatch):
    import sys

    backend = SpeechBrainBackend()
    captured: dict[str, object] = {}

    class FakeTensor:
        def __init__(self, data, dtype=None):
            self._data = np.asarray(data, dtype=np.float32)

        def unsqueeze(self, dim):
            return FakeTensor(self._data[np.newaxis, :])

        @property
        def shape(self):
            return self._data.shape

        def sum(self):
            return FakeTensor(np.array([float(self._data.sum())]))

        def squeeze(self):
            return FakeTensor(self._data.reshape(-1))

        def detach(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return self._data

    class FakeClassifier:
        def encode_batch(self, tensor):
            captured["shape"] = tuple(tensor.shape)
            return tensor.sum()

    class FakeTorch:
        float32 = np.float32

        @staticmethod
        def tensor(data, dtype=None):
            return FakeTensor(data, dtype=dtype)

    monkeypatch.setattr(backend, "_classifier", FakeClassifier())
    monkeypatch.setitem(sys.modules, "torch", FakeTorch())
    emb = backend.embed(np.ones(16000, dtype=np.float32), 16000)
    assert emb.dtype == np.float32
    assert captured["shape"] == (1, 16000)


def test_resemblyzer_backend_lazy_load(monkeypatch):
    backend = ResemblyzerBackend()
    created: list[str] = []

    class FakeVoiceEncoder:
        def __init__(self):
            created.append("loaded")

        def embed_utterance(self, samples):
            return np.ones(8, dtype=np.float32)

    monkeypatch.setitem(
        __import__("sys").modules,
        "resemblyzer",
        type("m", (), {"VoiceEncoder": FakeVoiceEncoder})(),
    )
    backend._encoder = None
    emb = backend.embed(np.ones(16000, dtype=np.float32), 16000)
    assert created == ["loaded"]
    assert emb.shape == (8,)


def test_speaker_doctor_handles_import_errors():
    with patch(
        "podcast_mcp.engines.speaker_id.resolve_speaker_backend",
        side_effect=[MockSpeakerBackend(), ImportError("no sb"), ImportError("no rz")],
    ):
        doc = speaker_doctor()
    assert doc["available_backends"] == ["mock"]
    assert doc["recommended"] == "mock"


def test_window_score_to_dict():
    score = WindowScore(
        track_id="host",
        start_sec=0.0,
        end_sec=1.0,
        scores={"host": 0.9},
        best_track_id="host",
        margin=0.9,
    )
    data = score.to_dict()
    assert data["best_track_id"] == "host"
    assert data["margin"] == 0.9
