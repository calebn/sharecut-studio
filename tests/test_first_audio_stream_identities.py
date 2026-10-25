from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import multistream_media as media
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import prosody_profile, retained_bleed_alignment
from podcast_mcp.engines import (
    balance,
    bleed_gate,
    gate_fill,
    level_profile,
    play_audit,
    room_tone,
    speaker_id,
    waveform_media,
    waveform_pyramid,
)
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import silence_filter_fingerprint
from podcast_mcp.engines.ffmpeg import AudioProbe
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.engines.prosody import parselmouth_version
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import EpisodeProject, GateFill, GateFillSource, MediaAsset, Track
from podcast_mcp.services.document.play_stems import _PlayStems
from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.project_state import file_revision_key

MAIN_MEDIA_KEY = "aaa47cb2e786ca55e370"
MAIN_SILENCE_FINGERPRINT = "bdfa08a23038fd29f56cb4216a1ef6b3f352a2292fdfa83c195ee14c3949948f"
MAIN_BALANCE_DIGEST = "e240b20362847f7f6656bc8b6a8eab18da442e6bb316305db92eee82a4e8f6b1"
MAIN_RENDER_DIGESTS = {
    "stem": "558036b3cd77ee048840695b9269a1308acdc6910e68a63b82190ab7dd49ec80",
    "proxy": "e834252c259238f496fc0a9785e407d9c2d8e24d462311ef114c89539599e640",
    "gate": "db54399009b2b4e9be66f5272cfb8e4ace7f29729f14427886afacc35075e621",
}
MAIN_POOL_RECORD_NAME = "e8336a18ee202c0f.json"
MAIN_ALIGN_NAME = "asr.word_align_8ddd9e4881f64893.json"


