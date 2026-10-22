"""A long episode's evidence must be built in a few megabytes, not the length of the track."""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.util.binaries import resolve_ffmpeg_pair

# A 3,096 s stereo 48 kHz source and a 3,058 s mono 44.1 kHz one, the Daniela episode's
# sizes: held whole as float32 at their own rates they are 1.2 GB. Each result is 87 MB at
# 8 kHz and 174 MB more at 16 kHz, and the worker keeps one alive between tracks.
SOURCES = {"dani.flac": (3096, 48000, 2), "vicky.flac": (3058, 44100, 1)}
PEAK_GROWTH_BUDGET_MB = 300

WORKER = textwrap.dedent(
    """
    import json, random, resource, sys
    from pathlib import Path

    from podcast_mcp.engines.audio import At, CrossfadeAudio, MixAudio, SequenceAudio, SourceAudio
    from podcast_mcp.engines.track_evidence import Declined, _evaluate

    def tree(path, seconds, seed):
        rng = random.Random(seed)
        at, parts = 0.3, []
        while at < seconds - 15:
            length = rng.uniform(3, 12)
            parts.append(SourceAudio(path, at, at + length, 0.02, 0.03))
            at += length + rng.uniform(0.05, 2.0)
        first = parts[1]
        parts[1] = CrossfadeAudio(
            SourceAudio(path, first.src_start, first.src_end, 0.02, 0.0),
            SourceAudio(path, first.src_end + 0.5, first.src_end + 3.0, 0.0, 0.03),
            0.01,
        )
        return MixAudio(At(0.0, SequenceAudio(parts[0], tuple(parts[1:]))), ())

    def peak_mb():
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / (
            1024 if sys.platform == "darwin" else 1
        )

    baseline = peak_mb()
    sizes = {}
    for name, seconds in json.loads(sys.argv[2]).items():
        evidence = _evaluate(tree(Path(sys.argv[1]) / name, seconds, 1), "tri")
        assert not isinstance(evidence, Declined), evidence
        sizes[name] = evidence[8000].size
        del evidence
    print(json.dumps({"growth_mb": peak_mb() - baseline, "samples": sizes}))
    """
)


@pytest.mark.timeout(300)
def test_building_evidence_for_a_long_mixed_rate_episode_stays_in_budget(tmp_path: Path) -> None:
    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")
    ffmpeg = resolve_ffmpeg_pair().ffmpeg
    for name, (seconds, rate, channels) in SOURCES.items():
        layout = "stereo" if channels == 2 else "mono"
        subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"sine=f=220:r={rate}:d={seconds},aformat=channel_layouts={layout}",
                "-c:a",
                "flac",
                str(tmp_path / name),
            ],
            check=True,
        )

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            WORKER,
            str(tmp_path),
            json.dumps({n: s for n, (s, _, _) in SOURCES.items()}),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout.strip().splitlines()[-1])

    assert all(samples > 2400 * 8000 for samples in report["samples"].values())
    assert report["growth_mb"] < PEAK_GROWTH_BUDGET_MB
