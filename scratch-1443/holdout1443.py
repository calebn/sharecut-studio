"""Holdout podcast_016 before/after harness for #1443 (copies only, never ~/Dropbox).

usage:
  holdout1443.py prep                    transcribe the unscaled copy once (live ASR, under the lab's ASR lock),
                                         then build guest-12 and guest-24 (track #06 scaled alone) with its words
  holdout1443.py run WORKERS JOB...      JOB = LABEL:VARIANT, e.g. after:guest-24
Outputs land in holdout-corpus/runs-1443/out/ as the lab harness writes them (words, mute, ripple, gate).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

STATE = Path(__file__).resolve().parent
HOLDOUT = Path.home() / "projects/podcast_mcp-session-state/holdout-corpus"
SOURCE = HOLDOUT / "podcast_016"
RUNS = HOLDOUT / "runs-1443"
OUT = RUNS / "out"
LAB = Path.home() / "projects/ShareCut_Podcast_Test"
PODCAST = Path("/Users/caleb.nelson/projects/podcast_mcp/.claude/worktrees/agent-a05a1cc5f14b3fe51/.venv/bin/podcast")
TRACKS = {"host": "Audio Track#05.aif", "guest": "Audio Track#06.aif"}
VARIANTS = {"g0": 0.0, "x-guest-0": 0.0, "guest-12": -12.0, "guest-24": -24.0, "x-guest-12": -12.0, "x-guest-24": -24.0}
MANIFEST = """session:
  reference_speaker: Host
speakers:
  - name: Host
    sources:
      - host.wav
    session_start_in_file_sec: 0
  - name: Guest
    sources:
      - guest.wav
    session_start_in_file_sec: 0
    session_offset_sec: 0
