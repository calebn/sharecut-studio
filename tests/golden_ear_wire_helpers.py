"""Shared runner and normalizer for the golden-ear wire-pin modules.

``run_case`` drives ``build_golden_ear`` (or the harness script's ``main``) against the
stubs from ``test_golden_ear_harness`` with per-case variations, then captures every
output: the returned dict or the raised error, the files written into the out dir
(key.json, manifest, answers template, diagnostics, tree) and the calls the stubs saw.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.edits.pending_preview import PendingPreviewWindow
from podcast_mcp.engines import audio_audit
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EditDecision, EditDecisionType
from podcast_mcp.services.document import EditService, TimelineService
from podcast_mcp.services.document.golden_ear import build_golden_ear
from podcast_mcp.services.document.play import PlayResult, PlayService
from podcast_mcp.util.process import CalledProcessError
from script_loader import SCRIPTS, load_script
from test_golden_ear_harness import FIXTURE, _patch_harness

MODULE = "podcast_mcp.services.document.golden_ear"
FIXTURE_ROOT = str(FIXTURE.resolve())


def dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def dec(
    edit_id: str,
    reason: str | None = "filler:um",
    *,
    track: str = "reference",
    start: float = 1.0,
    end: float = 1.2,
    applied: bool = False,
    dtype: str = "remove",
) -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id=track,
        type=EditDecisionType(dtype),
        start=start,
        end=end,
        reason=reason,
        review_required=False,
        applied=applied,
    )


def standard_decisions() -> list[EditDecision]:
    return [
        dec("f1", "filler:um", start=1.0, end=1.2),
        dec("p1", "pause:1.4s", track="guest", start=2.0, end=3.4),
        dec("f2", "filler:uh", start=4.0, end=4.3),
        dec("r1", "repetition:the the", track="guest", start=5.0, end=5.5),
        dec("s1", "restart:so I", start=6.0, end=6.6),
        dec("a1", "filler:um", start=7.0, end=7.2, applied=True),
        dec("m1", "filler:um", start=8.0, end=8.2, dtype="mute"),
        dec("o1", "other:x", start=9.0, end=9.2),
        dec("n1", None, start=10.0, end=10.2),
    ]


@dataclass
class Case:
    """One build scenario: decisions, kwargs for ``build_golden_ear`` and stub variations."""

    decisions: Callable[[], list[EditDecision]] = standard_decisions
    kwargs: dict[str, Any] = field(default_factory=dict)
    out_rel: str = "golden"
    copy_source: bool = False
    pre: Callable[[Path, Path, Path], None] | None = None
    unsuggestable: frozenset[str] = frozenset()
    join: dict[float, dict[str, Any] | Exception] = field(default_factory=dict)
    astats: str = "default"
    hum: str = "default"
    waveform: str = "default"
    context: str = "default"
    preview: str = "default"
    propose: str = "default"
    ffmpeg_available: bool = True
    real_diagnostics: bool = False
    twice: bool = False


_PYDANTIC_URL = re.compile(r"errors\.pydantic\.dev/\d+\.\d+/")


def _error(exc: BaseException) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "code": getattr(exc, "code", None),
        "message": _PYDANTIC_URL.sub("errors.pydantic.dev/<v>/", str(exc)),
    }


def _cpe() -> CalledProcessError:
    return CalledProcessError(1, ["ffmpeg", "-i", "x.wav"], output="o", stderr="boom")


def _raiser(kind: str) -> Exception:
    return {
        "oserror": OSError("disk gone"),
        "valueerror": ValueError("bad value"),
        "cpe": _cpe(),
        "runtime": RuntimeError("unexpected"),
        "keyerror": KeyError("missing"),
    }[kind]


def _wav_frames(path: Path) -> int | None:
    try:
        with wave.open(str(path), "rb") as handle:
            return handle.getnframes()
    except (OSError, EOFError, wave.Error):
        return None


def shorten(src: Path, dest: Path, seconds: float) -> Path:
    with wave.open(str(src), "rb") as inn, wave.open(str(dest), "wb") as out:
        params = inn.getparams()
        out.setparams(params)
        out.writeframes(inn.readframes(int(params.framerate * seconds)))
    return dest


def apply_stubs(
    monkeypatch: pytest.MonkeyPatch,
    case: Case,
    sample_wav: Path,
    scratch: Path,
    calls: list[Any],
) -> None:
    decisions = case.decisions()
    by_id = {edit.id: edit for edit in decisions}
    raw_astats = FFmpegEngine.__dict__["astats"]
    raw_waveform = FFmpegEngine.render_showwavespic
    raw_hum = audio_audit.detect_mains_hum
    short = shorten(sample_wav, scratch / "short.wav", 0.4)
    suggested = short if case.preview in {"suggested_short"} else None
    _patch_harness(monkeypatch, sample_wav, decisions, suggested_wav=suggested)
    base_propose = EditService.propose_tighten
    base_preview = PlayService.play_pending_preview
    base_context = PlayService.audition_context

    def propose(self, *args, **kwargs):
        calls.append(["propose_tighten", list(args), kwargs])
        if case.propose != "default":
            raise _raiser(case.propose)
        return base_propose(self, *args, **kwargs)

    def preview(self, edit_id, *, mode="suggested", pad_sec=0.5, **kwargs):
        calls.append(["play_pending_preview", edit_id, mode, pad_sec, kwargs])
        if case.preview == "raise" and mode == "suggested":
            raise _raiser("oserror")
        result = base_preview(self, edit_id, mode=mode, pad_sec=pad_sec, **kwargs)
        if case.preview == "current_short" and mode == "current":
            shorten(sample_wav, result.wav_path, 0.4)
        return PlayResult(
            wav_path=result.wav_path,
            player_cmd=None,
            source_label=f"pending:{mode}",
            start_sec=0.0,
            end_sec=pad_sec * 2,
            tier="pending",
        )

    def join_quality(self, **kwargs):
        caches = kwargs.get("audio_caches")
        calls.append(
            [
                "join_quality",
                kwargs["track_id"],
                kwargs["cut_start"],
                kwargs["cut_end"],
                kwargs["timebase"],
                None if caches is None else sorted(caches),
            ]
        )
        spec = case.join.get(kwargs["cut_start"], {"risk": 0.12})
        if isinstance(spec, Exception):
            raise spec
        import join_quality_fixtures

        return join_quality_fixtures.report(**spec)

    def audition_context(self, start, end, *, detail="summary", **kwargs):
        calls.append(["audition_context", start, end, detail, kwargs])
        if case.context != "default":
            raise _raiser(case.context)
        return base_context(self, start, end, detail=detail, **kwargs)

    def window(project, edit_id, *, pad_sec, **kwargs):
        calls.append(["resolve_pending_preview", edit_id, pad_sec])
        edit = by_id[edit_id]
        return PendingPreviewWindow(
            edit_id=edit_id,
            timeline_start=edit.start,
            timeline_end=edit.end,
            play_start=round(max(0.0, edit.start - pad_sec), 3),
            play_end=round(edit.end + pad_sec, 3),
            suggest_reason=(
                "This cut is not on the current timeline."
                if edit_id in case.unsuggestable
                else None
            ),
        )

    monkeypatch.setattr(EditService, "propose_tighten", propose)
    monkeypatch.setattr(PlayService, "play_pending_preview", preview)
    monkeypatch.setattr(TimelineService, "join_quality", join_quality)
    monkeypatch.setattr(PlayService, "audition_context", audition_context)
    monkeypatch.setattr(f"{MODULE}.resolve_pending_preview", window)
    if case.real_diagnostics:
        monkeypatch.setattr(FFmpegEngine, "astats", raw_astats)
        monkeypatch.setattr(f"{MODULE}.detect_mains_hum", raw_hum)
        monkeypatch.setattr(FFmpegEngine, "render_showwavespic", raw_waveform)
    else:
        _apply_diagnostic_stubs(monkeypatch, case, calls)
    if not case.ffmpeg_available:
        monkeypatch.setattr(FFmpegEngine, "check_available", lambda self: (False, "missing"))


def _apply_diagnostic_stubs(monkeypatch: pytest.MonkeyPatch, case: Case, calls: list[Any]) -> None:
    def astats(path):
        name = Path(path).name
        calls.append(["astats", Path(path).parent.name, name])
        mode = case.astats
        if mode == "none_metrics":
            return {"peak_level_db": None, "rms_level_db": None}
        if mode == "empty":
            return {}
        if mode == "partial":
            return {"peak_level_db": -1.5, "rms_level_db": None}
        if mode == "multi":
            return {"peak_level_db": -3.0, "rms_level_db": -20.25, "dc_offset": 0.0, "file": name}
        if mode.startswith("raise_"):
            if mode.endswith("_first") and name != "1.wav":
                return {"peak_level_db": -3.0, "file": name}
            raise _raiser(mode.removeprefix("raise_").removesuffix("_first"))
        return {"peak_level_db": -3.0, "file": name}

    def hum(path):
        calls.append(["detect_mains_hum", Path(path).parent.name, Path(path).name])
        if case.hum == "detected":
            return {"hum_detected": True, "hum_hz": 50.0, "harmonics": [50.0, 100.0]}
        if case.hum.startswith("raise_"):
            raise _raiser(case.hum.removeprefix("raise_"))
        return {"hum_detected": False}

    def waveform(_self, input_path, output_path, **kwargs):
        calls.append(["render_showwavespic", Path(input_path).parent.name, Path(output_path).name])
        if case.waveform.startswith("raise_"):
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"partial")
            raise _raiser(case.waveform.removeprefix("raise_"))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"png")
        return output_path

    monkeypatch.setattr(f"{MODULE}.FFmpegEngine.astats", astats)
    monkeypatch.setattr(f"{MODULE}.detect_mains_hum", hum)
    monkeypatch.setattr(FFmpegEngine, "render_showwavespic", waveform)


def tree(root: Path) -> list[str]:
    """Sorted relative entries under ``root``; the copied workspace collapses to one level."""
    rows: list[str] = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        parts = rel.split("/")
        if "workspace" in parts and len(parts) > parts.index("workspace") + 2:
            continue
        rows.append(rel + ("/" if path.is_dir() and not path.is_symlink() else ""))
    return rows


def _normalize_obj(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key == "mtime_ns" and isinstance(item, int):
                out[key] = "<mtime_ns>"
            elif key == "size" and isinstance(item, int) and "mtime_ns" in value:
                out[key] = "<size>"
            else:
                out[key] = _normalize_obj(item)
        return out
    if isinstance(value, list):
        return [_normalize_obj(item) for item in value]
    return value


def normalize(value: Any, roots: dict[str, str]) -> Any:
    """Replace workspace roots with tokens and drop fixture mtime/size."""
    text = json.dumps(_normalize_obj(value), sort_keys=False)
    for root, token in sorted(roots.items(), key=lambda item: -len(item[0])):
        text = text.replace(json.dumps(root)[1:-1], token)
    return json.loads(text)


def normalize_text(text: str, roots: dict[str, str]) -> str:
    for root, token in sorted(roots.items(), key=lambda item: -len(item[0])):
        text = text.replace(root, token)
    return text


def snapshot(root: Path, out: Path, roots: dict[str, str]) -> dict[str, Any]:
    snap: dict[str, Any] = {"tree": normalize(tree(root), roots)}
    key_path = out / "key.json"
    if key_path.is_file():
        text = key_path.read_text(encoding="utf-8")
        snap["key"] = normalize(json.loads(text), roots)
        snap["key_order"] = list(json.loads(text))
        snap["key_text_tail"] = repr(text[-3:])
        snap["key_mode"] = oct(key_path.stat().st_mode & 0o777)
    manifest = out / "listen" / "manifest.json"
    if manifest.is_file():
        snap["manifest"] = normalize(json.loads(manifest.read_text(encoding="utf-8")), roots)
        snap["manifest_mode"] = oct(manifest.stat().st_mode & 0o777)
        snap["manifest_order"] = list(json.loads(manifest.read_text(encoding="utf-8")))
    answers = out / "listen" / "answers.csv"
    if answers.is_file():
        snap["answers"] = answers.read_text(encoding="utf-8")
    pair_frames: dict[str, list[int | None]] = {}
    for pair in sorted((out / "listen").glob("pair_*")) if (out / "listen").is_dir() else []:
        pair_frames[pair.name] = [_wav_frames(pair / "1.wav"), _wav_frames(pair / "2.wav")]
    snap["pair_frames"] = pair_frames
    project = out / "workspace" / "episode.sharecut"
    if project.is_file():
        meta = json.loads(project.read_text(encoding="utf-8")).get("meta", {})
        snap["workspace_meta"] = normalize(
            {"workspace_dir": meta.get("workspace_dir"), "name": meta.get("name")}, roots
        )
        marker = out / "workspace" / ".golden_ear_source.json"
        snap["source_marker"] = normalize(json.loads(marker.read_text(encoding="utf-8")), roots)
    return snap


def run_case(case: Case, sample_wav: Path, root: Path, *, cli: list[str] | None = None) -> dict:
    """Run the surface once and return every normalized output."""
    root.mkdir(parents=True, exist_ok=True)
    scratch = root.parent / (root.name + "_scratch")
    scratch.mkdir(parents=True, exist_ok=True)
    out = root / case.out_rel
    src = FIXTURE
    if case.copy_source:
        src = root / "src"
        shutil.copytree(FIXTURE, src)
    roots = {
        str(root.resolve()): "<root>",
        str(root): "<root>",
        FIXTURE_ROOT: "<fixture>",
    }
    calls: list[Any] = []
    record: dict[str, Any] = {}
    with pytest.MonkeyPatch.context() as monkeypatch:
        apply_stubs(monkeypatch, case, sample_wav, scratch, calls)
        if case.pre is not None:
            case.pre(root, out, src)
        rounds = 2 if case.twice else 1
        for index in range(rounds):
            if cli is None:
                try:
                    record["result"] = normalize(build_golden_ear(src, out, **case.kwargs), roots)
                except Exception as exc:
                    record["raised"] = normalize(_error(exc), roots)
            else:
                record["cli"] = _run_main(cli_args(cli, src, out), roots)
            if index == 0 and case.twice:
                record["first"] = snapshot(root, out, roots)
                calls.append(["--second-run--"])
    record["calls"] = normalize(calls, roots)
    record["snapshot"] = snapshot(root, out, roots)
    if case.real_diagnostics:
        _shape_real_diagnostics(record["snapshot"])
    return record


def _shape_real_diagnostics(snap: dict[str, Any]) -> None:
    """Real ffmpeg metrics vary by build: keep each metric's name and type, not its value."""
    for row in snap.get("key", {}).get("pairs", []):
        for role in ("current", "suggested"):
            entry = row["pair_diagnostics"][role]
            for name in ("astats", "hum"):
                if name in entry:
                    entry[name] = {key: type(value).__name__ for key, value in entry[name].items()}


