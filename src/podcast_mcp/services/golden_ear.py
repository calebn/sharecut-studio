"""Blind A/B golden-ear harness for tighten leave-in vs edit listening.

Orchestrates ``EditService.propose_tighten`` and ``PlayService.play_pending_preview``
on a relocated project copy. Pair mapping lives in owner-only ``key.json``;
listener files live under ``listen/`` (``manifest.json`` is blinded).
"""

from __future__ import annotations

import csv
import os
import random
import shutil
import wave
from pathlib import Path
from typing import Any

from podcast_mcp.edits.audio_cache import TrackAudioCache, build_track_audio_caches
from podcast_mcp.edits.pending_preview import resolve_pending_preview
from podcast_mcp.engines.audio_audit import detect_mains_hum, measure_astats
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EditDecision, EditDecisionType
from podcast_mcp.models.episode import EPISODE_PROJECT_FILENAME
from podcast_mcp.project_io import (
    copy_relocated_workspace,
    require_episode_project_file,
    rewrite_workspace_dir,
)
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.play import PlayService
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.process import CalledProcessError
from podcast_mcp.util.progress import progress_task

DEFAULT_LIMIT = 40
MAX_LIMIT = 500
DEFAULT_PAD_SEC = 2.0
ALLOWED_CLASSES = ("filler", "pause")
PREFER_EDIT_GATED_MIN = 0.90
GATED_N_FLOOR = 2
ANSWERS_FIELDS = ("pair_id", "prefer", "leftover_consonant", "notes")
LISTEN_DIRNAME = "listen"
SOURCE_FP_NAME = ".golden_ear_source.json"
JOIN_ERRORS = (OSError, ValueError, CalledProcessError)
_PREFER_TIE = frozenset({"tie", "same", "either"})
_LEFTOVER_YES = frozenset({"yes", "y", "true", "1"})
_LEFTOVER_NO = frozenset({"no", "n", "false", "0"})


def resolve_project_file(project: Path) -> Path:
    return require_episode_project_file(project)


def parse_classes(raw: str | tuple[str, ...] | list[str] | None) -> tuple[str, ...]:
    if raw is None:
        return ALLOWED_CLASSES
    if isinstance(raw, str):
        parts = tuple(p.strip().lower() for p in raw.split(",") if p.strip())
    else:
        parts = tuple(str(p).strip().lower() for p in raw if str(p).strip())
    if not parts:
        raise ValueError("classes must include at least one of filler, pause")
    unknown = [p for p in parts if p not in ALLOWED_CLASSES]
    if unknown:
        raise ValueError(f"unsupported classes {unknown!r}; use filler,pause")
    return parts


def bound_limit(limit: int) -> int:
    value = int(limit)
    if value < 1 or value > MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_LIMIT}")
    return value


def min_gated_n_for(limit: int) -> int:
    return 1 if int(limit) < GATED_N_FLOOR else GATED_N_FLOOR


def source_fingerprint(src_file: Path) -> dict[str, Any]:
    path = src_file.resolve()
    st = path.stat()
    return {"path": str(path), "mtime_ns": st.st_mtime_ns, "size": st.st_size}


def _copy_premix(src_ws: Path, dest_ws: Path) -> None:
    premix = src_ws / "artifacts" / "premix.wav"
    if not premix.is_file():
        return
    dest_dir = dest_ws / "artifacts"
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(premix, dest_dir / "premix.wav")


