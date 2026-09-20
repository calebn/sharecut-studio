#!/usr/bin/env python3
"""Build tests/fixtures/synthetic_bleed_60s from clean stems + controlled cross-bleed."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models.episode import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project_store import ProjectStore

DEFAULT_DURATION_SEC = 60.0
SAMPLE_RATE = 48000


def _default_manifest() -> dict:
    host_words = [
        ("welcome", 2.0, 2.6),
        ("to", 2.6, 2.9),
        ("the", 2.9, 3.2),
        ("show", 3.2, 3.8),
        ("todae", 10.0, 10.5, 0.5),
        ("we", 10.5, 10.8),
        ("discuss", 10.8, 11.4),
        ("documented", 11.4, 12.2),
        ("stories", 12.2, 12.8),
        ("and", 12.8, 13.1),
        ("real", 13.1, 13.5),
        ("change", 13.5, 14.2),
        ("for", 14.2, 14.5),
        ("people", 14.5, 15.1),
        ("who", 15.1, 15.4),
        ("care", 15.4, 16.0),
    ]
    guest_words = [
        ("today", 10.0, 10.5),
        ("thanks", 12.0, 12.5),
        ("for", 12.5, 12.8),
        ("having", 12.8, 13.3),
        ("me", 13.3, 13.6),
        ("here", 13.6, 14.1),
        ("today", 14.1, 14.6),
        ("great", 14.6, 15.1),
        ("to", 15.1, 15.3),
        ("be", 15.3, 15.5),
        ("back", 15.5, 16.0),
        ("hello", 40.0, 40.5),
        ("everyone", 40.5, 41.2),
        ("listening", 41.2, 42.0),
        ("on", 42.0, 42.2),
        ("the", 42.2, 42.5),
        ("podcast", 42.5, 43.2),
    ]
    return {
        "duration_sec": DEFAULT_DURATION_SEC,
        "tracks": {
            "host": {"freq_hz": 440, "words": host_words},
            "guest": {"freq_hz": 880, "words": guest_words},
        },
        "bleed_events": [
            {
                "window": {"start": 12.0, "end": 16.0},
                "duck": {"into": "host", "gain_db": -30},
                "inject": [
                    {"from": "guest", "into": "host", "gain_db": -10},
                    {"from": "host", "into": "guest", "gain_db": -32},
                ],
            }
        ],
        "expected_metrics": {
            "min_bleed_words_host": 3,
            "min_bleed_words_total": 3,
            "min_cross_track_precorrect": 1,
            "min_overlap_pairs": 1,
        },
    }


def _words_from_tuples(
    track_id: str,
    tuples: list[tuple[str, float, float] | tuple[str, float, float, float]],
) -> list[TranscriptWord]:
    words: list[TranscriptWord] = []
    for item in tuples:
        text, start, end = item[0], item[1], item[2]
        confidence = item[3] if len(item) > 3 else 0.99
        words.append(TranscriptWord(text=text, start=start, end=end, confidence=confidence))
    return words


def _render_burst_segment(
    *,
    ffmpeg: str,
    out: Path,
    freq: float,
    start: float,
    end: float,
    amplitude: float = 0.85,
    min_dur: float = 0.12,
) -> None:
    span = max(0.05, end - start)
    dur = max(min_dur, span)
    mid = (start + end) / 2.0
    burst_start = max(0.0, mid - dur / 2.0)
    delay_ms = int(burst_start * 1000)
    cmd = [
        ffmpeg,
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"anullsrc=r={SAMPLE_RATE}:cl=mono:d={dur}",
        "-f",
        "lavfi",
        "-i",
        f"sine=f={freq}:duration={dur}",
        "-filter_complex",
        (
            f"[1:a]volume={amplitude}[tone];"
            f"[0:a][tone]amix=inputs=2:duration=first:dropout_transition=0,"
            f"adelay={delay_ms}|{delay_ms}"
        ),
        "-t",
        str(DEFAULT_DURATION_SEC),
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _render_clean_track(
    engine: FFmpegEngine,
    *,
    words: list[tuple[str, float, float]],
    freq: float,
    out_dir: Path,
    track_id: str,
    duration_sec: float = DEFAULT_DURATION_SEC,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / f"{track_id}_clean.wav"
    if not words:
        subprocess.run(
            [
                engine.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r={SAMPLE_RATE}:cl=mono:d={duration_sec}",
                str(final),
            ],
            check=True,
            capture_output=True,
        )
        return final

    cmd = [
        engine.ffmpeg,
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"anullsrc=r={SAMPLE_RATE}:cl=mono:d={duration_sec}",
    ]
    filters: list[str] = []
    labels: list[str] = []
    for i, item in enumerate(words):
        _text, start, end = item[0], item[1], item[2]
        span = max(0.05, end - start)
        dur = max(0.12, span)
        mid = (start + end) / 2.0
        burst_start = max(0.0, mid - dur / 2.0)
        delay_ms = int(burst_start * 1000)
        cmd.extend(["-f", "lavfi", "-i", f"sine=f={freq}:duration={dur}"])
        idx = i + 1
        label = f"b{i}"
        filters.append(f"[{idx}:a]volume=0.9,adelay={delay_ms}|{delay_ms}[{label}]")
        labels.append(f"[{label}]")
    mix_inputs = "[0:a]" + "".join(labels)
    count = 1 + len(words)
    filters.append(
        f"{mix_inputs}amix=inputs={count}:duration=first:dropout_transition=0:normalize=0[out]"
    )
    cmd.extend(["-filter_complex", ";".join(filters), "-map", "[out]", str(final)])
    subprocess.run(cmd, check=True, capture_output=True)
    return final


def _gain_linear(gain_db: float) -> float:
    return 10 ** (gain_db / 20.0)


def _apply_bleed_events(
    engine: FFmpegEngine,
    *,
    tracks: dict[str, Path],
    bleed_events: list[dict],
    out_dir: Path,
) -> dict[str, Path]:
    result = {tid: path for tid, path in tracks.items()}
    for event in bleed_events:
        window = event["window"]
        start = float(window["start"])
        end = float(window["end"])
        duck = event.get("duck")
        if duck:
            dst_id = duck["into"]
            gain_db = float(duck.get("gain_db", -12))
            gain = _gain_linear(gain_db)
            dst = result[dst_id]
            out = out_dir / f"{dst_id}_duck_{int(start)}.wav"
            filt = f"[0:a]volume=enable='between(t,{start},{end})':volume={gain}[out]"
            subprocess.run(
                [
                    engine.ffmpeg,
                    "-y",
                    "-i",
                    str(dst),
                    "-filter_complex",
                    filt,
                    "-map",
                    "[out]",
                    str(out),
                ],
                check=True,
                capture_output=True,
            )
            result[dst_id] = out
        for inject in event.get("inject", []):
            src_id = inject["from"]
            dst_id = inject["into"]
            gain_db = float(inject["gain_db"])
            gain = _gain_linear(gain_db)
            src = result[src_id]
            dst = result[dst_id]
            out = out_dir / f"{dst_id}_bleed_{src_id}_{int(start)}.wav"
            filt = (
                f"[1:a]volume=enable='between(t,{start},{end})':volume={gain}[bleed];"
                f"[0:a][bleed]amix=inputs=2:duration=first:dropout_transition=0[out]"
            )
            cmd = [
                engine.ffmpeg,
                "-y",
                "-i",
                str(dst),
                "-i",
                str(src),
                "-filter_complex",
                filt,
                "-map",
                "[out]",
                str(out),
            ]
            subprocess.run(cmd, check=True, capture_output=True)
            result[dst_id] = out
    return result


def _validate_bleed(
    project_path: Path,
    *,
    min_bleed_total: int,
) -> int:
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.transcript_reconcile import audibility_map
    from podcast_mcp.engines.audio_audit import AnalysisPolicy
    from podcast_mcp.pipeline import steps as pipeline_steps
    from podcast_mcp.project_store import ProjectStore

    store = ProjectStore(project_path)
    project = store.load()
    artifacts = project.artifacts_dir()
    if artifacts.is_dir():
        import shutil

        shutil.rmtree(artifacts)
    defaults = load_defaults()
    pipeline_steps.ingest_tracks(project, defaults)
    pipeline_steps.assemble_timeline(project, defaults)
    store.commit(project)
    policy = AnalysisPolicy(transcript_mode="reconcile")
    rows = audibility_map(project, policy=policy)
    bleed = sum(1 for r in rows if r.get("audibility_status") == "bleed")
    if bleed < min_bleed_total:
        raise RuntimeError(
            f"bleed validation failed: {bleed} bleed words (need >={min_bleed_total})"
        )
    return bleed


def _write_project(
    out_root: Path,
    *,
    host_wav: Path,
    guest_wav: Path,
    host_words: list[TranscriptWord],
    guest_words: list[TranscriptWord],
) -> Path:
    raw = out_root / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    host_dst = raw / "host.wav"
    guest_dst = raw / "guest.wav"
    host_dst.write_bytes(host_wav.read_bytes())
    guest_dst.write_bytes(guest_wav.read_bytes())

    project = EpisodeProject.create("synthetic bleed 60s", str(out_root.resolve()))
    project.timeline.duration_sec = DEFAULT_DURATION_SEC
    for tid, speaker, wav in (
        ("host", "Host", host_dst),
        ("guest", "Guest", guest_dst),
    ):
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=speaker,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(
                    path=f"raw/{wav.name}",
                    duration_sec=DEFAULT_DURATION_SEC,
                    sample_rate=SAMPLE_RATE,
                    channels=1,
                ),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"clip_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=DEFAULT_DURATION_SEC,
                timeline_start=0.0,
            )
        )
    project.transcripts = [
        Transcript(track_id="host", language="en", words=host_words),
        Transcript(track_id="guest", language="en", words=guest_words),
    ]
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)

    project_path = out_root / "episode.project.json"
    store = ProjectStore(project_path)
    store.commit(project)
    return project_path


def build_fixture(
    out_root: Path,
    *,
    manifest: dict | None = None,
    validate: bool = True,
) -> None:
    manifest = manifest or _default_manifest()
    engine = FFmpegEngine()
    build_dir = out_root / "_build"
    if build_dir.exists():
        import shutil

        shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True, exist_ok=True)

    clean: dict[str, Path] = {}
    transcripts: dict[str, list[TranscriptWord]] = {}
    for track_id, spec in manifest["tracks"].items():
        tuples = [tuple(w) for w in spec["words"]]
        transcripts[track_id] = _words_from_tuples(track_id, tuples)
        clean[track_id] = _render_clean_track(
            engine,
            words=tuples,
            freq=float(spec["freq_hz"]),
            out_dir=build_dir / track_id,
            track_id=track_id,
        )

    mixed = _apply_bleed_events(
        engine,
        tracks=clean,
        bleed_events=manifest["bleed_events"],
        out_dir=build_dir,
    )

    gt_dir = out_root / "ground_truth"
    gt_dir.mkdir(parents=True, exist_ok=True)
    for track_id, words in transcripts.items():
        payload = {
            "track_id": track_id,
            "language": "en",
            "words": [w.model_dump() for w in words],
        }
        (gt_dir / f"{track_id}.json").write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )
    (gt_dir / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False),
        encoding="utf-8",
    )

    project_path = _write_project(
        out_root,
        host_wav=mixed["host"],
        guest_wav=mixed["guest"],
        host_words=transcripts["host"],
        guest_words=transcripts["guest"],
    )

    expected = manifest.get("expected_metrics", {})
    expected["validated_at"] = datetime.now(UTC).isoformat()
    if validate:
        bleed_count = _validate_bleed(
            project_path,
            min_bleed_total=int(expected.get("min_bleed_words_total", 1)),
        )
        expected["observed_bleed_words"] = bleed_count
    (out_root / "expected_metrics.json").write_text(
        json.dumps(expected, indent=2),
        encoding="utf-8",
    )

    readme = out_root / "README.md"
    readme.write_text(
        "# synthetic_bleed_60s\n\n"
        "Two-track fixture with controlled cross-bleed (12-16s overlap).\n\n"
        "Regenerate: `python scripts/build_synthetic_bleed_fixture.py`\n",
        encoding="utf-8",
    )
    (out_root / ".gitignore").write_text("_build/\nartifacts/\nhistory/\n", encoding="utf-8")
    for cleanup in (out_root / "artifacts", out_root / "_build", out_root / "history"):
        if cleanup.is_dir():
            import shutil

            shutil.rmtree(cleanup)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=_REPO / "tests" / "fixtures" / "synthetic_bleed_60s",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Optional YAML manifest (default: built-in recipe)",
    )
    parser.add_argument(
        "--no-validate",
        action="store_true",
        help="Skip post-build bleed validation",
    )
    args = parser.parse_args()
    manifest = None
    if args.manifest:
        manifest = yaml.safe_load(args.manifest.read_text(encoding="utf-8"))
    build_fixture(
        args.output.resolve(),
        manifest=manifest,
        validate=not args.no_validate,
    )
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
