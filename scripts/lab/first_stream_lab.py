#!/usr/bin/env python3
"""Before/after lab for #2110 (analysis decoders read the first audio stream).

Runs the analysis decoders through two checkouts of sharecut-studio and compares:

    git worktree add /tmp/sc-main origin/main
    git worktree add /tmp/sc-head claude/errors-2110-analysis-stream
    uv run --directory /tmp/sc-head --extra dev --extra gui python /path/to/mac-lab.py \
        --main /tmp/sc-main --head /tmp/sc-head [--project /path/to/project-clone]

Expectations:
  * multi-stream files (kid.ogg, none.mkv, st.mkv, two_b.mkv): on head every decoder output
    equals the output for a copy holding only the first audio stream, and on main it differs
    for at least the decoders that depend on the stream (reported, not failed);
  * single-stream files (mono wav, stereo m4a, h264+aac mp4, cover-art mp3): every decoder
    output is identical on main and head;
  * --project: a copy of a real project (never the live one): per track, level profile inputs
    (load_mono_full), loudness blocks and the stem / proxy render hashes are identical on main
    and head, and the files the project plays are single-stream.

Needs only ffmpeg (PODCAST_MCP_FFMPEG / PODCAST_MCP_FFPROBE) and an interpreter that has the
project's dependencies. Fixtures live in a temporary directory removed at the end. Exit 0 when
every expectation holds, 1 otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SECONDS = 2
RATE = 8000
MULTI = ("kid.ogg", "none.mkv", "two_b.mkv", "st.mkv")
SINGLE = ("mono.wav", "stereo.m4a", "video.mp4", "cover.mp3")


def ffmpeg() -> str:
    return os.environ.get("PODCAST_MCP_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"


def encode(*args: object) -> None:
    subprocess.run([ffmpeg(), "-v", "error", "-y", *map(str, args)], check=True, capture_output=True)


def sine(rate: int, hz: int) -> list[str]:
    return ["-f", "lavfi", "-i", f"sine=f={hz}:r={rate}:d={SECONDS}"]


def build_inputs(directory: Path) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    stereo = "[1:a]pan=stereo|c0=c0|c1=c0[b]"
    five_one = "[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[b]"
    second_default = ["-disposition:a:0", "0", "-disposition:a:1", "default"]
    none = ["-disposition:a:0", "0", "-disposition:a:1", "0"]
    specs = {
        "st.mkv": (
            f"[0:a]pan=stereo|c0=c0|c1=c0[a];{stereo}", "[a]", "pcm_s16le", second_default,
        ),
        "kid.ogg": (stereo, "0:a", "flac", []),
        "none.mkv": (stereo, "0:a", "pcm_s16le", none),
        "two_b.mkv": (five_one, "0:a", "pcm_s16le", second_default),
    }
    inputs: dict[str, Path] = {}
    for name, (graph, first, codec, flags) in specs.items():
        path = directory / name
        encode(
            *sine(22050, 431), *sine(48000, 330),
            "-filter_complex", graph, "-map", first, "-map", "[b]", "-c:a", codec,
            *flags, path,
        )
        inputs[name] = path
        only = directory / f"only_{name}"
        encode("-i", path, "-map", "0:a:0", "-c", "copy", only)
        inputs[f"only_{name}"] = only
    encode(*sine(22050, 431), "-ac", "1", directory / "mono.wav")
    encode(*sine(44100, 330), "-ac", "2", "-c:a", "aac", directory / "stereo.m4a")
    encode(
        "-f", "lavfi", "-i", "color=c=black:s=16x16:d=2", *sine(44100, 330),
        "-map", "0:v", "-map", "1:a", "-c:v", "mpeg4", "-c:a", "aac", directory / "video.mp4",
    )
    encode("-f", "lavfi", "-i", "color=c=gray:s=16x16:d=0.1", "-frames:v", "1", directory / "c.png")
    encode(
        *sine(22050, 431), "-i", directory / "c.png",
        "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "copy",
        "-disposition:v", "attached_pic", directory / "cover.mp3",
    )
    for name in SINGLE:
        inputs[name] = directory / name
    return inputs


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def child(source_root: str, workdir: str, out_path: str, project: str | None) -> None:
    """Runs inside one checkout: run every decoder on every input, write sha rows as JSON."""
    sys.path.insert(0, str(Path(source_root) / "src"))
    import numpy as np

    from podcast_mcp.engines import align, decoded_source, ungated_audio
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    work = Path(workdir)
    inputs = build_inputs(work / "inputs")
    engine = FFmpegEngine()
    rows: dict[str, dict[str, object]] = {}

    def attempt(label: str, call) -> object:
        try:
            return call()
        except Exception as error:
            return f"error:{type(error).__name__}"

    def arr(value) -> str:
        return value if isinstance(value, str) else sha(np.ascontiguousarray(value).tobytes())

    def decoders(path: Path) -> dict[str, object]:
        out: dict[str, object] = {}
        out["load_mono_full"] = arr(attempt("m", lambda: ungated_audio.load_mono_full(path, sample_rate=RATE)))
        out["load_channels_full"] = arr(attempt("c", lambda: ungated_audio.load_channels_full(path, sample_rate=RATE)))
        out["load_mono_window"] = arr(
            attempt("w", lambda: align.load_mono_window(path, start_sec=0.25, duration_sec=0.5, sample_rate=RATE))
        )

        def spooled():
            with decoded_source.decoded_sources(RATE) as held:
                spool = held(path)
                return spool.read(0, spool.size)

        out["decoded_source"] = arr(attempt("d", spooled))

        def streamed():
            rate, channels, chunks = engine.stream_pcm_f32(path)
            return np.concatenate(list(chunks))

        out["stream_pcm_f32"] = arr(attempt("s", streamed))
        out["stream_mono_f32"] = arr(
            attempt("o", lambda: np.concatenate(list(engine.stream_mono_f32(path, sample_rate=RATE))))
        )
        extracted = work / f"seg_{path.name}.wav"
        attempt("e", lambda: engine.extract_segment(path, extracted, 0.25, 1.25))
        out["extract_segment"] = sha(extracted.read_bytes()) if extracted.exists() else "error"
        out["loudness_blocks"] = sha(
            json.dumps(attempt("l", lambda: engine.measure_loudness_blocks(path)), default=str).encode()
        )
        return out

    for name, path in inputs.items():
        rows[name] = decoders(path)

    try:
        from podcast_mcp.edits import join_continuity as jc

        for name in (*MULTI, *(f"only_{n}" for n in MULTI), "mono.wav"):
            scores = attempt("j", lambda p=inputs[name]: jc._score_highrate_batches(
                p, [(0.5, 0.5), (0.8, 0.8)], side_sec=0.02))
            rows[name]["join_batch"] = (
                scores
                if isinstance(scores, str)
                else sha(json.dumps({str(k): v for k, v in scores.items()}, sort_keys=True).encode())
            )
    except Exception as error:
        rows["join_error"] = {"error": f"{type(error).__name__}: {error}"}

    if project:
        rows["project"] = project_rows(Path(project), work)
    Path(out_path).write_text(json.dumps(rows, sort_keys=True), encoding="utf-8")


def project_rows(project_dir: Path, work: Path) -> dict[str, object]:
    import numpy as np

    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines import play_audit, ungated_audio
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.media_probe import probe_media
    from podcast_mcp.models import load_project
    from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

    clone = project_dir
    episode = load_project(clone / "episode.project.json" if clone.is_dir() else clone)
    defaults = load_defaults()
    engine = FFmpegEngine()
    out: dict[str, object] = {}
    for track_id in dialogue_track_ids(episode):
        row: dict[str, object] = {}
        path = track_audio_path(episode, track_id)
        row["streams"] = getattr(probe_media(path), "audio_stream_count", "n/a")
        row["mono_full"] = sha(np.ascontiguousarray(ungated_audio.load_mono_full(path)).tobytes())
        row["loudness"] = sha(json.dumps(engine.measure_loudness_blocks(path), default=str).encode())
        row["stem_hash"] = play_audit.track_render_hash(episode, track_id, defaults=defaults)
        row["proxy_hash"] = play_audit.proxy_render_hash(episode, track_id, defaults=defaults)
        out[track_id] = row
    return out


def run_child(label: str, root: Path, python: str, scratch: Path, project: Path | None):
    workdir = scratch / "work"
    workdir.mkdir(exist_ok=True)
    out = scratch / f"{label}.json"
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    env.pop("PYTHONPATH", None)
    cmd = [python, str(Path(__file__).resolve()), "--child", str(root), str(workdir), str(out)]
    if project:
        cmd += ["--child-project", str(project)]
    done = subprocess.run(cmd, env=env, capture_output=True, text=True)
    shutil.rmtree(workdir, ignore_errors=True)
    if done.returncode != 0:
        sys.exit(f"{label} child failed:\n{done.stderr[-3000:]}")
    return json.loads(out.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--main", type=Path)
    parser.add_argument("--head", type=Path)
    parser.add_argument("--project", type=Path, help="copy of a real project; read, never written")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--child", nargs=3, metavar=("ROOT", "WORKDIR", "OUT"))
    parser.add_argument("--child-project")
    args = parser.parse_args()
    if args.child:
        child(*args.child, args.child_project)
        return 0
    if not (args.main and args.head):
        parser.error("--main and --head are required")
    scratch = Path(tempfile.mkdtemp(prefix="sharecut-lab-2110-"))
    failed = 0
    try:
        if args.project:
            # One copy shared by both checkouts: render hashes embed path, inode and ctime.
            shared = scratch / "project"
            shutil.copytree(args.project, shared, symlinks=True)
            args.project = shared
        before = run_child("main", args.main.resolve(), args.python, scratch, args.project)
        after = run_child("head", args.head.resolve(), args.python, scratch, args.project)
        print(f"{'file':20} {'decoder':20} {'main':18} {'head':18} verdict")
        for name in (*MULTI, *SINGLE):
            for decoder, now in sorted(after[name].items()):
                was = before[name].get(decoder)
                if name in MULTI:
                    oracle = after[f"only_{name}"].get(decoder)
                    ok = now == oracle and not str(now).startswith("error")
                    note = "head == first-stream copy" + ("" if was != now else " (main same)")
                else:
                    ok = was == now
                    note = "identical to main"
                failed += not ok
                print(f"{name:20} {decoder:20} {str(was):18} {str(now):18} {'ok' if ok else 'FAIL'} [{note}]")
        if "project" in after:
            print("--- project (single-stream tapes must be identical on main and head)")
            for track, row in sorted(after["project"].items()):
                was = before["project"].get(track, {})
                for key, now in sorted(row.items()):
                    if key == "streams":
                        print(f"{track:16} audio streams: {now}")
                        continue
                    ok = was.get(key) == now
                    failed += not ok
                    print(f"{track:16} {key:12} {was.get(key)} {now} {'ok' if ok else 'FAIL'}")
        print("RESULT:", "FAIL" if failed else "ok", f"({failed} failures)")
        return 1 if failed else 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
