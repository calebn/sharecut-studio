#!/usr/bin/env python3
"""Record FFmpeg resolution and run the media acceptance suites without coverage."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.util.binaries import FFmpegPair, resolve_ffmpeg_pair

ACCEPTANCE_TESTS = (
    "tests/test_binaries.py",
    "tests/test_ffmpeg_engine.py",
    "tests/test_timeline_render.py",
    "tests/test_export_audio.py",
    "tests/test_join_continuity.py",
    "tests/test_review_versions.py",
    "tests/test_track_mix.py",
    "tests/test_waveform_pyramid.py",
    "tests/test_bleed_gate_channels.py",
)
_VERSION_RE = re.compile(r"^(?:ffmpeg|ffprobe) version ([^\s]+)", re.IGNORECASE)


def _command_evidence(command: str) -> dict[str, str]:
    located = shutil.which(command)
    if located is None:
        raise RuntimeError(f"cannot locate executable command {command!r}")
    resolved = Path(located).expanduser().resolve(strict=True)
    completed = subprocess.run(
        [command, "-version"], capture_output=True, text=True, check=True, timeout=15
    )
    line = (completed.stdout or "").splitlines()[0] if completed.stdout else ""
    match = _VERSION_RE.match(line)
    return {
        "command": command,
        "resolved_path": str(Path(located).absolute()),
        "canonical_target": str(resolved),
        "version": match.group(1) if match else "unknown",
        "version_line": line,
    }


def inspect_pair(
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    *,
    expected_version: str | None = None,
) -> dict[str, Any]:
    pair: FFmpegPair = resolve_ffmpeg_pair(ffmpeg, ffprobe)
    evidence = {
        "ffmpeg": _command_evidence(pair.ffmpeg),
        "ffprobe": _command_evidence(pair.ffprobe),
    }
    if expected_version is not None:
        for name, item in evidence.items():
            if item["version"] == "unknown":
                raise ValueError(f"{name} release is unknown; expected {expected_version}")
            if item["version"] != expected_version:
                raise ValueError(
                    f"{name} release {item['version']} does not match expected {expected_version}"
                )
    return evidence


def test_counts(junit_path: Path) -> dict[str, int]:
    root = ET.parse(junit_path).getroot()
    return {
        "tests": sum(1 for _ in root.iter("testcase")),
        "skipped": sum(1 for _ in root.iter("skipped")),
        "failures": sum(1 for _ in root.iter("failure")),
        "errors": sum(1 for _ in root.iter("error")),
    }


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir", required=True, type=Path, help="Caller-owned evidence directory"
    )
    parser.add_argument("--expected-version", help="Require this exact FFmpeg and FFprobe release")
    parser.add_argument("--ffmpeg", help="Optional explicit FFmpeg command override")
    parser.add_argument("--ffprobe", help="Optional explicit FFprobe command override")
    args = parser.parse_args(argv)
    output = args.out_dir.absolute()
    output.mkdir(parents=True, exist_ok=True)
    junit_path = output / "media-acceptance.junit.xml"
    junit_path.unlink(missing_ok=True)
    report_path = output / "ffmpeg-baseline.json"
    report: dict[str, Any] = {
        "expected_version": args.expected_version,
        "acceptance_tests": list(ACCEPTANCE_TESTS),
    }
    try:
        report["pair"] = inspect_pair(
            args.ffmpeg, args.ffprobe, expected_version=args.expected_version
        )
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        report.update({"ok": False, "preflight_error": str(exc)})
        _write_json(report_path, report)
        print(f"FFmpeg preflight failed: {exc}", file=sys.stderr)
        return 2

    command = [
        sys.executable,
        "-m",
        "pytest",
        "-q",
        "--no-cov",
        f"--junitxml={junit_path}",
        *ACCEPTANCE_TESTS,
    ]
    child_env = os.environ.copy()
    child_env.pop("PYTEST_ADDOPTS", None)
    child_env.update(
        PODCAST_MCP_FFMPEG=report["pair"]["ffmpeg"]["resolved_path"],
        PODCAST_MCP_FFPROBE=report["pair"]["ffprobe"]["resolved_path"],
    )
    completed = subprocess.run(
        command,
        check=False,
        env=child_env,
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )
    pytest_output = f"{completed.stdout or ''}\n{completed.stderr or ''}"
    (output / "pytest.log").write_text(pytest_output, encoding="utf-8")
    print(pytest_output, end="")
    deselections = re.findall(r"\b(\d+) deselected\b", pytest_output)
    deselected = sum(map(int, deselections))
    try:
        counts = test_counts(junit_path)
        junit_error = None
    except (OSError, ET.ParseError) as exc:
        counts, junit_error = None, str(exc)
    ok = (
        completed.returncode == 0
        and counts is not None
        and counts["tests"] > 0
        and deselected == 0
        and not any(counts[name] for name in ("skipped", "failures", "errors"))
    )
    report.update(
        {
            "pytest_command": command,
            "pytest_exit_code": completed.returncode,
            "deselected": deselected,
            "test_counts": counts,
            "tested_pair": {
                name: child_env[f"PODCAST_MCP_{name.upper()}"] for name in ("ffmpeg", "ffprobe")
            },
            "junit_error": junit_error,
            "ok": ok,
        }
    )
    _write_json(report_path, report)
    if completed.returncode:
        return completed.returncode
    if not ok:
        print(f"Acceptance evidence failed: {counts or junit_error}", file=sys.stderr)
        return 1
    print(f"Acceptance passed without skips. Evidence: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