def cli_args(template: list[str], src: Path, out: Path) -> list[str]:
    return [
        str(src) if item == "{src}" else str(out) if item == "{out}" else item for item in template
    ]


def _run_main(argv: list[str], roots: dict[str, str]) -> dict[str, Any]:
    harness = load_script("golden_ear_harness")
    stdout, stderr = io.StringIO(), io.StringIO()
    outcome: dict[str, Any] = {}
    with (
        pytest.MonkeyPatch.context() as monkeypatch,
        contextlib.redirect_stdout(stdout),
        contextlib.redirect_stderr(stderr),
    ):
        monkeypatch.setattr(sys, "argv", ["golden_ear_harness.py"])
        try:
            outcome["exit"] = harness.main(argv)
        except SystemExit as exc:
            outcome["exit"] = exc.code
        except Exception as exc:
            outcome["raised"] = normalize(_error(exc), roots)
    outcome["stdout"] = normalize_text(stdout.getvalue(), roots)
    outcome["stderr"] = normalize_text(stderr.getvalue(), roots)
    return outcome


def run_script(args: list[str], cwd: Path, roots: dict[str, str]) -> dict[str, Any]:
    """Run scripts/golden_ear_harness.py in a subprocess; keep exit code and last stderr line."""
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "golden_ear_harness.py"), *args],
        cwd=cwd,
        env={**os.environ, "PYTHONPATH": str(SCRIPTS.parent / "src")},
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    stderr = normalize_text(proc.stderr, roots).strip().splitlines()
    usage = [line for line in stderr if not line.startswith(("  ", "Traceback"))]
    return {
        "exit": proc.returncode,
        "stdout": normalize_text(proc.stdout, roots),
        "stderr_last": usage[-1] if usage else "",
        "stderr_lines": len(stderr),
    }