def copy_relocated_project(src_project: Path, dest_workspace: Path) -> Path:
    """Copy an episode tree with partial-dir publish, fingerprint, and samefile guard."""
    src_file = require_episode_project_file(src_project)
    src_ws = src_file.parent.resolve()
    dest_ws = dest_workspace.expanduser().resolve()
    dest_file = dest_ws / EPISODE_PROJECT_FILENAME
    if dest_ws.exists() and dest_ws.samefile(src_ws):
        raise ValueError("output workspace must not be the source project")
    if dest_file.is_file() and dest_file.samefile(src_file):
        raise ValueError("output workspace must not be the source project")
    if dest_ws == src_ws or src_ws in dest_ws.parents:
        raise ValueError("output workspace must not be inside the source project")
    fp = source_fingerprint(src_file)
    marker = dest_ws / SOURCE_FP_NAME
    if dest_file.is_file():
        stored = load_json_object(marker) or {}
        if stored == fp:
            return dest_file
        raise FileExistsError(f"workspace exists with a different source fingerprint: {dest_ws}")
    if dest_ws.exists():
        raise FileExistsError(f"workspace exists without project file: {dest_ws}")
    partial = dest_ws.with_name(dest_ws.name + ".partial")
    if partial.exists():
        shutil.rmtree(partial)
    copy_relocated_workspace(src_file, partial)
    _copy_premix(src_ws, partial)
    write_json_atomic(partial / SOURCE_FP_NAME, fp)
    os.replace(partial, dest_ws)
    return rewrite_workspace_dir(dest_file)


def _reason_class(reason: str | None, classes: tuple[str, ...]) -> str | None:
    text = reason or ""
    for name in classes:
        if text.startswith(f"{name}:"):
            return name
    return None


def _gated(join_quality: dict[str, Any]) -> bool:
    return str(join_quality.get("verdict") or "") == "pass"


def _candidate_decisions(
    decisions: list[EditDecision],
    classes: tuple[str, ...],
) -> list[EditDecision]:
    out: list[EditDecision] = []
    for edit in decisions:
        if edit.applied:
            continue
        if edit.type != EditDecisionType.REMOVE:
            continue
        if _reason_class(edit.reason, classes) is None:
            continue
        out.append(edit)
    return out


def _pair_id(index: int) -> str:
    return f"pair_{index:03d}"


def _write_answers_template(path: Path, pair_ids: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(ANSWERS_FIELDS))
        writer.writeheader()
        for pair_id in pair_ids:
            writer.writerow(
                {
                    "pair_id": pair_id,
                    "prefer": "",
                    "leftover_consonant": "",
                    "notes": "",
                }
            )


def _wav_duration_sec(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            if rate <= 0:
                return None
            return handle.getnframes() / float(rate)
    except (OSError, wave.Error):
        return None


def _pad_edit_to_leave(leave_wav: Path, edit_wav: Path) -> bool:
    """Pad Suggested to Current duration. Return False if padding is required but fails."""
    leave_dur = _wav_duration_sec(leave_wav)
    edit_dur = _wav_duration_sec(edit_wav)
    if leave_dur is None or edit_dur is None:
        return True
    if edit_dur + 0.02 >= leave_dur:
        return True
    engine = FFmpegEngine()
    ok, _ = engine.check_available()
    if not ok:
        return False
    padded = edit_wav.with_suffix(".pad.wav")
    try:
        engine.pad_end_silence(edit_wav, padded, leave_dur)
        os.replace(padded, edit_wav)
    except JOIN_ERRORS:
        padded.unlink(missing_ok=True)
        return False
    return True


def _publish_pair_dir(staging_dir: Path, dest_dir: Path) -> None:
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    os.replace(staging_dir, dest_dir)


def _render_pair_wavs(
    play: PlayService,
    edit: EditDecision,
    pair_dir: Path,
    *,
    pad_sec: float,
    rng: random.Random,
) -> dict[str, Any] | None:
    window = resolve_pending_preview(play.project, edit.id, pad_sec=pad_sec)
    if not window.can_skip:
        return None
    leave = play.play_pending_preview(
        edit.id,
        mode="current",
        pad_sec=pad_sec,
        dry_run=True,
        rerender=False,
    )
    edited = play.play_pending_preview(
        edit.id,
        mode="suggested",
        pad_sec=pad_sec,
        dry_run=True,
        rerender=False,
    )
    staging = pair_dir.with_name(pair_dir.name + ".partial")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)
    edit_is_two = bool(rng.randrange(2))
    leave_name = "2.wav" if not edit_is_two else "1.wav"
    edit_name = "2.wav" if edit_is_two else "1.wav"
    shutil.copy2(leave.wav_path, staging / leave_name)
    shutil.copy2(edited.wav_path, staging / edit_name)
    if not _pad_edit_to_leave(staging / leave_name, staging / edit_name):
        shutil.rmtree(staging, ignore_errors=True)
        return None
    _publish_pair_dir(staging, pair_dir)
    return {
        "leave_file": leave_name,
        "edit_file": edit_name,
        "play_start": window.play_start,
        "play_end": window.play_end,
    }


