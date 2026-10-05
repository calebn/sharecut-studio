from __future__ import annotations

import functools
import hashlib
import json
import shutil
import tempfile
import wave
from pathlib import Path

import jsonschema
import numpy as np
import pytest

import podcast_mcp.edits.transcript_refine_status as refine_mod
from fixtures.lab_clips import decode_pcm16_wav
from fixtures.lab_tighten.manifest import CASES, OWNER_VERDICTS
from podcast_mcp.models import EditDecision, load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline.service import PipelineService

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "lab_tighten"
SCHEMA = Path(__file__).resolve().parents[1] / "schemas" / "episode.project.schema.json"
CASE_BY_NAME = {case["name"]: case for case in CASES}
LISTENABLE_LABELS = [
    (case["name"], label)
    for case in CASES
    for label in case["labels"]
    if label["kind"] in ("filler", "backchannel")
]
CUT_FILLERS = [
    key for key, value in OWNER_VERDICTS.items() if key[2] == "filler" and value["verdict"] == "cut"
]
CUT_PAUSES = [
    key for key, value in OWNER_VERDICTS.items() if key[2] == "pause" and value["verdict"] == "cut"
]
KEPT_BACKCHANNELS = [
    key
    for key, value in OWNER_VERDICTS.items()
    if key[2] == "backchannel" and value["verdict"] == "keep"
]


def label_interval(key: tuple[str, str, str, float]) -> tuple[float, float]:
    name, track, kind, start = key
    return next(
        label["source_interval"]
        for label in CASE_BY_NAME[name]["labels"]
        if (label["track"], label["kind"], label["source_interval"][0]) == (track, kind, start)
    )


def hits_overlapping(
    hits: dict[str, list[EditDecision]], key: tuple[str, str, str, float]
) -> list[EditDecision]:
    name, track, _, _ = key
    window_start = CASE_BY_NAME[name]["source_interval"][0]
    start, end = label_interval(key)
    return [
        hit
        for hit in hits[name]
        if hit.track_id == track
        and hit.start + window_start < end
        and hit.end + window_start > start
    ]


@functools.cache
def track_audio(relative_file: str) -> tuple[np.ndarray, int]:
    with tempfile.TemporaryDirectory() as temporary:
        output = Path(temporary) / "decoded.wav"
        decode_pcm16_wav(FIXTURE_DIR / relative_file, output)
        with wave.open(str(output), "rb") as audio:
            frames = audio.readframes(audio.getnframes())
            shape = (audio.getnframes(), audio.getnchannels())
            return np.frombuffer(frames, dtype="<i2").reshape(shape), audio.getframerate()


def track_level(case: dict, track: str, start_s: float, end_s: float) -> str:
    samples, rate = track_audio(case["audio"][track]["file"])
    first, last = (round((t - case["source_interval"][0]) * rate) for t in (start_s, end_s))
    span = samples[first:last].astype(np.float64)
    if span.size == 0:
        return "empty interval"
    rms_dbfs = 20 * np.log10(max(np.sqrt(np.mean(span**2)), 1e-9) / 32768)
    return "digital silence" if rms_dbfs < -90 else "audio"


@pytest.fixture(scope="module")
def proposed_hits(tmp_path_factory: pytest.TempPathFactory) -> dict[str, list[EditDecision]]:
    hits = {}
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(refine_mod, "refine_mode_from_defaults", lambda defaults=None: "off")
        for case in CASES:
            workspace = tmp_path_factory.mktemp(case["name"]) / case["name"]
            shutil.copytree(FIXTURE_DIR / case["name"], workspace)
            PipelineService(ProjectWorkspace.open(workspace / "episode.project.json")).run(
                only_step="analyze_fillers_pauses",
                config={"tighten": {"enabled": True, "intensity": "medium"}},
            )
            hits[case["name"]] = [
                decision
                for decision in load_project(workspace / "episode.project.json").edit_decisions
                if not decision.applied
            ]
    return hits