def score_key(pairs: list[dict[str, Any]], **head: Any) -> dict[str, Any]:
    return {"pairs": pairs, **head}


def key_pair(
    pair_id: str,
    *,
    edit_file: str = "1.wav",
    klass: str | None = "filler",
    gated: bool | None = True,
    reason: str | None = "filler:um",
    track_id: str | None = "reference",
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": pair_id,
        "edit_file": edit_file,
        "leave_file": "2.wav" if edit_file == "1.wav" else "1.wav",
    }
    for name, value in (("class", klass), ("gated", gated), ("reason", reason)):
        if value is not None:
            row[name] = value
    if track_id is not None:
        row["track_id"] = track_id
    return row


def run_score(case: Any, root: Path, *, cli: bool) -> dict[str, Any]:
    """Lay out ``key.json`` and the answers file under ``root`` and score through the API or the CLI."""
    from podcast_mcp.services.document.golden_ear import score_golden_ear

    root.mkdir(parents=True, exist_ok=True)
    roots = {str(root.resolve()): "<root>", str(root): "<root>"}
    if case.raw_key == "<absent>":
        pass
    elif case.raw_key is not None:
        (root / "key.json").write_text(case.raw_key, encoding="utf-8")
    else:
        (root / "key.json").write_text(json.dumps(case.key), encoding="utf-8")
    arg = case.answers_arg
    target: Path | None = None
    if arg == "<abs>":
        target = root / "abs.csv"
        arg = str(target)
    elif arg == "~/h.csv":
        target = root / "h.csv"
    elif arg == "<default>" or case.place == "listen":
        target = root / "listen" / "answers.csv"
    elif arg == "adir":
        (root / "adir").mkdir()
    elif case.answers is not None or case.raw_answers is not None:
        target = root / arg
    if target is not None:
        target.parent.mkdir(parents=True, exist_ok=True)
        if case.raw_answers is not None:
            target.write_bytes(case.raw_answers)
        elif case.answers is not None:
            target.write_bytes(case.answers.encode("utf-8"))
    before = tree(root)
    record: dict[str, Any] = {}
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setenv("HOME", str(root))
        if cli:
            argv = ["score", "--dir", str(root)]
            if arg != "<default>":
                argv += ["--answers", arg]
            record = _run_main(argv, roots)
        else:
            answers = Path("listen") / "answers.csv" if arg == "<default>" else Path(arg)
            try:
                record["report"] = normalize(score_golden_ear(root, answers), roots)
            except Exception as exc:
                record["raised"] = normalize(_error(exc), roots)
    record["tree_unchanged"] = tree(root) == before
    return record