def _pair_audition_context(
    play: PlayService, wavs: dict[str, Any]
) -> tuple[dict[str, Any] | None, str | None]:
    """Build owner-only diagnostics, recording failures without unblinding listeners."""
    try:
        return (
            play.audition_context(
                float(wavs["play_start"]),
                float(wavs["play_end"]),
                detail="summary",
                include_dsp=False,
            ),
            None,
        )
    except JOIN_ERRORS as exc:
        return None, f"{type(exc).__name__}: {exc}"


def _pair_audio_diagnostics(
    pair_dir: Path, wavs: dict[str, Any], diagnostics_dir: Path, pair_id: str
) -> dict[str, Any]:
    """Analyze only the two rendered WAVs; keep images outside the listen pack."""
    engine = FFmpegEngine()
    result: dict[str, Any] = {"source": "rendered_pair_wavs"}
    for role, file_key in (("current", "leave_file"), ("suggested", "edit_file")):
        filename = str(wavs[file_key])
        audio_path = pair_dir / filename
        image_relative = Path("diagnostics") / pair_id / f"{role}.png"
        image_path = diagnostics_dir / f"{role}.png"
        entry: dict[str, Any] = {"file": filename}
        try:
            entry["astats"] = measure_astats(audio_path)
            entry["hum"] = detect_mains_hum(audio_path)
            engine.render_showwavespic(audio_path, image_path)
            entry["waveform_png"] = str(image_relative)
        except JOIN_ERRORS as exc:
            image_path.unlink(missing_ok=True)
            entry["error"] = f"{type(exc).__name__}: {exc}"
        result[role] = entry
    return result


def _join_metrics(
    edit_svc: EditService,
    edit: EditDecision,
    audio_caches: dict[str, TrackAudioCache] | None,
) -> dict[str, Any]:
    try:
        return edit_svc.join_quality(
            track_id=edit.track_id,
            cut_start=edit.start,
            cut_end=edit.end,
            timebase="source",
            audio_caches=audio_caches,
        )
    except JOIN_ERRORS as exc:
        return {"verdict": "error", "error": f"{type(exc).__name__}: {exc}"}


def _out_has_content(out: Path) -> bool:
    if not out.exists():
        return False
    try:
        next(out.iterdir())
    except StopIteration:
        return False
    return True


def answers_have_preferences(path: Path) -> bool:
    if not path.is_file():
        return False
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if (row.get("prefer") or "").strip():
                return True
    return False


def _reuse_workspace(src_file: Path, prev_ws: Path, dest_ws: Path) -> Path | None:
    dest_file = dest_ws / EPISODE_PROJECT_FILENAME
    prev_file = prev_ws / EPISODE_PROJECT_FILENAME
    if not prev_file.is_file():
        return None
    src_ws = src_file.parent.resolve()
    if prev_ws.exists() and prev_ws.samefile(src_ws):
        return None
    if prev_file.samefile(src_file):
        return None
    stored = load_json_object(prev_ws / SOURCE_FP_NAME) or {}
    if stored != source_fingerprint(src_file):
        return None
    if dest_ws.exists():
        shutil.rmtree(dest_ws)
    shutil.copytree(prev_ws, dest_ws)
    return rewrite_workspace_dir(dest_file)