"""


def sh(cmd, *, env=None, log=None):
    res = subprocess.run(["nice", "-n", "10", *cmd], capture_output=True, text=True, env=env, cwd=RUNS)
    if log is not None:
        with log.open("a") as fh:
            fh.write(f"$ {' '.join(map(str, cmd))}\n{res.stdout[-4000:]}\n{res.stderr[-4000:]}\nrc={res.returncode}\n")
    if res.returncode:
        raise SystemExit(f"failed: {cmd[:4]} rc={res.returncode}")
    return res


def exact(variant: str) -> None:
    """``x-guest-N``: the unscaled base with the guest's 16-bit raw rewritten as float, scaled
    exactly, so the copy differs from the original by gain alone."""
    dst = RUNS / f"base-{variant}"
    if (dst / ".exact-1443").exists():
        return
    if dst.exists():
        shutil.rmtree(dst)
    subprocess.run(["cp", "-ac", str(RUNS / "base-g0"), str(dst)], check=True)
    raw = dst / "raw" / "guest.wav"
    tmp = raw.with_suffix(".f32.wav")
    gain = VARIANTS[variant]
    sh(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", f"volume={gain}dB", "-c:a", "pcm_f32le", str(tmp)])
    tmp.replace(raw)
    # Hold the unscaled run's words: re-flag them like the scaled variants, never re-transcribe.
    seed = json.loads((dst / "seed.json").read_text())
    for t in seed["transcripts"]["per_track"]:
        for w in t["words"]:
            w["suspect_hallucination"] = False
        for k in ("audio_sha256", "audio_size", "audio_mtime_ns", "silence_filter_fingerprint"):
            t[k] = None
    (dst / "seed.json").write_text(json.dumps(seed))
    (dst / ".exact-1443").write_text("ok")
    print("exact", variant, flush=True)


def base(variant: str) -> None:
    if variant.startswith("x-"):
        return exact(variant)
    dst = RUNS / f"base-{variant}"
    if (dst / "seed.json").exists():
        return
    audio = RUNS / f"audio-{variant}"
    audio.mkdir(parents=True, exist_ok=True)
    for name, src in TRACKS.items():
        out = audio / f"{name}.wav"
        if not out.exists():
            gain = VARIANTS[variant] if name == "guest" else 0.0
            sh(["ffmpeg", "-v", "error", "-y", "-i", str(SOURCE / src), "-ac", "1", "-af", f"volume={gain}dB", "-c:a", "pcm_f32le", str(out)])
    (RUNS / "ingest.yaml").write_text(MANIFEST)
    if dst.exists():
        shutil.rmtree(dst)
    env = {**os.environ, "PYTHONPATH": str(STATE / "trees/before/src")}
    log = RUNS / f"base-{variant}.log"
    project = dst / "episode.project.json"
    sh([str(PODCAST), "episode", "init", "--dir", str(dst), "--name", f"holdout016 {variant}"], env=env, log=log)
    sh([str(PODCAST), "ingest", "consolidate", "--audio-dir", str(audio), "--manifest", str(RUNS / "ingest.yaml"), "--project", str(project)], env=env, log=log)
    if variant == "g0":
        sh([str(LAB / "scripts/with-asr-lock.sh"), str(PODCAST), "pipeline", "run", "--project", str(project), "--only", "transcribe_tracks"], env=env, log=log)
    else:
        seed = json.loads((RUNS / "base-g0/seed.json").read_text())
        mine = json.loads(project.read_text())
        mine["transcripts"] = seed["transcripts"]
        for t in mine["transcripts"]["per_track"]:
            for w in t["words"]:
                w["suspect_hallucination"] = False
            for k in ("audio_sha256", "audio_size", "audio_mtime_ns", "silence_filter_fingerprint"):
                t[k] = None
        project.write_text(json.dumps(mine))
    shutil.copy(project, dst / "seed.json")
    print("based", variant, flush=True)


def words_record(project: Path) -> dict:
    d = json.loads(project.read_text())
    return {
        t["track_id"]: [
            [w["text"], w["start"], w["end"], bool(w.get("suppressed")), w.get("audibility_status"), w.get("dominant_track"), bool(w.get("suspect_hallucination"))]
            for w in t["words"]
        ]
        for t in d["transcripts"]["per_track"]
    }


def job(spec: str) -> str:
    label, variant = spec.split(":")
    name = f"{label}-{variant}-holdout"
    if (OUT / f"{name}-gate.json").exists():
        return f"{name} cached"
    started = time.time()
    env = {**os.environ, "PYTHONPATH": str(STATE / "trees" / label / "src")}
    work = RUNS / f"work-{name}"
    if work.exists():
        shutil.rmtree(work)
    subprocess.run(["cp", "-ac", str(RUNS / f"base-{variant}"), str(work)], check=True)
    project = work / "episode.project.json"
    shutil.copy(work / "seed.json", project)
    log = OUT / f"{name}.log"
    log.write_text("")
    try:
        for step in ("transcribe_tracks", "merge_transcript", "render_dialogue_stems", "reconcile_transcript", "precorrect_transcript"):
            sh([str(PODCAST), "pipeline", "run", "--project", str(project), "--only", step], env=env, log=log)
        sh([str(PODCAST), "transcript", "refine-waive", "--project", str(project), "--reason", "holdout 1443"], env=env, log=log)
        sh([str(PODCAST), "align", "waive", "--project", str(project), "--reason", "separate raws at offset 0"], env=env, log=log)
        (OUT / f"{name}-words.json").write_text(json.dumps(words_record(project)))
        for mode in ("mute", "ripple"):
            res = sh([str(PODCAST), "propose-edits", "--project", str(project), "--edit-mode", mode, "--intensity", "medium", "--json"], env=env, log=log)
            (OUT / f"{name}-{mode}.json").write_text(res.stdout)
        res = sh([str(PODCAST), "edit", "apply-bleed-mute", "--project", str(project), "--dry-run"], env=env, log=log)
        (OUT / f"{name}-gate.json").write_text(res.stdout)
    except SystemExit as exc:
        return f"{name} {exc}"
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return f"{name} {round(time.time() - started)} s"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "prep":
        for variant in VARIANTS:
            base(variant)
        return
    with ThreadPoolExecutor(int(sys.argv[2])) as pool:
        for line in pool.map(job, sys.argv[3:]):
            print(line, flush=True)


if __name__ == "__main__":
    main()
