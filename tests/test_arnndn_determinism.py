"""arnndn renders are byte-identical when the input ends in a partial 480-sample frame (#4554)."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import wave
from pathlib import Path

import pytest

from conftest import REAL_HOME
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import ProcessingChain, ProcessingEffect
from podcast_mcp.util.binaries import FFmpegPairResolutionError
from podcast_mcp.util.model_assets import RNNOISE_MODEL_NAME, resolve_rnnoise_model

FRAME = 480

# (id, source rate, source frames, renders, effects before arnndn, exact output frames or None)
CASES = [
    pytest.param(48_000, 1_229_926, 20, (), 1_230_240, id="48k-odd"),
    pytest.param(44_100, 1_129_926, 12, (), None, id="44k1-odd"),
    pytest.param(48_000, 1_229_926, 12, ("loudnorm",), None, id="loudnorm-then-arnndn"),
    pytest.param(48_000, 1_229_926, 12, ("highpass",), 1_230_240, id="highpass-then-arnndn"),
]

pytestmark = pytest.mark.slow


def _tool(env: str, name: str) -> str:
    found = os.environ.get(env) or shutil.which(name)
    if not found:
        pytest.skip(f"{name} not available (set {env})")
    return found


def _frames(path: Path) -> int:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes()


@pytest.mark.parametrize(("rate", "frames", "renders", "pre", "expected_frames"), CASES)
def test_arnndn_partial_frame_render_is_deterministic(
    tmp_path: Path,
    rate: int,
    frames: int,
    renders: int,
    pre: tuple[str, ...],
    expected_frames: int | None,
):
    ffmpeg = _tool("PODCAST_MCP_FFMPEG", "ffmpeg")
    ffprobe = _tool("PODCAST_MCP_FFPROBE", "ffprobe")
    # conftest isolates the model cache dir, so also look in the user's real cache.
    real_cache = REAL_HOME / ".cache" / "podcast_mcp" / "models" / RNNOISE_MODEL_NAME
    try:
        model = resolve_rnnoise_model()
    except FileNotFoundError as exc:
        if not real_cache.is_file():
            pytest.skip(f"RNNoise model not bootstrapped: {exc}")
        model = real_cache

    src = tmp_path / "src.wav"
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"anoisesrc=r={rate}:c=pink:seed=7:a=0.1",
            "-f",
            "lavfi",
            "-i",
            f"sine=f=440:r={rate}",
            "-filter_complex",
            f"[0:a][1:a]amix=inputs=2:duration=first,aformat=sample_fmts=s16:channel_layouts=stereo,"
            f"atrim=end_sample={frames}",
            "-ar",
            str(rate),
            "-ac",
            "2",
            str(src),
        ],
        check=True,
        capture_output=True,
    )

    chain = ProcessingChain(
        track_id="host",
        effects=[
            *(ProcessingEffect(effect=name, params={}) for name in pre),
            ProcessingEffect(effect="arnndn", params={"model": str(model)}),
        ],
    )
    try:
        engine = FFmpegEngine(ffmpeg=ffmpeg, ffprobe=ffprobe)
    except FFmpegPairResolutionError as exc:
        pytest.skip(f"pinned FFmpeg 9.x pair not available: {exc}")
    filt = engine.build_track_filter(chain, None)

    hashes: set[str] = set()
    last: Path | None = None
    for i in range(renders):
        out = tmp_path / f"out{i}.wav"
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", str(src), "-af", filt, str(out)],
            check=True,
            capture_output=True,
        )
        hashes.add(hashlib.sha256(out.read_bytes()).hexdigest())
        last = out
    assert len(hashes) == 1, f"{len(hashes)} distinct renders of {renders}"
    assert last is not None
    out_frames = _frames(last)
    if expected_frames is not None:
        assert out_frames == expected_frames
    elif not pre:
        assert out_frames % FRAME == 0, out_frames