def _project(tmp_path: Path, media_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("Streams", str(tmp_path))
    project.tracks = [
        Track(id="t", label="T", media=MediaAsset(path=str(media_path)), transcript_gate=True)
    ]
    return project


@pytest.fixture
def mono_wav(tmp_path: Path) -> Path:
    return media.single_stream_media(tmp_path)["wav"]


def test_probe_counts_audio_streams(tmp_path: Path, mono_wav: Path) -> None:
    assert probe_media(mono_wav).audio_stream_count == 1
    assert AudioProbe(1.0, 8000, 1).audio_stream_count == 1
    for name in ("st.mkv", "kid.ogg", "two_b.mkv"):
        assert probe_media(media.multistream(tmp_path, name)).audio_stream_count == 2
    assert probe_media(media.video_only(tmp_path)).audio_stream_count == 0


def test_revisions_that_feed_decodes_keep_their_main_values() -> None:
    assert level_profile._RECORD_REV == 2
    assert bleed_gate.BLEED_GATE_REV == 19
    assert room_tone._POOL_REV == 2
    assert waveform_pyramid._BUILD_REVISION == 2
    assert prosody_profile.ALGORITHM_VERSION == 5


def test_pyramid_key_and_silence_fingerprint_keep_the_old_keys() -> None:
    assert waveform_pyramid.media_key("a.wav", 1, 2) == MAIN_MEDIA_KEY
    assert waveform_pyramid.media_key("a.wav", 1, 2, first_stream=True) != MAIN_MEDIA_KEY
    fingerprint = silence_filter_fingerprint([], "abc", AsrOptions())
    assert fingerprint == MAIN_SILENCE_FINGERPRINT
    marked = silence_filter_fingerprint([], "abc", AsrOptions(), first_stream=True)
    assert marked != MAIN_SILENCE_FINGERPRINT


def test_retained_alignment_fingerprint_changes_only_for_several_streams(
    tmp_path: Path, mono_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    defaults = load_defaults()
    monkeypatch.setattr(bleed_gate, "file_revision", lambda _path: (1, 2, 3, 4))
    single = _project(tmp_path, mono_wav)
    off = retained_bleed_alignment._fingerprint(single, defaults=defaults)
    monkeypatch.setattr(bleed_gate, "has_several_audio_streams", lambda _path: True)
    assert retained_bleed_alignment._fingerprint(single, defaults=defaults) != off
    monkeypatch.setattr(bleed_gate, "has_several_audio_streams", lambda _path: False)
    assert retained_bleed_alignment._fingerprint(single, defaults=defaults) == off


def _render_digests(
    monkeypatch: pytest.MonkeyPatch, project: EpisodeProject, workspace: Path
) -> dict[str, str]:
    captured: list[str] = []
    real = play_audit.short_digest

    def capture(raw: str, *args: int) -> str:
        captured.append(raw)
        return real(raw, *args)

    revision = (1, 2, 3, 4)
    monkeypatch.setattr(bleed_gate, "file_revision", lambda _path: revision)
    monkeypatch.setattr(play_audit, "file_revision", lambda _path: revision)
    monkeypatch.setattr(play_audit, "_media_revision", lambda _path: revision)
    monkeypatch.setattr(
        play_audit, "file_stamp", lambda _path: SimpleNamespace(size=10, mtime_ns=20)
    )
    monkeypatch.setattr(play_audit, "short_digest", capture)
    defaults = load_defaults()
    play_audit.track_render_hash(project, "t", defaults=defaults)
    play_audit.proxy_render_hash(project, "t", defaults=defaults)
    gate = json.dumps(
        bleed_gate.bleed_gate_payload(project, "t", defaults=defaults), sort_keys=True
    )

    def digest(raw: str) -> str:
        return sha256(raw.replace(str(workspace), "<ws>").encode()).hexdigest()

    return {"stem": digest(captured[0]), "proxy": digest(captured[1]), "gate": digest(gate)}


def test_single_stream_render_hashes_match_main(
    tmp_path: Path, mono_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    got = _render_digests(monkeypatch, _project(tmp_path, mono_wav), tmp_path)
    assert got == MAIN_RENDER_DIGESTS


def test_several_stream_render_hashes_carry_the_first_stream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    captured: list[str] = []
    real = play_audit.short_digest

    def capture(raw: str, *args: int) -> str:
        captured.append(raw)
        return real(raw, *args)

    monkeypatch.setattr(play_audit, "short_digest", capture)
    defaults = load_defaults()
    play_audit.track_render_hash(project, "t", defaults=defaults)
    play_audit.proxy_render_hash(project, "t", defaults=defaults)
    assert len(captured) == 2
    assert all('"audio_stream":0' in raw for raw in captured)
    assert _render_digests(monkeypatch, project, tmp_path) != MAIN_RENDER_DIGESTS


def test_balance_digest_adds_a_term_for_several_streams_only(
    tmp_path: Path, mono_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(balance, "file_revision", lambda _path: (1, 2, 3, 4))
    single = balance.balance_basis_digest(_project(tmp_path, mono_wav), "t")
    assert single == MAIN_BALANCE_DIGEST
    several = media.multistream(tmp_path, "two_b.mkv")
    assert balance.balance_basis_digest(_project(tmp_path, several), "t") != single


def _fill(path: Path, **extra: object) -> GateFill:
    stamp = file_stamp(path)
    return GateFill(
        source=GateFillSource.COMFORT_NOISE,
        path="fill.wav",
        media_size=stamp.size,
        media_mtime_ns=stamp.mtime_ns,
        holes=1,
        filled_sec=0.5,
        level_db=-60.0,
        fade_ms=10,
        **extra,
    )


def test_legacy_gate_fill_stays_in_force_on_single_stream_media(
    tmp_path: Path, mono_wav: Path
) -> None:
    project = _project(tmp_path, mono_wav)
    (tmp_path / "fill.wav").write_bytes(b"fill")
    project.tracks[0].gate_fill = _fill(mono_wav)
    assert gate_fill.current_gate_fill_path(project, project.tracks[0]) == tmp_path / "fill.wav"
    payload = gate_fill.gate_fill_payload(project, project.tracks[0])
    stamp = file_stamp(mono_wav)
    assert payload["fill"] == {
        "source": "comfort_noise",
        "path": "fill.wav",
        "media_size": stamp.size,
        "media_mtime_ns": stamp.mtime_ns,
        "holes": 1,
        "filled_sec": 0.5,
        "level_db": -60.0,
        "noise_db": None,
        "fade_ms": 10,
    }


def test_legacy_gate_fill_is_ignored_on_several_streams(tmp_path: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    (tmp_path / "fill.wav").write_bytes(b"fill")
    track = project.tracks[0]
    track.gate_fill = _fill(several)
    assert gate_fill.current_gate_fill_path(project, track) is None
    track.gate_fill = _fill(several, audio_stream=0)
    assert gate_fill.current_gate_fill_path(project, track) == tmp_path / "fill.wav"


@pytest.mark.parametrize(("name", "expected"), [("mono", None), ("two_b.mkv", 0)])
def test_planned_gate_fill_records_the_stream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, expected: int | None
) -> None:
    path = media.multistream(tmp_path, name) if name != "mono" else None
    path = path or media.single_stream_media(tmp_path)["wav"]
    project = _project(tmp_path, path)
    holes = SimpleNamespace(bounds=[(0, 10)], seconds=0.5, sample_rate=8000)
    made = SimpleNamespace(samples=np.zeros(10), level_db=-60.0, noise_db=None, basis="x")
    monkeypatch.setattr(gate_fill, "detect_gate_holes", lambda _path: holes)
    monkeypatch.setattr(
        gate_fill, "FILL_SOURCES", [(GateFillSource.COMFORT_NOISE, lambda *_: made)]
    )
    monkeypatch.setattr(gate_fill, "_write_fill", lambda *_: "fill.wav")
    result = gate_fill.plan_gate_fill(project, project.tracks[0], fade_ms=10)
    assert result.fill is not None
    assert result.fill.audio_stream == expected


def _profile(stem_hash: str) -> speaker_id.SpeakerProfile:
    return speaker_id.SpeakerProfile("t", "t", [0.0], 1.0, stem_hash)


def test_speaker_profile_key_is_unchanged_for_single_stream_media(
    tmp_path: Path, mono_wav: Path
) -> None:
    project = _project(tmp_path, mono_wav)
    legacy = file_revision_key(mono_wav)
    assert speaker_id._profile_stem_valid(project, _profile(legacy))


def test_speaker_profile_key_follows_the_first_stream_for_several(tmp_path: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    legacy = file_revision_key(several)
    assert not speaker_id._profile_stem_valid(project, _profile(legacy))
    assert speaker_id._profile_stem_valid(project, _profile(f"{legacy}:a0"))


def _align_path(project: EpisodeProject, audio: Path | None, tmp_path: Path) -> Path:
    engine = TranscriptionEngine(defaults=load_defaults())
    aligner = SimpleNamespace(cache_identity=lambda: "aligner")
    words = [SimpleNamespace(text="a", start=0.0, end=1.0)]
    extra = {} if audio is None else {"audio": audio}
    return engine.word_align_cache_path(
        project, "t", tmp_path / "asr.json", aligner, words, **extra
    )


def test_word_align_cache_key_is_unchanged_for_single_stream_media(
    tmp_path: Path, mono_wav: Path
) -> None:
    project = _project(tmp_path, mono_wav)
    legacy = _align_path(project, None, tmp_path)
    assert legacy.name == MAIN_ALIGN_NAME
    assert _align_path(project, mono_wav, tmp_path) == legacy


def test_word_align_cache_key_follows_the_first_stream_for_several(tmp_path: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    assert _align_path(project, several, tmp_path) != _align_path(project, None, tmp_path)


@pytest.mark.parametrize("several", [False, True])
def test_raw_audition_cache_key_marks_several_streams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, several: bool
) -> None:
    path = (
        media.multistream(tmp_path, "two_b.mkv")
        if several
        else media.single_stream_media(tmp_path)["wav"]
    )
    workspace = SimpleNamespace(
        project=_project(tmp_path, path), effective_config=lambda: load_defaults()
    )
    stems = _PlayStems(workspace)
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.services.document import play_stems

    monkeypatch.setattr(play_stems, "timeline_range_to_source", lambda *_: (path, 0.1, 0.6))
    monkeypatch.setattr(FFmpegEngine, "extract_segment", lambda *_: None)
    got, *_ = stems._resolve_audio("track:t", 0.0, 0.5, rerender=False)
    plain = stems._cache_path("raw_t", 0.0, 0.5, path)
    marked = stems._cache_path("raw_t", 0.0, 0.5, path, extra="a0")
    assert got == (marked if several else plain)


def test_gate_fill_payload_carries_the_stream_only_when_set(tmp_path: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    (tmp_path / "fill.wav").write_bytes(b"fill")
    track = project.tracks[0]
    track.gate_fill = _fill(several, audio_stream=0)
    payload = gate_fill.gate_fill_payload(project, track)
    assert payload is not None
    assert payload["fill"]["audio_stream"] == 0
    bare = track.gate_fill.model_dump(mode="json", exclude={"audio_stream"})
    assert payload["fill"] != bare


def test_gate_fill_measured_on_another_stream_is_ignored(tmp_path: Path, mono_wav: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    (tmp_path / "fill.wav").write_bytes(b"fill")
    project = _project(tmp_path, several)
    track = project.tracks[0]
    track.gate_fill = _fill(several, audio_stream=1)
    assert gate_fill.current_gate_fill_path(project, track) is None
    single = _project(tmp_path, mono_wav)
    single.tracks[0].gate_fill = _fill(mono_wav, audio_stream=1)
    assert gate_fill.current_gate_fill_path(single, single.tracks[0]) == tmp_path / "fill.wav"


def test_level_record_name_follows_the_first_stream_for_several_only(
    tmp_path: Path, mono_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    revision = (1, 2, 3, 4)
    monkeypatch.setattr(level_profile, "file_revision", lambda _path: revision)
    monkeypatch.setattr(level_profile, "load_mono_full", lambda *_a, **_k: np.zeros(8000))
    level_profile._FILE_PROFILES.clear()
    several = media.multistream(tmp_path, "two_b.mkv")
    records = tmp_path / "records"
    for path in (mono_wav, several):
        resolved = path.resolve()
        main_name = short_digest(
            json.dumps([2, str(resolved), str(revision), str(level_profile.PROFILE_SAMPLE_RATE)])
        )
        marker = records / f"{main_name}.json"
        marker.parent.mkdir(exist_ok=True)
        marker.write_text(json.dumps({"room_db": -60.0, "speech_db": -20.0, "loud_db": -10.0}))
        level_profile._FILE_PROFILES.clear()
        read = level_profile.file_level_profile(path, record_dir=records)
        assert (read.speech_db == -20.0) is (path == mono_wav)
        marker.unlink()


def test_pool_record_name_follows_the_first_stream_for_several_only(tmp_path: Path) -> None:
    project = EpisodeProject.create("Pools", str(tmp_path))
    revision = (1, 2, 3, 4)
    unprobeable = room_tone._pool_record_path(project, ("/ws/mono.wav", revision))
    assert unprobeable.name == MAIN_POOL_RECORD_NAME
    several = media.multistream(tmp_path, "two_b.mkv")
    parts = [2, str(several), str(revision)]
    old = short_digest(json.dumps(parts))
    assert room_tone._pool_record_path(project, (str(several), revision)).stem != old
    mono = media.single_stream_media(tmp_path)["wav"]
    kept = short_digest(json.dumps([2, str(mono), str(revision)]))
    assert room_tone._pool_record_path(project, (str(mono), revision)).stem == kept


def test_pool_written_under_the_old_name_is_not_read_for_several_streams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    monkeypatch.setattr(room_tone, "_POOLS", {})
    key = room_tone._pool_key(several)
    assert key is not None
    path = room_tone._pool_record_path(project, key)
    old = path.with_name(f"{short_digest(json.dumps([2, *map(str, key)]))}.json")
    old.parent.mkdir(parents=True, exist_ok=True)
    old.write_text(json.dumps({"samples": [[0.0, 1.0, -60.0, None]]}))
    assert room_tone.read_room_tone_pool(project, "t") is None
    path.write_text(old.read_text())
    assert room_tone.read_room_tone_pool(project, "t") is not None


def test_pyramid_current_key_marks_several_streams_only(tmp_path: Path, mono_wav: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    for path, marked in ((mono_wav, False), (several, True)):
        entry = SimpleNamespace(rel_path=path.name, abs_path=path)
        plain = waveform_pyramid.media_key(path.name, *file_stamp(path).content)
        assert (waveform_media.current_key(entry) != plain) is marked


def _stored_prosody(project: EpisodeProject, path: Path, **extra: object) -> None:
    stamp = file_stamp(path)
    profile = prosody_profile.ProsodyProfile(
        track_id="t",
        audio_sha256="a" * 64,
        audio_size=stamp.size,
        audio_mtime_ns=stamp.mtime_ns,
        words_fingerprint=prosody_profile.track_words_fingerprint(project, "t"),
        algorithm_version=prosody_profile.ALGORITHM_VERSION,
        engine={"version": parselmouth_version() or "0"},
        **extra,
    )
    target = prosody_profile.profile_path(project, "t", "a" * 16, "b" * 16)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(profile.to_json()))


def test_prosody_profile_without_the_stream_is_kept_for_one_stream_only(
    tmp_path: Path, mono_wav: Path
) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    single = _project(tmp_path, mono_wav)
    _stored_prosody(single, mono_wav)
    assert prosody_profile.load_track_profile(single, "t").status == "fresh"
    many = _project(tmp_path / "m", several)
    _stored_prosody(many, several)
    lookup = prosody_profile.load_track_profile(many, "t")
    assert lookup.status == "stale"
    assert "default audio stream" in (lookup.hint or "")
    _stored_prosody(many, several, audio_stream=0)
    assert prosody_profile.load_track_profile(many, "t").status == "fresh"


def test_prosody_profile_records_the_stream_only_when_set() -> None:
    bare = prosody_profile.ProsodyProfile(track_id="t")
    assert "audio_stream" not in bare.to_json()
    marked = prosody_profile.ProsodyProfile(track_id="t", audio_stream=0)
    assert prosody_profile.ProsodyProfile.from_json(marked.to_json()).audio_stream == 0


def test_load_profile_fallback_skips_a_profile_of_the_default_stream(tmp_path: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    legacy = speaker_id.SpeakerProfile("t", "t", [0.0], 1.0, file_revision_key(several))
    target = speaker_id.profile_cache_path(project, "t", legacy.stem_hash)
    target.write_text(json.dumps(legacy.to_dict()))
    assert speaker_id.load_profile(project, "t") is None
    current = speaker_id.SpeakerProfile("t", "t", [0.0], 1.0, f"{legacy.stem_hash}:a0")
    speaker_id.profile_cache_path(project, "t", current.stem_hash).write_text(
        json.dumps(current.to_dict())
    )
    assert speaker_id.load_profile(project, "t") == current
