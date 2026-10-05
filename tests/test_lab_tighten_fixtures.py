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
from fixtures.lab_tighten.manifest import CASES
from podcast_mcp.models import EditDecision, load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline.service import PipelineService

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "lab_tighten"
SCHEMA = Path(__file__).resolve().parents[1] / "schemas" / "episode.project.schema.json"
CASE_BY_NAME = {case["name"]: case for case in CASES}
FILLER_LABELS = [
    (case["name"], label) for case in CASES for label in case["labels"] if label["kind"] == "filler"
]
ISOLATED = "isolated filler: medium tighten needs min_filler_cluster=2 fillers within 2 s"
PROPOSE_MISSES = {
    ("lana", 1109.04): ISOLATED,
    ("lana", 1114.6): ISOLATED,
    ("lana", 1125.96): "zero-length ASR word: the filler lexicon skips words with end <= start",
    ("caleb", 615.98): (
        "punctuated ASR token 'Um.': the filler lexicon compares normalize_text, "
        "which keeps punctuation, so 'um.' never equals 'um'; as bare 'Um' it is "
        "still isolated at medium, and aggressive drops it in protect_cut_breaths"
    ),
}


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
        if label["kind"] == "filler":
            assert (label["track"], label["text"], label["source_interval"][0]) in words


def test_filler_label_listen_proxy() -> None:
    levels = {
        (label["track"], label["source_interval"][0]): track_level(
            CASE_BY_NAME[case_name], label["track"], *label["source_interval"]
        )
        for case_name, label in FILLER_LABELS
    }
    assert levels == {
        ("lana", 1109.04): "audio",
        ("lana", 1114.6): "digital silence",
        ("lana", 1121.26): "audio",
        ("lana", 1124.56): "digital silence",
        ("lana", 1125.96): "empty interval",
        ("caleb", 615.98): "audio",
    }


def test_find_hits_counts_and_tracks(proposed_hits: dict[str, list[EditDecision]]) -> None:
    assert {
        name: sorted((hit.track_id, (hit.reason or "").split(":")[0]) for hit in hits)
        for name, hits in proposed_hits.items()
    } == {
        "lana_uh_cluster": [("lana", "filler"), ("lana", "filler")],
        "caleb_um_pause": [("caleb", "pause")],
    }


@pytest.mark.parametrize(
    ("case_name", "label"),
    [
        pytest.param(
            case_name,
            label,
            marks=[pytest.mark.xfail(strict=True, reason=reason)]
            if (reason := PROPOSE_MISSES.get((label["track"], label["source_interval"][0])))
            else [],
            id=f"{label['track']}-{label['source_interval'][0]}",
        )
        for case_name, label in FILLER_LABELS
    ],
)
def test_find_hits_overlaps_asr_filler_label(
    proposed_hits: dict[str, list[EditDecision]], case_name: str, label: dict
) -> None:
    window_start = CASE_BY_NAME[case_name]["source_interval"][0]
    label_start, label_end = label["source_interval"]
    assert any(
        hit.track_id == label["track"]
        and (hit.reason or "").startswith("filler:")
        and hit.start + window_start <= label_end
        and hit.end + window_start >= label_start
        for hit in proposed_hits[case_name]
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "both Lana hits follow mistimed ASR 'Uh' words onto her gated track's digital "
        "silence; her voiced uh-huh at 1110.25-1110.70 s and 1122.45-1122.95 s stays"
    ),
)
def test_find_hits_filler_cuts_remove_audio_on_their_track(
    proposed_hits: dict[str, list[EditDecision]],
) -> None:
    levels = [
        track_level(
            case,
            hit.track_id,
            hit.start + case["source_interval"][0],
            hit.end + case["source_interval"][0],
        )
        for case in CASES
        for hit in proposed_hits[case["name"]]
        if (hit.reason or "").startswith("filler:")
    ]
    assert levels
    assert set(levels) == {"audio"}
