#!/usr/bin/env python3
"""Lab verifier: residual waveform lag or late-join occupancy check.

Acoustic mode (default): median |best_shift| <= threshold (default 50ms).
Clip-geometry sign: positive delays the source track; negative advances it.

Occupancy mode (--occupancy): print first own-speech island vs nearest host
silence after clip geometry; exit non-zero if the island center sits under
host speech (outside any host silence).

Examples:
  .venv/bin/python scripts/verify_align_acoustic.py \\
    --project …/turbo-raw/episode.project.json \\
    --ref audra --src caleb

  .venv/bin/python scripts/verify_align_acoustic.py \\
    --project …/turbo-raw/episode.project.json \\
    --occupancy --ref audra --src lana
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from podcast_mcp.edits.conversation_align import (
    MAX_WORD_AUDIBILITY_SEC,
    NGRAM_N,
    acoustic_clip_offset,
    filter_long_tokens,
    first_utterance_span,
    host_silences,
    own_speech_tokens,
    resolve_clip_wav,
    speech_intervals,
    union_intervals,
    words_to_tokens,
)
from podcast_mcp.models import load_project


def _wav(project, track_id: str) -> Path:
    track = next(t for t in project.tracks if t.id == track_id)
    clip = next((c for c in project.clips if c.track_id == track_id), None)
    if clip is None:
        raise SystemExit(f"track {track_id} has no clips")
    path = resolve_clip_wav(project, track, clip)
    if path is None or not path.is_file():
        raise SystemExit(f"missing audio for track {track_id}")
    return path


def _tokens_for(project, track_id: str):
    tr = next((t for t in project.transcripts if t.track_id == track_id), None)
    if tr is None:
        raise SystemExit(f"no transcript for {track_id}")
    return words_to_tokens(list(tr.words or []))


def verify_occupancy(project, *, src: str, ref: str) -> int:
    src_clip = next(c for c in project.clips if c.track_id == src)
    src_tok = _tokens_for(project, src)
    dialogue_ids = [t.id for t in project.tracks if getattr(t.role, "value", t.role) == "dialogue"]
    all_tok = {tid: _tokens_for(project, tid) for tid in dialogue_ids}
    peers = [all_tok[tid] for tid in dialogue_ids if tid != src]
    own = own_speech_tokens(
        filter_long_tokens(src_tok, max_word_sec=MAX_WORD_AUDIBILITY_SEC),
        [filter_long_tokens(p, max_word_sec=MAX_WORD_AUDIBILITY_SEC) for p in peers],
        n=NGRAM_N,
    )
    span = first_utterance_span(own)
    if span is None:
        print("FAIL: no first utterance on source", file=sys.stderr)
        return 2
    u_start, u_end = span
    sess_s = u_start - src_clip.source_start + src_clip.timeline_start
    sess_e = u_end - src_clip.source_start + src_clip.timeline_start
    center = (sess_s + sess_e) / 2.0

    host_ivs: list[list[tuple[float, float]]] = []
    for tid in dialogue_ids:
        if tid == src:
            continue
        tok = all_tok[tid]
        other = [all_tok[o] for o in dialogue_ids if o != tid]
        host_own = own_speech_tokens(
            filter_long_tokens(tok, max_word_sec=MAX_WORD_AUDIBILITY_SEC),
            [filter_long_tokens(p, max_word_sec=MAX_WORD_AUDIBILITY_SEC) for p in other],
            n=NGRAM_N,
        )
        host_ivs.append(speech_intervals(host_own))
    host_union = union_intervals(host_ivs)
    silences = host_silences(host_union, session_end=max(sess_e + 30.0, 120.0))
    nearest = (
        min(silences, key=lambda se: abs((se[0] + se[1]) / 2.0 - center)) if silences else None
    )
    in_silence = any(s <= center <= e for s, e in silences)
    print(
        f"occupancy src={src} ref={ref} first_island file=[{u_start:.2f},{u_end:.2f}] "
        f"session=[{sess_s:.2f},{sess_e:.2f}] center={center:.2f}  "
        f"clip (ss={src_clip.source_start:.3f},tl={src_clip.timeline_start:.3f})"
    )
    if nearest is not None:
        print(f"nearest_host_silence=[{nearest[0]:.2f},{nearest[1]:.2f}] in_silence={in_silence}")
    else:
        print("nearest_host_silence=none")
    if not in_silence:
        print("FAIL: first island center not in a host silence", file=sys.stderr)
        return 1
    print("OK")
    return 0


def verify_acoustic(args) -> int:
    project = load_project(args.project)
    ref = _wav(project, args.ref)
    src = _wav(project, args.src)

    ref_clip = next(c for c in project.clips if c.track_id == args.ref)
    src_clip = next(c for c in project.clips if c.track_id == args.src)
    session_starts = [float(s) for s in range(15, 400, 10)]
    ref_starts = [s - ref_clip.timeline_start + ref_clip.source_start for s in session_starts]
    src_starts = [s - src_clip.timeline_start + src_clip.source_start for s in session_starts]
    try:
        result = acoustic_clip_offset(
            ref,
            src,
            starts=ref_starts,
            source_starts=src_starts,
            window_sec=args.window,
            max_lag_sec=args.max_lag,
            min_peak=args.min_peak,
        )
    except RuntimeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2
    if result is None:
        print("FAIL: no usable windows", file=sys.stderr)
        return 2
    med = float(result.offset_sec)
    print(
        f"median_lag={med:+.4f}s  n={result.n_windows}  "
        f"threshold={args.threshold:.3f}s  {result.detail}  "
        f"clips {args.src}=({src_clip.source_start:.3f},{src_clip.timeline_start:.3f}) "
        f"{args.ref}=({ref_clip.source_start:.3f},{ref_clip.timeline_start:.3f})"
    )
    if abs(med) > args.threshold:
        print(f"FAIL: |median| {abs(med):.4f} > {args.threshold}", file=sys.stderr)
        return 1
    print("OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", type=Path, required=True)
    ap.add_argument("--ref", required=True, help="Reference track id")
    ap.add_argument("--src", required=True, help="Source track id to measure vs ref")
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--window", type=float, default=8.0)
    ap.add_argument("--max-lag", type=float, default=1.0)
    ap.add_argument("--min-peak", type=float, default=0.05)
    ap.add_argument(
        "--occupancy",
        action="store_true",
        help="Check first own-speech island sits in a host silence",
    )
    args = ap.parse_args()

    if args.occupancy:
        project = load_project(args.project)
        return verify_occupancy(project, src=args.src, ref=args.ref)

    if args.threshold is None:
        args.threshold = 0.05
    return verify_acoustic(args)


if __name__ == "__main__":
    raise SystemExit(main())
