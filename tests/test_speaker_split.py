"""Split one recording of several speakers into a lane per speaker (#1095)."""

from __future__ import annotations

import itertools
import json
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.speaker_split import owned_spans, split_track_by_speaker
from podcast_mcp.engines.session_timeline import same_source_timeline_overlaps
from podcast_mcp.engines.speaker_split import (
    FRAME_SEC,
    RATE,
    WINDOW_SEC,
    SpeakerAttribution,
    SpeakerTurn,
    attribute_speakers,
)
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.media import SpeakerService

# Three synthetic voices: harmonic sources at distinct pitches through distinct formants.
VOICES = ((110.0, (600.0, 1100.0)), (210.0, (400.0, 2400.0)), (160.0, (850.0, 1600.0)))


class SpectralBackend:
    """A deterministic speaker embedding for tests: the window's band amplitude shape.

    Amplitudes add, so two voices at once embed between them and both read as present,
    which a learned embedding does not promise (see docs/multitrack-ingest.md).
    """

    EDGES = np.geomspace(80, 4000, 33)

    def name(self) -> str:
        return "spectral-test"

    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        power = np.abs(np.fft.rfft(samples * np.hanning(samples.size))) ** 2
        freqs = np.fft.rfftfreq(samples.size, 1 / sample_rate)
        bands = [
            power[(freqs >= lo) & (freqs < hi)].sum()
            for lo, hi in zip(self.EDGES[:-1], self.EDGES[1:], strict=True)
        ]
        return np.sqrt(np.array(bands)).astype(np.float32)


def _voice(speaker: int, seconds: float, rng: np.random.Generator) -> np.ndarray:
    f0, formants = VOICES[speaker]
    t = np.arange(round(seconds * RATE)) / RATE
    pitch = f0 * (1 + 0.04 * np.sin(2 * np.pi * rng.uniform(3, 6) * t))
    phase = 2 * np.pi * np.cumsum(pitch) / RATE
    out = np.zeros_like(t)
    for k in range(1, int(4000 / f0)):
        gain = sum(np.exp(-(((k * f0 - f) / 180) ** 2)) for f in formants) + 0.05
        out += gain * np.sin(k * phase) / k
    syllables = np.clip(np.sin(2 * np.pi * rng.uniform(3.5, 5) * t), 0, None) ** 0.5
    return out * syllables / np.sqrt(np.mean(out**2)) * 0.08


def _mix(
    speakers: int, seconds: float, *, seed: int, crosstalk: tuple[tuple[float, float], ...] = ()
) -> tuple[np.ndarray, np.ndarray]:
    """Turn-taking speech with pauses, and per-frame truth (speakers x frames)."""
    rng = np.random.default_rng(seed)
    audio = 1e-3 * rng.standard_normal(round(seconds * RATE))
    truth = np.zeros((speakers, round(seconds / FRAME_SEC)), dtype=bool)

    def place(speaker: int, start: float, length: float) -> None:
        first = round(start * RATE)
        voice = _voice(speaker, length, rng)[: audio.size - first]
        audio[first : first + voice.size] += voice
        truth[speaker, round(start / FRAME_SEC) : round((start + length) / FRAME_SEC)] = True

    t, speaker = 0.5, 0
    while t < seconds - 4.0:
        length = float(rng.uniform(2.5, 4.5))
        if not any(lo < t + length and t < hi for lo, hi in crosstalk):
            place(speaker, t, length)
        t += length + float(rng.uniform(0.25, 0.6))
        speaker = (speaker + int(rng.integers(1, speakers))) % speakers
    for i, (lo, hi) in enumerate(crosstalk):
        place(i % speakers, lo, hi - lo)
        place((i + 1) % speakers, lo, hi - lo)
    return audio.astype(np.float32), truth


def _frame_labels(attribution: SpeakerAttribution, frames: int) -> tuple[np.ndarray, np.ndarray]:
    labels = np.full(frames, -1)
    crosstalk = np.zeros(frames, dtype=bool)
    for turn in attribution.turns:
        lo, hi = round(turn.start / FRAME_SEC), round(turn.end / FRAME_SEC)
        labels[lo:hi] = turn.speakers[0]
        crosstalk[lo:hi] = turn.crosstalk
    return labels, crosstalk


def _by_first_appearance(truth: np.ndarray) -> np.ndarray:
    """``truth`` with speakers renumbered by when each first talks, as clustering numbers them."""
    return truth[np.argsort([int(np.flatnonzero(row)[0]) for row in truth])]


def _single_speaker_accuracy(truth: np.ndarray, labels: np.ndarray) -> float:
    single = truth.sum(axis=0) == 1
    return float(np.mean(labels[single] == np.argmax(truth, axis=0)[single]))