def _pair_brief(row: dict[str, Any]) -> dict[str, Any]:
    keep = ("id", "edit_id", "class", "reason", "track_id", "gated", "leave_file", "edit_file")
    brief = {name: row[name] for name in keep}
    brief["start"], brief["end"] = row["start"], row["end"]
    brief["play"] = [row["play_start"], row["play_end"]]
    brief["verdict"] = row["join_quality"].get("verdict")
    brief["join_error"] = row["join_quality"].get("error")
    brief["context_error"] = row.get("audition_context_error")
    brief["diagnostic_errors"] = {
        role: row["pair_diagnostics"][role].get("error") for role in ("current", "suggested")
    }
    return brief


def views_of(record: dict[str, Any], *, full: bool = False) -> dict[str, Any]:
    """Split a ``run_case`` record into the separately pinned views."""
    snap = record["snapshot"]
    views: dict[str, Any] = {
        "calls": record["calls"],
        "tree": {
            "tree": snap["tree"],
            "pair_frames": snap["pair_frames"],
            "present": sorted(snap),
        },
    }
    if "cli" in record:
        views["cli"] = record["cli"]
    else:
        views["outcome"] = record["result"] if "result" in record else {"raised": record["raised"]}
    if "key" in snap:
        head = {name: value for name, value in snap["key"].items() if name != "pairs"}
        views["key_head"] = {
            "head": head,
            "order": snap["key_order"],
            "mode": snap["key_mode"],
            "tail": snap["key_text_tail"],
        }
        if "pairs" in snap["key"]:
            views["pairs"] = [_pair_brief(row) for row in snap["key"]["pairs"]]
        if full:
            views["key_full"] = snap["key"]
    if "manifest" in snap:
        views["manifest"] = {
            "manifest": snap["manifest"],
            "order": snap["manifest_order"],
            "mode": snap["manifest_mode"],
        }
    if "answers" in snap:
        views["answers"] = snap["answers"]
    if "workspace_meta" in snap:
        views["workspace"] = {"meta": snap["workspace_meta"], "marker": snap["source_marker"]}
    if "first" in record:
        first = record["first"]
        views["first_run"] = {
            "tree": first["tree"],
            "pairs": [_pair_brief(row) for row in first["key"]["pairs"]],
        }
    return views


def nondet_view(record: dict[str, Any]) -> dict[str, Any]:
    """Views of an unseeded build: pairs sorted by edit id with the random file assignment removed."""
    views = views_of(record)
    views.pop("calls")
    pairs = sorted(views["pairs"], key=lambda row: row["edit_id"])
    for row in pairs:
        for name in ("id", "leave_file", "edit_file"):
            row.pop(name)
    views["pairs"] = pairs
    return views
