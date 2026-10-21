"""Check that the ONNX ECAPA backend scores a project's speakers like the torch backend (#1998).

Read-only: it never writes profiles or the project. Existing enrolled profiles (made by
either backend) are scored on windows of each dialogue track with both backends, and the
script reports the embedding cosine, the largest score difference per profile and whether
the winning speaker and track agree. It exits 1 on any disagreement or a cosine below 0.999.

    python scripts/compare_speaker_backends.py PROJECT.json [--onnx FILE] [--windows 40]

Needs the torch speaker extra (``uv sync --extra speaker``) alongside the ONNX model; point
``--onnx`` (or ``PODCAST_MCP_SPEAKER_ECAPA_MODEL``) at the exported file.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

WINDOW_SEC = 3.0
MIN_COSINE = 0.999
MAX_SCORE_DELTA = 0.01


def _windows(regions: list[tuple[float, float]], limit: int) -> list[tuple[float, float]]:
    found = [
        (start, start + WINDOW_SEC)
        for begin, end in regions
        for start in np.arange(begin, end - WINDOW_SEC, WINDOW_SEC)
    ]
    if len(found) <= limit:
        return found
    picks = np.linspace(0, len(found) - 1, limit).round().astype(int)
    return [found[i] for i in picks]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("project", type=Path)
    parser.add_argument("--onnx", type=Path, help="exported ONNX file (else the cached model)")
    parser.add_argument("--windows", type=int, default=40, help="windows per track")
    args = parser.parse_args()
    if args.onnx:
        os.environ["PODCAST_MCP_SPEAKER_ECAPA_MODEL"] = str(args.onnx)

    from podcast_mcp.engines import speaker_id
    from podcast_mcp.project.io import open_project
    from podcast_mcp.project.transcript_context import SpeakerIdConfig
    from podcast_mcp.util.tracks import dialogue_track_ids

    _, project = open_project(args.project)
    cfg = SpeakerIdConfig()
    profiles = speaker_id.load_all_profiles(project)
    if not profiles:
        print("no enrolled profiles in this project; run `podcast speaker enroll` first")
        return 2
    torch_backend = speaker_id.resolve_speaker_backend("speechbrain")
    onnx_backend = speaker_id.resolve_speaker_backend("ecapa-onnx")
    print(
        f"backends: {torch_backend.name()} vs {onnx_backend.name()}; profiles: {sorted(profiles)}"
    )

    rows = []
    for track_id in dialogue_track_ids(project):
        path = speaker_id._stem_path(project, track_id)
        if path is None:
            continue
        for start, end in _windows(speaker_id._speech_regions(project, track_id), args.windows):
            samples = speaker_id._decode_window_samples(path, start, end, cfg, None)
            a = torch_backend.embed(samples, cfg.sample_rate)
            b = onnx_backend.embed(samples, cfg.sample_rate)
            cosine = float(a @ b / np.linalg.norm(a) / np.linalg.norm(b))
            ref = speaker_id.score_window(
                project, track_id, start, end, cfg, torch_backend, profiles
            )
            got = speaker_id.score_window(
                project, track_id, start, end, cfg, onnx_backend, profiles
            )
            if ref is None or got is None:
                continue
            rows.append(
                {
                    "track": track_id,
                    "start": round(start, 2),
                    "cosine": cosine,
                    "max_score_delta": max(abs(ref.scores[k] - got.scores[k]) for k in ref.scores),
                    "same_track": ref.best_track_id == got.best_track_id,
                    "same_identity": ref.best_identity == got.best_identity,
                    "margin_delta": abs(ref.margin - got.margin),
                }
            )
    if not rows:
        print("no scorable windows (no transcript words on the dialogue tracks?)")
        return 2
    summary = {
        "windows": len(rows),
        "min_cosine": min(r["cosine"] for r in rows),
        "max_score_delta": max(r["max_score_delta"] for r in rows),
        "max_margin_delta": max(r["margin_delta"] for r in rows),
        "disagreements": [r for r in rows if not (r["same_track"] and r["same_identity"])],
    }
    print(json.dumps(summary, indent=2))
    ok = (
        not summary["disagreements"]
        and summary["min_cosine"] >= MIN_COSINE
        and summary["max_score_delta"] <= MAX_SCORE_DELTA
    )
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