@pytest.mark.parametrize("speakers", [2, 3])
def test_turn_taking_mix_is_attributed_frame_by_frame(speakers: int) -> None:
    audio, truth = _mix(speakers, 90.0, seed=speakers)
    attribution = attribute_speakers(audio, speaker_count=speakers, backend=SpectralBackend())
    labels, _ = _frame_labels(attribution, truth.shape[1])
    assert attribution.method == "cluster"
    assert _single_speaker_accuracy(_by_first_appearance(truth), labels) >= 0.95


def test_clustered_speakers_are_numbered_by_who_talks_first() -> None:
    audio, _ = _mix(3, 60.0, seed=11)
    attribution = attribute_speakers(audio, speaker_count=3, backend=SpectralBackend())
    order = list(dict.fromkeys(t.speakers[0] for t in attribution.turns))
    assert order == [0, 1, 2]


def test_enrollment_names_each_speaker() -> None:
    audio, truth = _mix(3, 90.0, seed=5)
    enrollment = {}
    for speaker in (2, 0, 1):
        frames = np.flatnonzero(truth[speaker] & (truth.sum(axis=0) == 1))
        enrollment[speaker] = [(frames[0] * FRAME_SEC, frames[0] * FRAME_SEC + 2.0)]
    attribution = attribute_speakers(
        audio, speaker_count=3, backend=SpectralBackend(), enrollment=enrollment
    )
    labels, _ = _frame_labels(attribution, truth.shape[1])
    assert attribution.method == "enroll"
    assert _single_speaker_accuracy(truth, labels) >= 0.95


def test_turns_cover_the_recording_without_gaps() -> None:
    audio, _ = _mix(2, 40.0, seed=3)
    attribution = attribute_speakers(audio, speaker_count=2, backend=SpectralBackend())
    turns = attribution.turns
    assert turns[0].start == 0.0
    assert turns[-1].end == pytest.approx(audio.size / RATE)
    assert all(a.end == b.start for a, b in itertools.pairwise(turns))


def test_sustained_crosstalk_is_flagged_with_both_speakers() -> None:
    audio, _ = _mix(2, 60.0, seed=8, crosstalk=((20.0, 24.0),))
    attribution = attribute_speakers(audio, speaker_count=2, backend=SpectralBackend())
    flagged = [t for t in attribution.turns if t.crosstalk]
    assert flagged
    assert all(set(t.speakers) == {0, 1} for t in flagged)
    covered = sum(
        min(t.end, 24.0) - max(t.start, 20.0) for t in flagged if t.end > 20 and t.start < 24
    )
    spill = sum(t.end - t.start for t in flagged) - covered
    assert covered == pytest.approx(4.0)
    # A window straddling the overlap's edge hears both voices too; plus the pause beside it.
    assert spill <= 2 * WINDOW_SEC + 0.6


def test_a_split_needs_two_or_more_speakers() -> None:
    audio, _ = _mix(2, 20.0, seed=1)
    with pytest.raises(ValueError, match="at least two"):
        attribute_speakers(audio, speaker_count=1, backend=SpectralBackend())


# --- lanes -------------------------------------------------------------------------