def _prepare_workspace(src_file: Path, out: Path, staging: Path) -> Path:
    dest_ws = staging / "workspace"
    reused = _reuse_workspace(src_file, out / "workspace", dest_ws)
    if reused is not None:
        return reused
    return copy_relocated_project(src_file, dest_ws)


def build_golden_ear(
    project: Path,
    out_dir: Path,
    *,
    limit: int = DEFAULT_LIMIT,
    classes: str | tuple[str, ...] | None = None,
    seed: int | None = None,
    pad_sec: float = DEFAULT_PAD_SEC,
    force: bool = False,
) -> dict[str, Any]:
    """Propose (no apply) on a relocated copy and write blinded A/B pairs."""
    src_file = require_episode_project_file(project)
    out = Path(out_dir).expanduser().resolve()
    class_names = parse_classes(classes)
    cap = bound_limit(limit)
    pad = max(0.05, min(10.0, float(pad_sec)))
    for answers in (out / LISTEN_DIRNAME / "answers.csv", out / "answers.csv"):
        if answers_have_preferences(answers) and not force:
            raise FileExistsError(
                f"filled answers.csv present; pass force=True to rebuild: {answers}"
            )
    if _out_has_content(out) and not force:
        raise FileExistsError(f"non-empty --out; pass force=True to rebuild: {out}")
    if force:
        (out / "key.json").unlink(missing_ok=True)
    staging = out.parent / f".{out.name}.staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)
    dest_file = _prepare_workspace(src_file, out, staging)
    ws = ProjectWorkspace.open(dest_file)
    edit_svc = EditService(ws)
    play = PlayService(ws)
    edit_svc.propose_tighten()
    candidates = _candidate_decisions(list(ws.project.edit_decisions), class_names)
    rng = random.Random(seed)
    rng.shuffle(candidates)
    listen_root = staging / LISTEN_DIRNAME
    listen_root.mkdir(parents=True, exist_ok=True)
    track_ids = {edit.track_id for edit in candidates}
    audio_caches = build_track_audio_caches(ws.project, track_ids) if track_ids else {}
    pairs: list[dict[str, Any]] = []
    skipped = 0
    with progress_task("golden-ear-build", "Golden-ear pairs", total=cap) as task:
        task.set_phase("render", "Render leave-in and edited windows")
        for edit in candidates:
            if len(pairs) >= cap:
                break
            pair_id = _pair_id(len(pairs))
            pair_dir = listen_root / pair_id
            wavs = _render_pair_wavs(play, edit, pair_dir, pad_sec=pad, rng=rng)
            if wavs is None:
                skipped += 1
                continue
            join_quality = _join_metrics(edit_svc, edit, audio_caches)
            reason_class = _reason_class(edit.reason, class_names) or "filler"
            audition_context, audition_context_error = _pair_audition_context(play, wavs)
            pair_diagnostics = _pair_audio_diagnostics(
                pair_dir, wavs, staging / "diagnostics" / pair_id, pair_id
            )
            pairs.append(
                {
                    "id": pair_id,
                    "edit_id": edit.id,
                    "reason": edit.reason,
                    "class": reason_class,
                    "track_id": edit.track_id,
                    "start": edit.start,
                    "end": edit.end,
                    "gated": _gated(join_quality),
                    "join_quality": join_quality,
                    "audition_context": audition_context,
                    "audition_context_source": "project_timeline_metadata_only",
                    "pair_diagnostics": pair_diagnostics,
                    **(
                        {"audition_context_error": audition_context_error}
                        if audition_context_error is not None
                        else {}
                    ),
                    **wavs,
                }
            )
            task.advance(1, message=pair_id)
    key = {
        "source_project": str(src_file),
        "source_fingerprint": source_fingerprint(src_file),
        "workspace": str(out / "workspace"),
        "listen_dir": str(out / LISTEN_DIRNAME),
        "pad_sec": pad,
        "classes": list(class_names),
        "limit": cap,
        "seed": seed,
        "skipped_unsuggestable": skipped,
        "pair_count": len(pairs),
        "min_gated_n": min_gated_n_for(cap),
        "pairs": pairs,
    }
    manifest = {
        "pad_sec": pad,
        "classes": list(class_names),
        "pair_count": len(pairs),
        "pairs": [{"id": row["id"]} for row in pairs],
        "owner_only": False,
        "instructions": "Listen to 1.wav vs 2.wav. Fill prefer=1|2|tie and leftover_consonant=yes|no.",
    }
    write_json_atomic(staging / "key.json", key)
    write_json_atomic(listen_root / "manifest.json", manifest)
    _write_answers_template(listen_root / "answers.csv", [row["id"] for row in pairs])
    old: Path | None = None
    if out.exists():
        old = out.parent / f".{out.name}.old"
        if old.exists():
            shutil.rmtree(old)
        os.replace(out, old)
    os.replace(staging, out)
    if old is not None:
        shutil.rmtree(old, ignore_errors=True)
    rewrite_workspace_dir(out / "workspace" / EPISODE_PROJECT_FILENAME)
    return {
        "out_dir": str(out),
        "listen_dir": str(out / LISTEN_DIRNAME),
        "pair_count": len(pairs),
        "skipped_unsuggestable": skipped,
        "workspace": str(out / "workspace"),
    }


