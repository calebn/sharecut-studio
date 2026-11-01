"""A bed cut from a track's own audio is written once and says where it came from (#1216)."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from podcast_mcp.edits.record_placement import place_room_tone
from podcast_mcp.engines import room_tone as room_tone_module
from podcast_mcp.engines import room_tone_extract
from podcast_mcp.engines.room_tone import RecordedBedSample, SampleAbsent, room_tone_bed
from podcast_mcp.engines.room_tone_extract import (
    EXTRACT_DIR,
    EXTRACTOR_REV,
    ExtractedBed,
    plan_extracted_bed,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    RoomToneOrigin,
    Track,
    TrackRole,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.room_tone_bed import RoomToneBedService
from podcast_mcp.services.record.landing import _room_tone_missing
from podcast_mcp.services.record.landing_rollback import (
    capture_prior,
    prior_from_json,
    prior_to_json,
    revert_registration,
)

SR = 16000
DURATION_SEC = 10.0
FLOOR_DB = -70.0
VOICE_DB = -20.0


def _write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.round(np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(pcm.tobytes())


def _noise(level_db: float, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).normal(0.0, 10 ** (level_db / 20), round(DURATION_SEC * SR))


def _add_voice(samples: np.ndarray, start: float, end: float) -> None:
    i0, i1 = round(start * SR), round(end * SR)
    t = np.arange(i1 - i0) / SR
    voice = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 9))
    voice *= 10 ** (VOICE_DB / 20) / np.sqrt(np.mean(voice**2))
    ramp = round(0.01 * SR)
    envelope = np.ones(voice.size)
    envelope[:ramp] = np.linspace(0.0, 1.0, ramp)
    envelope[-ramp:] = np.linspace(1.0, 0.0, ramp)
    samples[i0:i1] += voice * envelope


def _host_audio(speech: tuple[tuple[float, float], ...]) -> np.ndarray:
    host = _noise(FLOOR_DB, seed=1216)
    for start, end in speech:
        _add_voice(host, start, end)
    return host


# Why a track with speech all through, or only scraps of room, has no bed to cut.
NO_CLEAN_STRETCH = {"no_quiet_run", "too_short", "rejected"}

# Speech up to 5 s, then a clean 5 s of room.
SPEECH_THEN_ROOM = ((1.0, 1.5), (2.6, 3.9), (4.0, 5.0))


def _project(tmp_path: Path, host: np.ndarray) -> EpisodeProject:
    project = EpisodeProject.create("extract", str(tmp_path))
    _write_wav(tmp_path / "raw" / "host.wav", host)
    project.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=DURATION_SEC),
        )
    )
    project.clips.append(
        Clip(
            id="full",
            track_id="host",
            source_start=0.0,
            source_end=DURATION_SEC,
            timeline_start=0.0,
        )
    )
    return project


def _service(tmp_path: Path, host: np.ndarray) -> tuple[RoomToneBedService, ProjectWorkspace]:
    project = _project(tmp_path, host)
    ws = ProjectWorkspace(tmp_path / "episode.sharecut", project)
    ws.save()
    return RoomToneBedService(ws), ws


def _plan(tmp_path: Path, host: np.ndarray) -> ExtractedBed:
    plan = plan_extracted_bed(_project(tmp_path, host), "host")
    assert isinstance(plan, ExtractedBed), plan
    return plan


def test_the_bed_is_cut_from_the_clean_stretch_and_describes_its_source(tmp_path: Path) -> None:
    plan = _plan(tmp_path, _host_audio(SPEECH_THEN_ROOM))

    assert plan.rel.startswith(f"{EXTRACT_DIR}/host-")
    assert plan.path.is_file()
    assert plan.duration_sec >= room_tone_module.BED_MIN_USABLE_SEC
    # Speech, transcribed or not, ends at 5 s: the bed is all room.
    assert plan.origin.source_start >= 5.0
    assert plan.origin.source_end <= DURATION_SEC
    assert plan.origin.extractor_rev == EXTRACTOR_REV
    assert plan.origin.source_id is None
    assert plan.origin.media_size == (tmp_path / "raw" / "host.wav").stat().st_size
    assert plan.origin.checks == [name for name, _ in room_tone_module.CHECKS]


def test_the_same_audio_gives_the_same_file_and_it_is_not_written_twice(tmp_path: Path) -> None:
    host = _host_audio(SPEECH_THEN_ROOM)
    project = _project(tmp_path, host)
    first = plan_extracted_bed(project, "host")
    assert isinstance(first, ExtractedBed)
    stamp = first.path.stat().st_mtime_ns

    second = plan_extracted_bed(project, "host")

    assert isinstance(second, ExtractedBed)
    assert second.rel == first.rel
    assert second.origin == first.origin
    assert second.path.stat().st_mtime_ns == stamp


def test_speech_everywhere_leaves_the_track_without_a_bed(tmp_path: Path) -> None:
    host = _host_audio(((0.2, 9.8),))

    absent = plan_extracted_bed(_project(tmp_path, host), "host")

    assert isinstance(absent, SampleAbsent)
    assert absent.cause in NO_CLEAN_STRETCH


def test_a_clean_stretch_too_short_to_tile_is_not_a_bed(tmp_path: Path) -> None:
    speech = tuple((float(s), float(s) + 1.7) for s in range(0, 10, 2))
    absent = plan_extracted_bed(_project(tmp_path, _host_audio(speech)), "host")

    assert isinstance(absent, SampleAbsent)
    assert absent.cause in NO_CLEAN_STRETCH


def test_digital_silence_is_not_a_bed(tmp_path: Path) -> None:
    host = np.zeros(round(DURATION_SEC * SR))

    assert plan_extracted_bed(_project(tmp_path, host), "host") == SampleAbsent("digital_silence")


def test_no_bed_is_cut_without_a_voice_detector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(room_tone_extract, "_voice_detector_missing", lambda: True)
    project = _project(tmp_path, _host_audio(SPEECH_THEN_ROOM))

    assert plan_extracted_bed(project, "host") == SampleAbsent("voice_detector_missing")
    assert not (tmp_path / EXTRACT_DIR).exists()


def test_a_track_without_media_has_no_bed(tmp_path: Path) -> None:
    project = _project(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    project.tracks[0].media = None

    assert plan_extracted_bed(project, "host") == SampleAbsent("missing_media")
    assert plan_extracted_bed(project, "nobody") == SampleAbsent("missing_track")


def test_the_service_registers_the_bed_and_it_renders(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(SPEECH_THEN_ROOM))

    result = service.extract_room_tone_bed(track_id="host")

    assert result["extracted"] is True
    track = ws.project.track_by_id("host")
    assert track is not None
    assert track.room_tone is not None
    assert track.room_tone.path == result["path"]
    assert track.room_tone_origin is not None
    assert track.room_tone_origin.source_start == result["source_start"]
    source = ws.project.source_by_id("room-tone-host")
    assert source is not None
    assert source.path == result["path"]
    assert isinstance(room_tone_bed(ws.project, "host"), RecordedBedSample)


def test_a_rerun_on_unchanged_audio_changes_nothing(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    service.extract_room_tone_bed(track_id="host")
    before = ws.project.model_dump_json()

    again = service.extract_room_tone_bed(track_id="host")

    assert again == {"track_id": "host", "extracted": False, "reason": "already_extracted"}
    assert ws.project.model_dump_json() == before


def test_the_origin_survives_save_and_reload(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    service.extract_room_tone_bed(track_id="host")
    ws.save()

    reloaded = ProjectWorkspace.open(tmp_path / "episode.sharecut")

    track = reloaded.project.track_by_id("host")
    assert track is not None
    assert track.room_tone_origin == ws.project.track_by_id("host").room_tone_origin  # type: ignore[union-attr]
    assert isinstance(room_tone_bed(reloaded.project, "host"), RecordedBedSample)


def test_a_recorded_bed_is_never_replaced(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    _write_wav(tmp_path / "raw" / "room-tone" / "host.wav", _noise(-62.0, seed=7)[: 2 * SR])
    place_room_tone(
        ws.project,
        track_id="host",
        label="Host",
        rel="raw/room-tone/host.wav",
        duration_s=2.0,
        sample_rate=SR,
        channels=1,
    )
    before = ws.project.model_dump_json()

    result = service.extract_room_tone_bed(track_id="host")

    assert result == {"track_id": "host", "extracted": False, "reason": "has_bed"}
    assert ws.project.model_dump_json() == before


def test_changed_audio_replaces_only_an_extracted_bed(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    first = service.extract_room_tone_bed(track_id="host")
    # The recording is replaced with one whose clean room starts earlier.
    _write_wav(tmp_path / "raw" / "host.wav", _host_audio(((1.0, 1.5),)))

    second = service.extract_room_tone_bed(track_id="host")

    assert second["extracted"] is True
    assert second["path"] != first["path"]
    track = ws.project.track_by_id("host")
    assert track is not None
    assert track.room_tone is not None
    assert track.room_tone.path == second["path"]
    # The first bed's file stays: history may still refer to it.
    assert (tmp_path / first["path"]).is_file()


def test_no_clean_audio_leaves_the_track_untouched_and_says_why(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(((0.2, 9.8),)))
    before = ws.project.model_dump_json()

    result = service.extract_room_tone_bed(track_id="host")

    assert result["extracted"] is False
    assert result["reason"] in NO_CLEAN_STRETCH
    assert ws.project.model_dump_json() == before


def _origin() -> RoomToneOrigin:
    return RoomToneOrigin(
        source_start=5.0,
        source_end=9.0,
        media_size=10,
        media_mtime_ns=1,
        extractor_rev=EXTRACTOR_REV,
        file_sha256="0" * 64,
        floor_db=-70.0,
        bed_rms_db=-70.0,
    )


def test_an_origin_needs_the_bed_it_describes() -> None:
    with pytest.raises(ValidationError):
        Track(id="host", label="Host", room_tone_origin=_origin())
    Track(
        id="host",
        label="Host",
        room_tone=MediaAsset(path="raw/room-tone-extracted/h.wav", duration_sec=4.0),
        room_tone_origin=_origin(),
    )


def test_an_origin_must_end_after_it_starts() -> None:
    data = _origin().model_dump()
    data["source_end"] = data["source_start"]
    with pytest.raises(ValidationError):
        RoomToneOrigin.model_validate(data)


def test_a_recorded_bed_clears_the_extracted_origin(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    service.extract_room_tone_bed(track_id="host")
    place_room_tone(
        ws.project,
        track_id="host",
        label="Host",
        rel="raw/room-tone/s1/host.wav",
        duration_s=2.0,
        sample_rate=SR,
        channels=1,
    )

    track = ws.project.track_by_id("host")
    assert track is not None
    assert track.room_tone is not None
    assert track.room_tone.path == "raw/room-tone/s1/host.wav"
    assert track.room_tone_origin is None


def test_a_recorded_bed_still_lands_over_an_extracted_one(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    assert _room_tone_missing(ws.project, "s1", "host")
    service.extract_room_tone_bed(track_id="host")

    assert _room_tone_missing(ws.project, "s1", "host")
    place_room_tone(
        ws.project,
        track_id="host",
        label="Host",
        rel="raw/room-tone/s1/host.wav",
        duration_s=2.0,
        sample_rate=SR,
        channels=1,
    )
    assert not _room_tone_missing(ws.project, "s1", "host")


def test_rolling_a_landing_back_restores_the_extracted_origin(tmp_path: Path) -> None:
    service, ws = _service(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    service.extract_room_tone_bed(track_id="host")
    project = ws.project
    extracted = project.track_by_id("host").room_tone_origin  # type: ignore[union-attr]
    rel = "raw/room-tone/s1/host.wav"
    prior = capture_prior(
        project, track_id="host", source_id="room-tone-host", rel=rel, room_tone=True
    )
    place_room_tone(
        project, track_id="host", label="Host", rel=rel, duration_s=2.0, sample_rate=SR, channels=1
    )
    assert project.track_by_id("host").room_tone_origin is None  # type: ignore[union-attr]

    assert revert_registration(project, prior_from_json(prior_to_json(prior)))

    track = project.track_by_id("host")
    assert track is not None
    assert track.room_tone_origin == extracted
    assert track.room_tone is not None
    assert track.room_tone.path != rel