def _write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.round(np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(pcm.tobytes())


def _room_workspace(
    tmp_path: Path, audio: np.ndarray, words: list[TranscriptWord]
) -> ProjectWorkspace:
    ws = ProjectWorkspace.create(tmp_path / "ep")
    project = ws.project
    _write_wav(project.workspace_path() / "raw" / "room.wav", audio)
    duration = audio.size / RATE
    project.tracks.append(
        Track(
            id="room",
            label="Room",
            role=TrackRole.DIALOGUE,
            speaker="Room",
            media=MediaAsset(path="raw/room.wav", duration_sec=duration),
        )
    )
    project.clips.append(
        Clip(
            id="clip_room",
            track_id="room",
            source_start=0.0,
            source_end=duration,
            timeline_start=0.0,
        )
    )
    project.transcripts.append(Transcript(track_id="room", words=words))
    ws.save()
    return ws


# 0-4 s Ana, 4-6 s both, 6-10 s Ben.
SCRIPTED = SpeakerAttribution(
    speaker_count=2,
    duration=10.0,
    turns=(
        SpeakerTurn(0.0, 4.0, (0,), 0.9),
        SpeakerTurn(4.0, 6.0, (0, 1), 0.1),
        SpeakerTurn(6.0, 10.0, (1,), 0.9),
    ),
    backend="spectral-test",
    method="cluster",
)


@pytest.fixture
def scripted_ws(tmp_path: Path) -> ProjectWorkspace:
    rng = np.random.default_rng(0)
    audio = 0.1 * rng.standard_normal(10 * RATE).astype(np.float32)
    words = [
        TranscriptWord(text="hello", start=1.0, end=1.4),
        TranscriptWord(text="there", start=6.5, end=6.9),
    ]
    return _room_workspace(tmp_path, audio, words)


def test_crosstalk_plays_on_both_speakers_lanes_by_default_and_is_flagged(
    scripted_ws: ProjectWorkspace,
) -> None:
    project = scripted_ws.project
    summary = split_track_by_speaker(project, "room", SCRIPTED, names=["Ana", "Ben"])
    split = project.editorial.speaker_splits[0]
    assert split.lanes == ["room", "room_ben"]
    assert split.crosstalk_lane is None
    assert split.crosstalk_spans() == [(4.0, 6.0)]
    assert summary["crosstalk_sec"] == 2.0
    assert owned_spans(split) == {"room": [(0.0, 6.0)], "room_ben": [(4.0, 10.0)]}
    ana = next(c for c in project.clips if c.track_id == "room")
    ben = next(c for c in project.clips if c.track_id == "room_ben")
    assert [(r.start_s, r.end_s) for r in ana.mute_regions] == [(5.99, 10.0)]
    assert [(r.start_s, r.end_s) for r in ben.mute_regions] == [(0.0, 4.01)]
    assert same_source_timeline_overlaps(project) == []


def test_undeclared_audio_on_two_lanes_is_still_a_stacked_copy(
    scripted_ws: ProjectWorkspace,
) -> None:
    project = scripted_ws.project
    split_track_by_speaker(project, "room", SCRIPTED, names=["Ana", "Ben"])
    project.editorial.speaker_splits.clear()
    [stack] = same_source_timeline_overlaps(project)
    assert stack.track_ids == ("room", "room_ben")
    assert stack.overlap_sec == pytest.approx(1.98)  # the 2 s less each half fade


def test_crosstalk_lane_takes_the_overlap_from_both_speakers(scripted_ws: ProjectWorkspace) -> None:
    project = scripted_ws.project
    split_track_by_speaker(project, "room", SCRIPTED, names=["Ana", "Ben"], crosstalk_mode="lane")
    split = project.editorial.speaker_splits[0]
    assert split.crosstalk_lane == "room_crosstalk"
    assert owned_spans(split) == {
        "room": [(0.0, 4.0)],
        "room_ben": [(6.0, 10.0)],
        "room_crosstalk": [(4.0, 6.0)],
    }
    assert [t.label for t in project.tracks] == ["Ana", "Ben", "Crosstalk"]


def test_lanes_play_the_same_media_without_copying_it(scripted_ws: ProjectWorkspace) -> None:
    project = scripted_ws.project
    raw_before = sorted(p.name for p in (project.workspace_path() / "raw").iterdir())
    split_track_by_speaker(project, "room", SCRIPTED, names=["Ana", "Ben"], crosstalk_mode="lane")
    assert {t.media.path for t in project.tracks if t.media} == {"raw/room.wav"}
    assert {
        (c.source_start, c.source_end, c.timeline_start, c.source_id) for c in project.clips
    } == {(0.0, 10.0, 0.0, None)}
    assert sorted(p.name for p in (project.workspace_path() / "raw").iterdir()) == raw_before


def test_words_follow_their_speaker(scripted_ws: ProjectWorkspace) -> None:
    project = scripted_ws.project
    split_track_by_speaker(project, "room", SCRIPTED, names=["Ana", "Ben"])
    words = {tr.track_id: [w.text for w in tr.words] for tr in project.transcripts}
    assert words == {"room": ["hello"], "room_ben": ["there"]}


def test_lanes_sum_back_to_the_recording(scripted_ws: ProjectWorkspace, tmp_path: Path) -> None:
    project = scripted_ws.project
    split_track_by_speaker(project, "room", SCRIPTED, names=["Ana", "Ben"], crosstalk_mode="lane")
    original = load_mono_full(project.workspace_path() / "raw" / "room.wav", sample_rate=RATE)
    total = np.zeros_like(original)
    for track in project.tracks:
        out = render_track_from_timeline(project, track, tmp_path / f"{track.id}.wav", {})
        lane = load_mono_full(out, sample_rate=RATE)[: original.size]
        total[: lane.size] += lane
    residual = 10 * np.log10(np.mean((total - original) ** 2) / np.mean(original**2))
    assert residual < -40.0


def test_split_record_matches_the_project_schema_and_reloads(
    scripted_ws: ProjectWorkspace,
) -> None:
    import jsonschema

    project = scripted_ws.project
    split_track_by_speaker(project, "room", SCRIPTED, names=["Ana", "Ben"])
    scripted_ws.save()
    schema = json.loads(
        (
            Path(__file__).resolve().parents[1] / "schemas" / "episode.project.schema.json"
        ).read_text()
    )
    editorial = json.loads(project.model_dump_json())["editorial"]
    jsonschema.validate(
        editorial, {**schema["$defs"]["EditorialSection"], "$defs": schema["$defs"]}
    )
    reloaded = ProjectWorkspace.open(scripted_ws.path).project
    assert reloaded.editorial.speaker_splits == project.editorial.speaker_splits


def test_split_needs_one_name_per_speaker(scripted_ws: ProjectWorkspace) -> None:
    with pytest.raises(ValueError, match="expected 2 speaker names"):
        split_track_by_speaker(scripted_ws.project, "room", SCRIPTED, names=["Ana"])


def test_a_lane_cannot_be_split_twice(scripted_ws: ProjectWorkspace) -> None:
    project = scripted_ws.project
    split_track_by_speaker(project, "room", SCRIPTED, names=["Ana", "Ben"])
    with pytest.raises(ValueError, match="already split"):
        split_track_by_speaker(project, "room_ben", SCRIPTED, names=["Ana", "Ben"])


# --- service, history and adapters -------------------------------------------------


@pytest.fixture
def mixed_ws(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectWorkspace:
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        lambda name=None: SpectralBackend(),
    )
    audio, _ = _mix(2, 40.0, seed=4)
    return _room_workspace(tmp_path, audio, [])


def test_split_is_one_undoable_step(mixed_ws: ProjectWorkspace) -> None:
    before = mixed_ws.project.model_dump(include={"timeline", "transcript_data", "editorial"})
    entries = len(mixed_ws.project.history.entries)
    result = SpeakerService(mixed_ws).split_speakers(
        "room", speaker_count=2, names=["Ana", "Ben"], dry_run=False
    )
    assert [lane["track_id"] for lane in result["lanes"]] == ["room", "room_ben"]
    assert len(mixed_ws.project.history.entries) == entries + 2
    HistoryService(mixed_ws).undo()
    after = mixed_ws.project.model_dump(include={"timeline", "transcript_data", "editorial"})
    assert after == before


def test_dry_run_reports_turns_without_changing_the_project(mixed_ws: ProjectWorkspace) -> None:
    before = mixed_ws.project.model_dump_json()
    result = SpeakerService(mixed_ws).split_speakers("room", speaker_count=2, dry_run=True)
    assert result["dry_run"] is True
    assert result["speakers"] == ["Speaker 1", "Speaker 2"]
    assert sum(result["seconds_by_speaker"].values()) == pytest.approx(40.0, abs=0.05)
    assert mixed_ws.project.model_dump_json() == before


def test_split_requires_a_speaker_count_the_user_gave(mixed_ws: ProjectWorkspace) -> None:
    with pytest.raises(ValueError, match="speaker count"):
        SpeakerService(mixed_ws).split_speakers("room", dry_run=True)
    SpeakerService(mixed_ws).set_expected_speaker_count(2)
    result = SpeakerService(mixed_ws).split_speakers("room", dry_run=True)
    assert result["speakers"] == ["Speaker 1", "Speaker 2"]


def test_enrollment_names_come_from_the_spans(mixed_ws: ProjectWorkspace) -> None:
    result = SpeakerService(mixed_ws).split_speakers(
        "room",
        speaker_count=2,
        enrollment={"Ben": [(0.6, 2.4)], "Ana": [(10.0, 11.0)]},
        dry_run=True,
    )
    assert result["speakers"] == ["Ben", "Ana"]
    assert result["method"] == "enroll"


def test_split_refuses_the_ci_mock_backend(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.engines.speaker_id import MockSpeakerBackend

    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        lambda name=None: MockSpeakerBackend(),
    )
    audio, _ = _mix(2, 20.0, seed=2)
    ws = _room_workspace(tmp_path, audio, [])
    with pytest.raises(ImportError, match=r"\[speaker\]"):
        SpeakerService(ws).split_speakers("room", speaker_count=2, dry_run=True)


def test_mcp_tool_splits_with_crosstalk_lane(mixed_ws: ProjectWorkspace) -> None:
    from podcast_mcp.mcp.tools.speaker import speaker_split_tool

    payload = json.loads(
        speaker_split_tool(
            str(mixed_ws.path),
            track_id="room",
            speaker_count=2,
            names=["Ana", "Ben"],
            crosstalk_mode="lane",
            dry_run=False,
        )
    )
    assert payload["crosstalk_lane"] == "room_crosstalk"
    reopened = ProjectWorkspace.open(mixed_ws.path)
    assert [t.id for t in reopened.project.tracks] == ["room", "room_ben", "room_crosstalk"]


def test_cli_dry_run_prints_the_turn_summary(mixed_ws: ProjectWorkspace) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    result = CliRunner().invoke(
        app,
        [
            "speaker",
            "split",
            "--project",
            str(mixed_ws.path),
            "--track",
            "room",
            "--speakers",
            "2",
            "--enroll",
            "Ana=0.6:2.4",
            "--enroll",
            "Ben=10:11",
        ],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["dry_run"] is True
    assert payload["speakers"] == ["Ana", "Ben"]
