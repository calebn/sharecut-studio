"""Lab before/after harness for #1443 (relative detection levels).

usage:
  lab1443.py prep VARIANT...            build base runs (scaled Zoom originals + seeded transcripts)
  lab1443.py run WORKERS JOB...         JOB = LABEL:VARIANT:WORDS, e.g. before:g0:aligned
  LABEL is a code tree under issue-1443/trees/<LABEL> (an exported src + .agents/defaults).
  VARIANT is g0, all-12, all-24, caleb-12, caleb-24, audra-24 ...: which tracks are scaled by how much.
  WORDS is whisper (the lab's frozen seed) or aligned (the #1324 forced-aligner words).

Each job clones its base run, re-flags and preps it (transcribe_tracks, merge, stems, reconcile,
precorrect), then records the words, propose-edits mute and ripple at medium, and the bleed
gate dry run, and deletes the clone. Outputs land in runs/2026-10-13-issue1443/out/.
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

LAB = Path.home() / "projects/ShareCut_Podcast_Test"
RUNS = LAB / "runs/2026-10-13-issue1443"
OUT = RUNS / "out"
STATE = Path(__file__).resolve().parent
TREES = STATE / "trees"
WT = Path("/Users/caleb.nelson/projects/podcast_mcp/.claude/worktrees/agent-a05a1cc5f14b3fe51")
PODCAST = WT / ".venv/bin/podcast"
ALIGNED_FROM = LAB / "runs/2026-10-13-issue1324/before-g0-aligned/episode.project.json"
TRACKS = ("caleb", "audra", "lana")
RESET = {
    "suspect_hallucination": False,
    "suppressed": False,
    "audibility_status": None,
    "dominant_track": None,
    "speaker_match_track": None,
    "speaker_match_score": None,
}


def gains(variant: str) -> dict[str, float]:
    if variant == "g0":
        return dict.fromkeys(TRACKS, 0.0)
    who, db = variant.rsplit("-", 1)
    return {t: -float(db) if who in ("all", t) else 0.0 for t in TRACKS}


def must(res):
    if res.returncode:
        raise SystemExit(f"failed: {res.args[3:6]} rc={res.returncode}")
    return res


def sh(cmd: list[str], *, env: dict | None = None, log: Path | None = None, cwd: Path | None = None):
    res = subprocess.run(
        ["nice", "-n", "10", *cmd], capture_output=True, text=True, env=env, cwd=cwd or LAB
    )
    if log is not None:
        with log.open("a") as fh:
            fh.write(f"$ {' '.join(cmd)}\n{res.stdout[-4000:]}\n{res.stderr[-4000:]}\nrc={res.returncode}\n")
    return res


def prep_exact(variant: str) -> None:
    """``x-<variant>``: the unscaled base with its 16-bit raws rewritten as float, scaled exactly,
    so the copy differs from the original by gain alone (no requantization)."""
    base = RUNS / f"base-{variant}"
    if (base / "seed-aligned.json").exists():
        return
    if base.exists():
        shutil.rmtree(base)
    subprocess.run(["cp", "-ac", str(RUNS / "base-g0"), str(base)], check=True)
    for track, db in gains(variant[2:]).items():
        raw = base / "raw" / f"{track}.wav"
        tmp = raw.with_suffix(".f32.wav")
        sh(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", f"volume={db}dB", "-c:a", "pcm_f32le", str(tmp)])
        tmp.replace(raw)
    print("prepped", variant, flush=True)


def prep(variant: str) -> None:
    if variant.startswith("x-"):
        return prep_exact(variant)
    base = RUNS / f"base-{variant}"
    if (base / "seed-aligned.json").exists():
        return
    audio = RUNS / f"audio-{variant}"
    audio.mkdir(parents=True, exist_ok=True)
    manifest = RUNS / "ingest-wav.yaml"
    manifest.write_text((LAB / "ingest.yaml").read_text().replace(".m4a", ".wav"))
    for src in sorted((LAB / "source/zoom_original").glob("*.m4a")):
        dst = audio / f"{src.stem}.wav"
        if not dst.exists():
            g = next((db for t, db in gains(variant).items() if t in src.stem.lower()), 0.0)
            sh(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", f"volume={g}dB", "-c:a", "pcm_f32le", str(dst)])
    if base.exists():
        shutil.rmtree(base)
    env = {**os.environ, "PYTHONPATH": str(TREES / "before/src")}
    log = RUNS / f"base-{variant}.log"
    project = base / "episode.project.json"
    must(sh([str(PODCAST), "episode", "init", "--dir", str(base), "--name", f"lab 1443 {variant}"], env=env, log=log))
    must(sh([str(PODCAST), "ingest", "consolidate", "--audio-dir", str(audio), "--manifest", str(manifest), "--project", str(project)], env=env, log=log))
    must(sh([str(PODCAST), "fixture", "seed-transcript", "--project", str(project), "--from", "source/asr/whisper_raw.json"], env=env, log=log))
    shutil.copy(project, base / "seed-whisper.json")
    seed = json.loads(project.read_text())
    aligned = {t["track_id"]: t for t in json.loads(ALIGNED_FROM.read_text())["transcripts"]["per_track"]}
    for t in seed["transcripts"]["per_track"]:
        words = json.loads(json.dumps(aligned[t["track_id"]]["words"]))
        for w in words:
            w.update(RESET)
        t["words"] = words
        for k in ("audio_sha256", "audio_size", "audio_mtime_ns", "silence_filter_fingerprint", "word_aligner", "alignment_score_method"):
            t[k] = None
    (base / "seed-aligned.json").write_text(json.dumps(seed))
    print("prepped", variant, flush=True)


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
    label, variant, words = spec.split(":")
    name = f"{label}-{variant}-{words}"
    done = OUT / f"{name}-gate.json"
    if done.exists():
        return f"{name} cached"
    started = time.time()
    env = {**os.environ, "PYTHONPATH": str(TREES / label / "src")}
    work = RUNS / f"work-{name}"
    if work.exists():
        shutil.rmtree(work)
    subprocess.run(["cp", "-ac", str(RUNS / f"base-{variant}"), str(work)], check=True)
    project = work / "episode.project.json"
    shutil.copy(work / f"seed-{words}.json", project)
    log = OUT / f"{name}.log"
    log.write_text("")
    for step in ("transcribe_tracks", "merge_transcript", "render_dialogue_stems", "reconcile_transcript", "precorrect_transcript"):
        res = sh([str(PODCAST), "pipeline", "run", "--project", str(project), "--only", step], env=env, log=log)
        if res.returncode:
            shutil.rmtree(work)
            return f"{name} FAILED at {step}"
    sh([str(PODCAST), "transcript", "refine-waive", "--project", str(project), "--reason", "lab 1443"], env=env, log=log)
    sh([str(PODCAST), "align", "waive", "--project", str(project), "--reason", "Zoom stems locked"], env=env, log=log)
    (OUT / f"{name}-words.json").write_text(json.dumps(words_record(project)))
    for mode in ("mute", "ripple"):
        res = sh([str(PODCAST), "propose-edits", "--project", str(project), "--edit-mode", mode, "--intensity", "medium", "--json"], env=env, log=log)
        (OUT / f"{name}-{mode}.json").write_text(res.stdout if res.returncode == 0 else "{}")
    res = sh([str(PODCAST), "edit", "apply-bleed-mute", "--project", str(project), "--dry-run"], env=env, log=log)
    done.write_text(res.stdout if res.returncode == 0 else "{}")
    shutil.rmtree(work)
    return f"{name} {round(time.time() - started)} s"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "prep":
        for variant in sys.argv[2:]:
            prep(variant)
        return
    workers = int(sys.argv[2])
    with ThreadPoolExecutor(workers) as pool:
        for line in pool.map(job, sys.argv[3:]):
            print(line, flush=True)


if __name__ == "__main__":
    main()