@pytest.mark.parametrize(
    ("case", "track"),
    [(case, track) for case in CASES for track in case["audio"]],
    ids=[f"{case['name']}-{track}" for case in CASES for track in case["audio"]],
)
def test_committed_clip_matches_manifest_seals(case: dict, track: str) -> None:
    audio = case["audio"][track]
    assert (
        hashlib.sha256((FIXTURE_DIR / audio["file"]).read_bytes()).hexdigest()
        == (audio["file_sha256"])
    )
    samples, rate = track_audio(audio["file"])
    assert (rate, samples.shape) == (48000, (1_200_000, 2))
    assert hashlib.sha256(samples.tobytes()).hexdigest() == audio["pcm_sha256"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_project_is_schema_valid_with_window_transcripts(case: dict) -> None:
    path = FIXTURE_DIR / case["name"] / "episode.project.json"
    jsonschema.validate(
        instance=json.loads(path.read_text(encoding="utf-8")),
        schema=json.loads(SCHEMA.read_text(encoding="utf-8")),
    )
    project = load_project(path)
    assert [(t.id, t.media.path if t.media else None) for t in project.tracks] == [
        ("caleb", "raw/caleb.flac"),
        ("audra", "raw/audra.flac"),
        ("lana", "raw/lana.flac"),
    ]
    assert project.timeline.duration_sec == 25.0
    window_start = case["source_interval"][0]
    words = {
        (transcript.track_id, word.text, round(word.start + window_start, 3))
        for transcript in project.transcripts
        for word in transcript.words
    }
    for label in case["labels"]:
        if label["kind"] in ("filler", "backchannel"):
            first_token = label["text"].split(" ")[0]
            assert (label["track"], first_token, label["source_interval"][0]) in words


def test_every_owner_verdict_names_a_manifest_label() -> None:
    labels = {
        (case["name"], label["track"], label["kind"], label["source_interval"][0])
        for case in CASES
        for label in case["labels"]
    }
    assert set(OWNER_VERDICTS) <= labels


def test_filler_and_backchannel_label_listen_proxy() -> None:
    levels = {
        (label["track"], label["kind"], label["source_interval"][0]): track_level(
            CASE_BY_NAME[case_name], label["track"], *label["source_interval"]
        )
        for case_name, label in LISTENABLE_LABELS
    }
    assert levels == {
        ("lana", "backchannel", 1109.04): "audio",
        ("lana", "backchannel", 1114.6): "digital silence",
        ("lana", "backchannel", 1121.26): "audio",
        ("lana", "backchannel", 1124.56): "digital silence",
        ("lana", "backchannel", 1125.96): "digital silence",
        ("caleb", "filler", 615.98): "audio",
    }


def test_no_cut_overlaps_kept_backchannel(proposed_hits: dict[str, list[EditDecision]]) -> None:
    assert proposed_hits["caleb_um_pause"], "propose produced no hits for the control case"
    assert KEPT_BACKCHANNELS
    assert {key: hits_overlapping(proposed_hits, key) for key in KEPT_BACKCHANNELS} == {
        key: [] for key in KEPT_BACKCHANNELS
    }


@pytest.mark.parametrize("key", CUT_FILLERS, ids=lambda key: f"{key[1]}-{key[3]}")
def test_cut_filler_verdict_gets_filler_hit(
    proposed_hits: dict[str, list[EditDecision]], key: tuple[str, str, str, float]
) -> None:
    assert [(hit.reason or "").split(":")[0] for hit in hits_overlapping(proposed_hits, key)] == [
        "filler"
    ]


@pytest.mark.parametrize("key", CUT_PAUSES, ids=lambda key: f"{key[1]}-{key[3]}")
def test_cut_pause_verdict_gets_pause_hit(
    proposed_hits: dict[str, list[EditDecision]], key: tuple[str, str, str, float]
) -> None:
    assert [(hit.reason or "").split(":")[0] for hit in hits_overlapping(proposed_hits, key)] == [
        "pause"
    ]
