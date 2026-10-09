from __future__ import annotations

import json
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.util.binaries import FFmpegPair, FFmpegPairResolutionError
from script_loader import load_script


@pytest.fixture
def runner():
    return load_script("verify_ffmpeg_baseline", register=True)


def test_preflight_records_both_commands_and_rejects_wrong_expected_release(
    runner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffprobe = tmp_path / "ffprobe.exe"
    ffmpeg.write_text("binary", encoding="utf-8")
    ffprobe.write_text("binary", encoding="utf-8")
    ffmpeg.chmod(0o755)
    ffprobe.chmod(0o755)
    monkeypatch.setattr(
        runner,
        "resolve_ffmpeg_pair",
        lambda *_args: FFmpegPair(str(ffmpeg), str(ffprobe), (9, 0, 2), "explicit"),
    )

    def version(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        label = "ffmpeg" if command[0] == str(ffmpeg) else "ffprobe"
        line = f"{label} version 9.0.2"
        return subprocess.CompletedProcess(command, 0, line + "\n", "")

    with patch.object(runner.subprocess, "run", side_effect=version):
        evidence = runner.inspect_pair(expected_version="9.0.2")
        with pytest.raises(ValueError, match=r"does not match expected 9\.0\.3"):
            runner.inspect_pair(expected_version="9.0.3")

    assert evidence["ffmpeg"]["version"] == "9.0.2"
    assert evidence["ffprobe"]["canonical_target"] == str(ffprobe.resolve())


def test_preflight_rejects_uninspectable_release_when_guarded(runner, monkeypatch) -> None:
    monkeypatch.setattr(
        runner,
        "resolve_ffmpeg_pair",
        lambda *_args: FFmpegPair("ffmpeg", "ffprobe", (9, 0, 2), "explicit"),
    )
    with patch.object(
        runner,
        "_command_evidence",
        return_value={"version": "unknown", "command": "ffmpeg"},
    ):
        with pytest.raises(ValueError, match="release is unknown"):
            runner.inspect_pair(expected_version="9.0.2")


def test_preflight_propagates_missing_pair(runner, monkeypatch) -> None:
    monkeypatch.setattr(
        runner,
        "resolve_ffmpeg_pair",
        lambda *_args: (_ for _ in ()).throw(FFmpegPairResolutionError("missing pair")),
    )
    with pytest.raises(FFmpegPairResolutionError, match="missing pair"):
        runner.inspect_pair()


def test_junit_skip_detection_counts_skipped_cases(runner, tmp_path: Path) -> None:
    junit = tmp_path / "results.xml"
    suite = ET.Element("testsuite", tests="2", skipped="1")
    ET.SubElement(suite, "testcase", name="accepted")
    skipped = ET.SubElement(suite, "testcase", name="skipped")
    ET.SubElement(skipped, "skipped", message="requires media")
    ET.ElementTree(suite).write(junit)

    assert runner.test_counts(junit) == {"tests": 2, "skipped": 1, "failures": 0, "errors": 0}


def test_cli_preflight_failure_writes_report_and_stops_before_pytest(
    runner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        runner,
        "inspect_pair",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(FFmpegPairResolutionError("missing pair")),
    )
    with patch.object(runner.subprocess, "run") as run:
        assert runner.main(["--out-dir", str(tmp_path)]) == 2
    run.assert_not_called()
    report = json.loads((tmp_path / "ffmpeg-baseline.json").read_text(encoding="utf-8"))
    assert report["ok"] is False
    assert report["preflight_error"] == "missing pair"


def test_cli_preflight_records_command_execution_failure(
    runner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    failure = subprocess.CalledProcessError(1, ["ffmpeg", "-version"])
    monkeypatch.setattr(
        runner,
        "inspect_pair",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(failure),
    )

    assert runner.main(["--out-dir", str(tmp_path)]) == 2
    report = json.loads((tmp_path / "ffmpeg-baseline.json").read_text(encoding="utf-8"))
    assert (
        report["preflight_error"]
        == "Command '['ffmpeg', '-version']' returned non-zero exit status 1."
    )


def test_cli_rejects_skipped_acceptance_case(
    runner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        runner,
        "inspect_pair",
        lambda *_args, **_kwargs: {
            "ffmpeg": {"resolved_path": "/selected/ffmpeg"},
            "ffprobe": {"resolved_path": "/selected/ffprobe"},
        },
    )

    def write_skipped_junit(
        command: list[str], **_kwargs: object
    ) -> subprocess.CompletedProcess[bytes]:
        output = Path(command[5].split("=", maxsplit=1)[1])
        suite = ET.Element("testsuite", tests="1", skipped="1")
        case = ET.SubElement(suite, "testcase", name="skipped")
        ET.SubElement(case, "skipped", message="required acceptance")
        ET.ElementTree(suite).write(output)
        return subprocess.CompletedProcess(command, 0, b"", b"")

    with patch.object(runner.subprocess, "run", side_effect=write_skipped_junit):
        assert runner.main(["--out-dir", str(tmp_path)]) == 1
    report = json.loads((tmp_path / "ffmpeg-baseline.json").read_text(encoding="utf-8"))
    assert report["test_counts"]["skipped"] == 1
    assert report["ok"] is False


@pytest.mark.parametrize(
    "xml",
    [None, "not XML", "<testsuite/>", "<testsuite><testcase><failure/></testcase></testsuite>"],
)
def test_cli_rejects_missing_malformed_empty_or_failed_evidence(runner, tmp_path, monkeypatch, xml):
    monkeypatch.setattr(
        runner,
        "inspect_pair",
        lambda *_args, **_kwargs: {
            "ffmpeg": {"resolved_path": "/selected/ffmpeg"},
            "ffprobe": {"resolved_path": "/selected/ffprobe"},
        },
    )
    junit = tmp_path / "media-acceptance.junit.xml"
    junit.write_text('<testsuite><testcase name="stale-pass"/></testsuite>')

    def pytest_run(command, **_kwargs):
        assert not junit.exists()
        if xml is not None:
            junit.write_text(xml)
        return subprocess.CompletedProcess(command, 0)

    with patch.object(runner.subprocess, "run", side_effect=pytest_run):
        assert runner.main(["--out-dir", str(tmp_path)]) == 1
    report = json.loads((tmp_path / "ffmpeg-baseline.json").read_text())
    assert report["ok"] is False


def test_cli_runs_inspected_pair_in_child_without_changing_parent_environment(
    runner, tmp_path, monkeypatch
):
    monkeypatch.setenv("PODCAST_MCP_FFMPEG", "/ambient/ffmpeg")
    monkeypatch.setenv("PODCAST_MCP_FFPROBE", "/ambient/ffprobe")
    monkeypatch.setenv("PYTEST_ADDOPTS", "-k resolver_only")

    def inspect(ffmpeg, ffprobe, *, expected_version):
        assert (ffmpeg, ffprobe, expected_version) == ("chosen-ffmpeg", "chosen-ffprobe", "9.0.2")
        return {
            "ffmpeg": {"resolved_path": "/chosen/ffmpeg"},
            "ffprobe": {"resolved_path": "/chosen/ffprobe"},
        }

    monkeypatch.setattr(runner, "inspect_pair", inspect)

    def pytest_run(command, *, env, cwd, check, capture_output, text):
        assert env["PODCAST_MCP_FFMPEG"] == "/chosen/ffmpeg"
        assert env["PODCAST_MCP_FFPROBE"] == "/chosen/ffprobe"
        assert "PYTEST_ADDOPTS" not in env
        assert cwd == Path(runner.__file__).resolve().parents[1]
        assert check is False
        assert capture_output is True
        assert text is True
        junit = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--junitxml=")))
        junit.write_text('<testsuite><testcase name="accepted"/></testsuite>')
        return subprocess.CompletedProcess(command, 0)

    with patch.object(runner.subprocess, "run", side_effect=pytest_run):
        assert (
            runner.main(
                [
                    "--out-dir",
                    str(tmp_path),
                    "--ffmpeg",
                    "chosen-ffmpeg",
                    "--ffprobe",
                    "chosen-ffprobe",
                    "--expected-version",
                    "9.0.2",
                ]
            )
            == 0
        )
    assert runner.os.environ["PODCAST_MCP_FFMPEG"] == "/ambient/ffmpeg"
    assert runner.os.environ["PYTEST_ADDOPTS"] == "-k resolver_only"
    report = json.loads((tmp_path / "ffmpeg-baseline.json").read_text())
    assert report["tested_pair"] == {"ffmpeg": "/chosen/ffmpeg", "ffprobe": "/chosen/ffprobe"}
    assert report["test_counts"] == {"tests": 1, "skipped": 0, "failures": 0, "errors": 0}


def test_cli_fails_when_pytest_reports_deselected_cases(runner, tmp_path, monkeypatch):
    monkeypatch.setattr(
        runner,
        "inspect_pair",
        lambda *_args, **_kwargs: {
            "ffmpeg": {"resolved_path": "/chosen/ffmpeg"},
            "ffprobe": {"resolved_path": "/chosen/ffprobe"},
        },
    )

    def pytest_run(command, **_kwargs):
        junit = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--junitxml=")))
        junit.write_text('<testsuite><testcase name="accepted"/></testsuite>')
        return subprocess.CompletedProcess(command, 0, stdout="1 passed, 7 deselected", stderr="")

    with patch.object(runner.subprocess, "run", side_effect=pytest_run):
        assert runner.main(["--out-dir", str(tmp_path)]) == 1
    report = json.loads((tmp_path / "ffmpeg-baseline.json").read_text())
    assert report["deselected"] == 7
    assert report["ok"] is False
