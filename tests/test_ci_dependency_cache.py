from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

ROOT = Path(__file__).parents[1]
HELPER = ROOT / "scripts" / "ci_ffmpeg_cache.py"
ACTION = ROOT / ".github" / "actions" / "setup-ffmpeg" / "action.yml"
WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
cache = load_script("ci_ffmpeg_cache", register=True)


def archive_row(
    name: str = "ffmpeg_1_amd64.deb", data: bytes = b"verified package", uri: str | None = None
) -> str:
    uri = uri or f"https://archive.ubuntu.com/ubuntu/pool/{name}"
    return f"'{uri}' {name} {len(data)} SHA256:{hashlib.sha256(data).hexdigest()}\n"


def test_cli_retains_only_authenticated_packages_and_leaves_missing_for_apt(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "archives"
    directory.mkdir()
    manifest = tmp_path / "trusted-plan"
    names = ["good.deb", "missing.deb", "corrupt.deb", "short.deb", "link.deb"]
    manifest.write_text("".join(archive_row(name) for name in names), encoding="utf-8")
    (directory / "good.deb").write_bytes(b"verified package")
    (directory / "corrupt.deb").write_bytes(b"modified package")
    (directory / "short.deb").write_bytes(b"short")
    (directory / "extra.deb").write_bytes(b"extra")
    (directory / "lock").touch()
    partial = directory / "partial"
    partial.mkdir()
    (partial / "unfinished.deb").write_bytes(b"unfinished")
    target = tmp_path / "outside.deb"
    target.write_bytes(b"verified package")
    (directory / "link.deb").symlink_to(target)
    (directory / "linked-directory").symlink_to(tmp_path, target_is_directory=True)

    result = subprocess.run(
        [sys.executable, str(HELPER), "verify", str(manifest), str(directory)],
        capture_output=True,
        text=True,
        check=True,
    )

    outputs = dict(line.split("=", 1) for line in result.stdout.splitlines())
    assert outputs["verified_count"] == "1"
    assert outputs["archive_count"] == "5"
    assert outputs["total_bytes"] == "80"
    assert sorted(path.name for path in directory.iterdir()) == ["good.deb"]
    assert (directory / "good.deb").read_bytes() == b"verified package"
    assert target.read_bytes() == b"verified package"
    assert manifest.read_text(encoding="utf-8") == "".join(archive_row(name) for name in names)


@pytest.mark.parametrize(
    "row",
    [
        archive_row("../escape.deb"),
        archive_row("/absolute.deb"),
        archive_row("nested/archive.deb"),
        archive_row("archive.tar"),
        archive_row("bad\\name.deb"),
        archive_row() + archive_row(),
        archive_row().replace("SHA256:", "MD5Sum:"),
        archive_row().replace("SHA256:", "SHA1:"),
        archive_row().replace("16 SHA256:", "0 SHA256:"),
        archive_row().replace("16 SHA256:", "-1 SHA256:"),
        archive_row().replace("16 SHA256:", "sixteen SHA256:"),
        archive_row().replace(" SHA256:", " SHA256:bad"),
        archive_row().rsplit(" ", 1)[0],
        archive_row().rstrip() + " extra",
        "'https://archive.ubuntu.com/unclosed",
        archive_row(uri="file:///local.deb"),
        archive_row(uri="https:///missing-host.deb"),
    ],
)
def test_invalid_manifest_fails_before_touching_archives(tmp_path: Path, row: str) -> None:
    directory = tmp_path / "archives"
    directory.mkdir()
    good = directory / "good.deb"
    good.write_bytes(b"keep until manifest is authenticated")
    manifest = tmp_path / "plan"
    manifest.write_text(row, encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(HELPER), "verify", str(manifest), str(directory)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "ValueError" in result.stderr
    assert good.read_bytes() == b"keep until manifest is authenticated"
    assert result.stdout == ""


def test_plan_ignores_apt_progress_and_accepts_real_escaped_epoch_names() -> None:
    row = archive_row("libavcodec_7%3a1.0-1_amd64.deb")
    plan = cache.parse_archive_plan("Reading package lists...\nBuilding dependency tree...\n" + row)

    assert list(plan) == ["libavcodec_7%3a1.0-1_amd64.deb"]
    archive = plan["libavcodec_7%3a1.0-1_amd64.deb"]
    assert archive.size == 16
    assert archive.uri == "https://archive.ubuntu.com/ubuntu/pool/libavcodec_7%3a1.0-1_amd64.deb"
    assert archive.sha256 == "5b365b709602bee45e8db24117a4f631efd738927cd9e85e95f765d6d58d909d"


def test_plan_digest_is_order_independent_and_invalidates_every_archive_field() -> None:
    first = archive_row("a.deb")
    second = archive_row("b.deb")
    digest = cache.archive_plan_digest(cache.parse_archive_plan(first + second))

    assert digest == cache.archive_plan_digest(cache.parse_archive_plan(second + first))
    for changed in (
        archive_row("c.deb") + second,
        archive_row("a.deb", uri="https://security.ubuntu.com/ubuntu/a.deb") + second,
        archive_row("a.deb", data=b"longer verified package") + second,
        archive_row("a.deb", data=b"modified package") + second,
    ):
        assert cache.archive_plan_digest(cache.parse_archive_plan(changed)) != digest


def test_empty_already_installed_plan_has_no_downloads(tmp_path: Path) -> None:
    manifest = tmp_path / "plan"
    manifest.write_text("ffmpeg is already the newest version.\n", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(HELPER), "plan", str(manifest)],
        capture_output=True,
        text=True,
        check=True,
    )

    assert result.stdout == (
        "digest=4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\n"
        "archive_count=0\ntotal_bytes=0\n"
    )


@pytest.mark.parametrize("cache_hit", ["true", "false"])
@pytest.mark.parametrize("failed_tool", ["", "sudo", "ffmpeg", "ffprobe"])
def test_install_shell_runs_on_every_hit_and_propagates_tool_failures(
    tmp_path: Path, cache_hit: str, failed_tool: str
) -> None:
    step = load_github_yaml(ACTION)["runs"]["steps"][3]
    binaries = tmp_path / "bin"
    binaries.mkdir()
    (binaries / "python3").symlink_to(sys.executable)
    log = tmp_path / "commands"
    directory = tmp_path / "archives"
    directory.mkdir()
    manifest = tmp_path / "plan"
    manifest.write_text(archive_row(), encoding="utf-8")
    source = tmp_path / "authentic.deb"
    source.write_bytes(b"verified package")
    for tool in ("sudo", "ffmpeg", "ffprobe"):
        executable = binaries / tool
        executable.write_text(
            '#!/bin/bash\ntool=${0##*/}\necho "$tool" >> "$COMMAND_LOG"\n'
            'if [ "$tool" = "$FAILED_TOOL" ]; then exit 1; fi\n'
            'if [ "$tool" = sudo ]; then cp "$SOURCE" "$ARCHIVES/ffmpeg_1_amd64.deb"; fi\n',
            encoding="utf-8",
        )
        executable.chmod(0o755)
    outputs = tmp_path / "outputs"
    summary = tmp_path / "summary"
    env = {
        **os.environ,
        "PATH": f"{binaries}{os.pathsep}{os.environ['PATH']}",
        "COMMAND_LOG": str(log),
        "FAILED_TOOL": failed_tool,
        "SOURCE": str(source),
        "ARCHIVES": str(directory),
        "MANIFEST": str(manifest),
        "GITHUB_WORKSPACE": str(ROOT),
        "GITHUB_OUTPUT": str(outputs),
        "GITHUB_STEP_SUMMARY": str(summary),
        "STARTED": "0",
        "RESTORED_COUNT": "0",
        "CACHE_HIT": cache_hit,
        "ARCHIVE_COUNT": "1",
        "ARCHIVE_BYTES": "16",
    }

    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", step["run"]],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    expected = ["sudo", "ffmpeg", "ffprobe"]
    if failed_tool:
        assert result.returncode == 1
        assert log.read_text().splitlines() == expected[: expected.index(failed_tool) + 1]
        assert not outputs.exists() and not summary.exists()
    else:
        assert result.returncode == 0, result.stderr
        assert log.read_text().splitlines() == expected
        assert outputs.read_text().endswith("archive_count=1\ntotal_bytes=16\nverified_count=1\n")
        assert f"Exact cache hit: {cache_hit}\n" in summary.read_text()
        assert "Planned archives: 1\nArchive bytes: 16\n" in summary.read_text()


def test_workflow_keeps_installs_checks_and_only_one_ffmpeg_cache_writer() -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    assert set(jobs) == {"pytest", "frontend", "frontend-e2e-suites", "frontend-e2e"}
    writers = []
    for name in ("pytest", "frontend-e2e-suites"):
        steps = jobs[name]["steps"]
        ffmpeg = next(
            step for step in steps if step.get("uses") == "./.github/actions/setup-ffmpeg"
        )
        assert "if" not in ffmpeg and not ffmpeg.get("continue-on-error")
        if ffmpeg.get("with", {}).get("save-cache") == "true":
            writers.append(name)
        python = next(
            step for step in steps if step.get("uses", "").startswith("actions/setup-python@")
        )
        assert python["with"]["cache"] == "pip"
        assert python["with"]["cache-dependency-path"].splitlines() == ["pyproject.toml", "uv.lock"]
        install = next(step for step in steps if "pip install -e" in step.get("run", ""))
        assert "if" not in install and not install.get("continue-on-error")
        extras = "dev,gui,relay,prosody" if name == "pytest" else "gui"
        assert (
            install["run"] == f'python -m pip install --upgrade pip\npip install -e ".[{extras}]"\n'
        )
    assert writers == ["pytest"]
    frontend_python = next(
        step
        for step in jobs["frontend"]["steps"]
        if step.get("uses", "").startswith("actions/setup-python@")
    )
    assert "cache" not in frontend_python["with"]
    pytest_steps = jobs["pytest"]["steps"]
    test = next(step for step in pytest_steps if "coverage report" in step.get("run", ""))
    assert "if" not in test and not test.get("continue-on-error")
    assert (
        test["run"]
        == 'pytest -n auto -m "not e2e_slow and not e2e_real"\ncoverage report --fail-under=95\n'
    )
    browser_steps = jobs["frontend-e2e-suites"]["steps"]
    browser = next(step for step in browser_steps if "playwright install" in step.get("run", ""))
    assert browser["run"] == "npm ci\nnpx playwright install --with-deps chromium webkit\n"
    assert "if" not in browser and not browser.get("continue-on-error")


def test_action_has_fresh_metadata_and_hard_install_before_advisory_save() -> None:
    steps = load_github_yaml(ACTION)["runs"]["steps"]
    assert [step.get("id") for step in steps] == ["plan", "restore", "restored", "installed", None]
    for step in (steps[0], steps[2], steps[3]):
        assert "if" not in step and not step.get("continue-on-error")
    plan = steps[0]["run"]
    assert 'directory="${RUNNER_TEMP:?}/ffmpeg-archives"' in plan
    assert "ffmpeg-archives.XXXXXX" not in plan
    assert plan.index('rm -rf "$directory"') < plan.index("--print-uris")
    assert 'mktemp "$RUNNER_TEMP/ffmpeg-plan.XXXXXX"' in plan
    assert "--error-on=any" in plan and "Acquire::ForceHash=SHA256" in plan
    assert "${VERSION_CODENAME}-${ImageVersion}-${POLICY_HASH}" in plan
    for operation, step in (("restore", steps[1]), ("save", steps[4])):
        assert step["uses"] == f"actions/cache/{operation}@v6"
        assert step["continue-on-error"] is True
        assert step["with"]["path"] == "${{ steps.plan.outputs.directory }}/*.deb"
        assert "restore-keys" not in step["with"]
        assert (
            step["with"]["key"]
            == "${{ steps.plan.outputs.identity }}-${{ steps.plan.outputs.digest }}"
        )
    install = steps[3]["run"]
    assert "APT::Keep-Downloaded-Packages=true install ffmpeg" in install
    assert (
        install.index("install ffmpeg")
        < install.index("ffmpeg -version")
        < install.index("ffprobe -version")
    )
    assert "inputs.save-cache == 'true'" in steps[4]["if"]
    assert "verified_count == steps.installed.outputs.archive_count" in steps[4]["if"]
    assert "<= 157286400" in steps[4]["if"]