def _normalize_prefer(raw: str, meta: dict[str, Any]) -> str | None:
    text = raw.strip().lower().replace("_", "-").replace(" ", "")
    if not text:
        return None
    if text in _PREFER_TIE:
        return "tie"
    if text in {"1", "2"}:
        filename = f"{text}.wav"
        if filename == str(meta.get("edit_file") or ""):
            return "edit"
        if filename == str(meta.get("leave_file") or ""):
            return "leave-in"
        return None
    return None


def _normalize_leftover(raw: str) -> bool | None:
    text = raw.strip().lower()
    if text in _LEFTOVER_YES:
        return True
    if text in _LEFTOVER_NO:
        return False
    return None


def _read_answers(answers_path: Path) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    with answers_path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            pair_id = (row.get("pair_id") or "").strip()
            if not pair_id or pair_id in rows:
                continue
            rows[pair_id] = row
    return rows


def score_golden_ear(out_dir: Path, answers: Path) -> dict[str, Any]:
    """Score a filled answers CSV against ``key.json`` in ``out_dir``."""
    root = Path(out_dir).expanduser().resolve()
    key_path = root / "key.json"
    key = load_json_object(key_path)
    if key is None:
        raise FileNotFoundError(f"missing key.json in {root}")
    pair_list = list(key.get("pairs") or [])
    pairs = {str(row["id"]): row for row in pair_list}
    pair_count = int(key.get("pair_count") or len(pair_list))
    limit = int(key.get("limit") or DEFAULT_LIMIT)
    min_gated_n = int(key.get("min_gated_n") or min_gated_n_for(limit))
    answers_path = Path(answers).expanduser()
    if not answers_path.is_absolute():
        answers_path = root / answers_path
    if not answers_path.is_file():
        listen_fallback = root / LISTEN_DIRNAME / "answers.csv"
        if listen_fallback.is_file() and answers_path.name == "answers.csv":
            answers_path = listen_fallback
        else:
            raise FileNotFoundError(f"answers file not found: {answers_path}")

    answer_rows = _read_answers(answers_path)
    scored: list[dict[str, Any]] = []
    missing_n = 0
    leftover_fails = 0
    incomplete = False
    for pair_id, meta in pairs.items():
        row = answer_rows.get(pair_id) or {}
        prefer = _normalize_prefer(row.get("prefer") or "", meta)
        leftover = _normalize_leftover(row.get("leftover_consonant") or "")
        missing = prefer is None
        answered = prefer is not None and leftover is not None
        if missing:
            missing_n += 1
            incomplete = True
            prefer = "leave-in"
        if leftover is None:
            leftover = True
            leftover_fails += 1
            incomplete = True
        elif leftover:
            leftover_fails += 1
        scored.append(
            {
                "id": pair_id,
                "prefer": prefer,
                "missing": missing,
                "answered": answered,
                "leftover_consonant": leftover,
                "class": meta.get("class") or "filler",
                "reason": meta.get("reason") or "",
                "track_id": meta.get("track_id") or "",
                "gated": bool(meta.get("gated")),
                "notes": row.get("notes") or "",
            }
        )

    def _rate(rows: list[dict[str, Any]]) -> float | None:
        if not rows:
            return None
        return sum(1 for r in rows if r["prefer"] == "edit") / len(rows)

    def _acceptance_rollup(rows: list[dict[str, Any]]) -> dict[str, Any]:
        answered = [row for row in rows if row["answered"]]
        return {
            "n": len(rows),
            "answered_n": len(answered),
            "missing_n": len(rows) - len(answered),
            "prefer_edit": _rate(rows),
            "prefer_edit_answered": _rate(answered),
            "ties": sum(1 for row in rows if row["prefer"] == "tie"),
            "leftover_consonant_fails": sum(1 for row in rows if row["leftover_consonant"]),
        }

    gated_rows = [r for r in scored if r["gated"]]
    per_class: dict[str, Any] = {}
    for name in ALLOWED_CLASSES:
        class_rows = [r for r in scored if r["class"] == name]
        per_class[name] = {
            **_acceptance_rollup(class_rows),
        }
    per_reason = {
        reason: _acceptance_rollup([row for row in scored if row["reason"] == reason])
        for reason in sorted({row["reason"] for row in scored})
    }
    per_track = {
        track_id: _acceptance_rollup([row for row in scored if row["track_id"] == track_id])
        for track_id in sorted({row["track_id"] for row in scored})
    }
    prefer_edit_gated = _rate(gated_rows)
    prefer_edit_all = _rate(scored)
    gated_n = len(gated_rows)
    gated_in_key = sum(1 for row in pair_list if row.get("gated"))
    gated_bar = (
        prefer_edit_gated is not None
        and prefer_edit_gated >= PREFER_EDIT_GATED_MIN
        and gated_n >= min_gated_n
        and gated_in_key >= min_gated_n
    )
    leftover_bar = leftover_fails == 0
    complete_bar = missing_n == 0 and not incomplete
    passed = gated_bar and leftover_bar and complete_bar
    fail_reasons: list[str] = []
    if not gated_bar:
        if prefer_edit_gated is None:
            fail_reasons.append("no gated answers")
        elif gated_n < min_gated_n or gated_in_key < min_gated_n:
            fail_reasons.append(
                f"gated_n={gated_n} gated_in_key={gated_in_key} below min_gated_n={min_gated_n}"
            )
        else:
            fail_reasons.append("gated prefer-edit below 90%")
    if not leftover_bar:
        fail_reasons.append(f"{leftover_fails} leftover-consonant fail(s)")
    if missing_n:
        fail_reasons.append(f"missing_n={missing_n} pair_count={pair_count}")
    elif incomplete:
        fail_reasons.append("incomplete leftover_consonant answers")
    if not passed:
        fail_reasons.append(
            f"pair_count={pair_count} gated_n={gated_n} n_answers={len(scored) - missing_n}"
        )
    report = {
        "n_answers": len(scored) - missing_n,
        "gated_n": gated_n,
        "all_n": len(scored),
        "pair_count": pair_count,
        "missing_n": missing_n,
        "min_gated_n": min_gated_n,
        "prefer_edit_all": prefer_edit_all,
        "prefer_edit_gated": prefer_edit_gated,
        "per_class": per_class,
        "per_reason": per_reason,
        "per_track": per_track,
        "leftover_consonant_fails": leftover_fails,
        "bar": (
            f"prefer-edit on gated cuts >= {PREFER_EDIT_GATED_MIN:.0%} "
            f"with gated_n >= {min_gated_n} and zero leftover-consonant fails"
        ),
        "pass": passed,
        "fail_reasons": fail_reasons,
    }
    return report
