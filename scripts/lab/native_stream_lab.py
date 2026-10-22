#!/usr/bin/env python3
"""Before/after lab for #2104 (first audio stream, undecodable WAV codes).

Renders multi-stream and control cases through two checkouts of sharecut-studio and compares:

    git worktree add /tmp/sc-main origin/main
    git worktree add /tmp/sc-head claude/errors-2104-native-stream
    uv run --directory /tmp/sc-head --extra dev --extra gui python /path/to/mac-lab.py \
        --main /tmp/sc-main --head /tmp/sc-head

Needs only ffmpeg (PODCAST_MCP_FFMPEG / PODCAST_MCP_FFPROBE, or the ones on PATH) and an
interpreter that has the project's dependencies. Fixtures are built in a temporary directory that
is removed at the end. Exit 0 when every expectation holds, 1 otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SECONDS = 2
MULTI = ("kid.ogg", "none.mkv", "two_b.mkv", "st.mkv")
FIRST_RATE = 22050


def ffmpeg() -> str:
    return os.environ.get("PODCAST_MCP_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"


def encode(*args: object) -> None:
    subprocess.run(
        [ffmpeg(), "-v", "error", "-y", *map(str, args)], check=True, capture_output=True
    )


def sine(rate: int, hz: int) -> list[str]:
    return ["-f", "lavfi", "-i", f"sine=f={hz}:r={rate}:d={SECONDS}"]


def build_multistream(directory: Path, name: str) -> Path:
    path = directory / name
    stereo = "[1:a]pan=stereo|c0=c0|c1=c0[b]"
    five_one = "[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[b]"
    second_default = ["-disposition:a:0", "0", "-disposition:a:1", "default"]
    none = ["-disposition:a:0", "0", "-disposition:a:1", "0"]
    if name == "st.mkv":
        encode(
            *sine(22050, 431),
            *sine(48000, 330),
            "-filter_complex",
            "[0:a]pan=stereo|c0=c0|c1=c0[a];[1:a]pan=stereo|c0=c0|c1=c0[b]",
            *("-map", "[a]", "-map", "[b]", "-c:a", "pcm_s16le"),
            *second_default,
            path,
        )
        return path
    graph, codec, flags = {
        "kid.ogg": (stereo, "flac", []),
        "none.mkv": (stereo, "pcm_s16le", none),
        "two_b.mkv": (five_one, "pcm_s16le", second_default),
    }[name]
    encode(
        *sine(22050, 431),
        *sine(48000, 330),
        "-filter_complex",
        graph,
        *("-map", "0:a", "-map", "[b]", "-c:a", codec),
        *flags,
        path,
    )
    return path


def write_wav(path: Path, rate: int, seconds: float, channels: int = 1) -> Path:
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(channels)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(
            b"".join(
                struct.pack("<h", int(8000 * ((n // 40) % 2 * 2 - 1))) * channels
                for n in range(frames)
            )
        )
    return path


def riff(*chunks: bytes) -> bytes:
    body = b"WAVE" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def chunk(chunk_id: bytes, body: bytes) -> bytes:
    return chunk_id + struct.pack("<I", len(body)) + body + (b"\0" if len(body) % 2 else b"")


def build_inputs(directory: Path) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    inputs = {name: build_multistream(directory, name) for name in MULTI}
    inputs["plain.wav"] = write_wav(directory / "plain.wav", 48000, SECONDS)
    fmt = chunk(b"fmt ", struct.pack("<HHIIHH", 1, 1, 16000, 32000, 2, 16))
    pcm = struct.pack("<800h", *([1000, -1000] * 400))
    for name, body in {
        "list0.wav": riff(fmt, chunk(b"LIST", b""), chunk(b"data", pcm)),
        "smv0.wav": riff(fmt, chunk(b"SMV0", bytes(8)), chunk(b"data", pcm)),
        "xma2_first.wav": riff(chunk(b"XMA2", bytes(34)), fmt, chunk(b"data", pcm)),
        "one_byte.wav": riff(fmt, chunk(b"data", b"\0")),
    }.items():
        (directory / name).write_bytes(body)
        inputs[name] = directory / name
    encode("-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.2", "-c:v", "mpeg4", directory / "v.mp4")
    inputs["video_only.mp4"] = directory / "v.mp4"
    return inputs


def child(source_root: str, workdir: str, out_path: str) -> None:
    """Runs inside one checkout: render every case and write one JSON row per case."""
    sys.path.insert(0, str(Path(source_root) / "src"))
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines import source_proxy_audio as proxy
    from podcast_mcp.engines import timeline_render, transcript_gated_play
    from podcast_mcp.engines.audio import At, MixAudio, SourceAudio
    from podcast_mcp.engines.bleed_gate import BleedGatePlan
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.models import Clip, ClipBleedRestore, EpisodeProject, MediaAsset, Track
    from podcast_mcp.models.episode import SourceSpan
    from podcast_mcp.util.hashing import sha256_file

    work = Path(workdir)
    inputs = build_inputs(work / "inputs")
    rows: dict[str, dict[str, object]] = {}

    def describe(path: Path) -> dict[str, object]:
        with wave.open(str(path), "rb") as stream:
            return {
                "rate": stream.getframerate(),
                "frames": stream.getnframes(),
                "sha": hashlib.sha256(path.read_bytes()).hexdigest()[:16],
            }

    def attempt(case: str, out: Path, render) -> None:
        try:
            render()
            rows[case] = describe(out)
        except Exception as error:
            rows[case] = {"error": f"{type(error).__name__}:{getattr(error, 'code', '')}"}

    def mix(head: Path, delayed: Path, *, head_seconds: float = 1.0) -> MixAudio:
        return MixAudio(
            At(0.0, SourceAudio(head, 0.0, head_seconds)),
            (At(0.25, SourceAudio(delayed, 0.0, 0.1)),),
        )

    child_wav = write_wav(work / "child44.wav", 44100, 1.0)
    for name, path in inputs.items():
        if name in MULTI or name == "plain.wav":
            out = work / f"plain_{name}.wav"
            attempt(
                f"plain/{name}",
                out,
                lambda path=path, out=out: FFmpegEngine().render_timeline(
                    out, mix(path, child_wav), "anull"
                ),
            )
            out = work / f"restore_{name}.wav"
            attempt(
                f"restore/{name}",
                out,
                lambda path=path, name=name, out=out: FFmpegEngine().render_timeline(
                    out, mix(path, child_wav), "anull", clock_path=work / f"clock_{name}.json"
                ),
            )
        else:
            out = work / f"child_{name}.wav"
            attempt(
                f"delayed-child/{name}",
                out,
                lambda path=path, out=out: FFmpegEngine().render_timeline(
                    out, mix(inputs["plain.wav"], path), "anull"
                ),
            )

    def project(source: Path, gated: bool) -> tuple[EpisodeProject, Track, Clip]:
        shutil.copy(source, work / f"source{source.suffix}")
        local = work / f"source{source.suffix}"
        episode = EpisodeProject.create("Lab", str(work))
        track = Track(
            id="origin",
            label="Origin",
            media=MediaAsset(path=local.name),
            transcript_gate=gated,
        )
        clip = Clip(
            id="selected",
            track_id="origin",
            source_start=0.2,
            source_end=1.2,
            timeline_start=1.0,
            bleed_restore=ClipBleedRestore(
                source_sha256=sha256_file(local), regions=[SourceSpan(start_s=0.45, end_s=0.9)]
            ),
        )
        episode.tracks = [track]
        episode.clips = [clip]
        return episode, track, clip

    plan = BleedGatePlan(attenuation_spans=((0.05, 1.95),), fade_sec=0.02)
    proxy.build_bleed_gate_plan = lambda *_a, **_k: plan
    transcript_gated_play.build_bleed_gate_plan = lambda *_a, **_k: plan
    for name in MULTI:
        episode, track, clip = project(inputs[name], gated=False)
        out = work / f"chain_{name}.wav"
        attempt(
            f"source-chain/{name}",
            out,
            lambda episode=episode, track=track, out=out: timeline_render.render_source_with_chain(
                episode, track, out, defaults=load_defaults()
            ),
        )
        episode, track, clip = project(inputs[name], gated=True)
        out = work / f"proxy_{name}.wav"
        attempt(
            f"proxy-restore/{name}",
            out,
            lambda episode=episode, clip=clip, out=out: proxy.render_source_proxy_restore(
                episode, clip.id, out, defaults=load_defaults()
            ),
        )
    episode, track, clip = project(inputs["plain.wav"], gated=True)
    attempt(
        "proxy-restore/plain.wav",
        work / "proxy_plain.wav",
        lambda: proxy.render_source_proxy_restore(
            episode, clip.id, work / "proxy_plain.wav", defaults=load_defaults()
        ),
    )
    rows["identity"] = {
        "render_semantics_rev": timeline_render.RENDER_SEMANTICS_REV,
        "proxy_revision": proxy.SourceProxyInputs.capture_occurrence(
            episode, clip.id, FFmpegEngine(), defaults=load_defaults()
        ).identity_payload["revision"],
    }
    Path(out_path).write_text(json.dumps(rows, sort_keys=True), encoding="utf-8")


def run_child(label: str, root: Path, python: str, scratch: Path) -> dict[str, dict[str, object]]:
    workdir = scratch / label
    workdir.mkdir()
    out = scratch / f"{label}.json"
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    env.pop("PYTHONPATH", None)
    done = subprocess.run(
        [python, str(Path(__file__).resolve()), "--child", str(root), str(workdir), str(out)],
        env=env,
        capture_output=True,
        text=True,
    )
    if done.returncode != 0:
        sys.exit(f"{label} child failed:\n{done.stderr[-2000:]}")
    return json.loads(out.read_text(encoding="utf-8"))


def verdicts(main: dict, head: dict) -> list[tuple[str, str, str, str, bool]]:
    rows = []
    for case in sorted(k for k in head if k != "identity"):
        before, after = main[case], head[case]
        kind, _, name = case.partition("/")
        if name in MULTI:
            if kind == "plain":
                ok = after.get("rate") == FIRST_RATE and before.get("rate") != FIRST_RATE
            elif kind == "restore":
                ok = after.get("rate") == FIRST_RATE
            else:
                ok = after.get("rate") == FIRST_RATE and after.get("frames") == 2 * FIRST_RATE
            expect = f"head renders at {FIRST_RATE} Hz (stream 0)"
        elif name == "plain.wav":
            ok = before == after
            expect = "identical to main"
        elif kind == "delayed-child" and name != "video_only.mp4":
            ok = after.get("error") == "CodedValueError:render_rate_unresolved"
            expect = "head: render_rate_unresolved (main: bare CalledProcessError)"
        else:
            ok = before == after
            expect = "identical to main"
        rows.append((case, fmt_row(before), fmt_row(after), expect, ok))
    return rows


def fmt_row(row: dict[str, object]) -> str:
    if "error" in row:
        return str(row["error"])
    return f"{row['rate']} Hz / {row['frames']} fr / {row['sha']}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--main", type=Path, help="checkout of origin/main")
    parser.add_argument("--head", type=Path, help="checkout of claude/errors-2104-native-stream")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--child", nargs=3, metavar=("ROOT", "WORKDIR", "OUT"))
    args = parser.parse_args()
    if args.child:
        child(*args.child)
        return 0
    if not (args.main and args.head):
        parser.error("--main and --head are required")
    scratch = Path(tempfile.mkdtemp(prefix="sharecut-lab-2104-"))
    try:
        before = run_child("main", args.main.resolve(), args.python, scratch)
        after = run_child("head", args.head.resolve(), args.python, scratch)
        failed = 0
        print(f"{'case':28} {'main':44} {'head':44} ok")
        for case, was, now, expect, ok in verdicts(before, after):
            failed += not ok
            print(f"{case:28} {was:44} {now:44} {'ok' if ok else 'FAIL'}  [{expect}]")
        print("identity main:", before["identity"])
        print("identity head:", after["identity"])
        identity_ok = (
            after["identity"]["render_semantics_rev"]
            == before["identity"]["render_semantics_rev"] + 1
            and after["identity"]["proxy_revision"] != before["identity"]["proxy_revision"]
        )
        print("identity moved:", "ok" if identity_ok else "FAIL")
        return 1 if failed or not identity_ok else 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
