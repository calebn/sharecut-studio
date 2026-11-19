"""Run the exact two-source Script/Find comparison on an admitted Actions runner."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[2]
VERIFY = Path(".github/verification/3915")
SPEC = "e2e/script-recording-identity-paired.verify.spec.ts"
INPUTS = {
    SPEC: VERIFY / "paired.spec.ts",
    "e2e/scriptRecordingIdentityProject.ts": Path("gui/web/e2e/scriptRecordingIdentityProject.ts"),
    "e2e/fixtures/script-recording-identity.sharecut": Path(
        "gui/web/e2e/fixtures/script-recording-identity.sharecut"
    ),
}
FROZEN = {
    "uv.lock": "fa281fd9ff090719ad47ea3a011ed17daa0caf3987afab12f0f534e64967de34",
    "pyproject.toml": "39dd41d2e41e1166ed1de5c6ef45a4cca9ef94910aeac9e8c72aa0697c574c62",
    "gui/web/package-lock.json": "e99650ce15498fe37c0eca392e00a3c76771fd86f947aedbdfa6e83a8bca0f21",
    "gui/web/package.json": "96e7e3d625e1079413efd43a1df4c736e3de82315359ec117862d41dcd35e286",
}
MAPPER = "src/podcast_mcp/gui/mapper.py"
SCRIPT_MODEL = "gui/web/src/stage/edit/script/scriptModel.ts"


class Source(NamedTuple):
    name: str
    commit: str
    mapper_sha256: str
    script_model_sha256: str

    @property
    def directory(self) -> str:
        return f"pair-3915-{self.name}"

    def web(self, root: Path) -> Path:
        return root / self.directory / "gui/web"

    def receipt(self, root: Path) -> Path:
        return root / VERIFY / f"capture-{self.name}.txt"

    def public(self, root: Path) -> Path:
        return root / "playwright-public-3915-pair" / f"{self.name}.json"


SOURCES = {
    "parent": Source(
        "parent",
        "6eb5b9a7cb91398bf27116b9619b9c4cb3e61387",
        "59b9f0e9b44169c47ddbd26baabce99b43cd18192cc969d1ad58e3eb30d0f477",
        "b7db28bc4b37625222afff3f861620fa01e1485ae83d35a672d41ea57ce97988",
    ),
    "head": Source(
        "head",
        "0a99ed0fc86845cbe423d4ae677e2f1240f16574",
        "a749b162368ab35b22e0d743ca7365193b1f1996ae0ff351aa5ca8b8176893d6",
        "8b6603b12d41fee066b53225905edf5b733be1bf5db8fbefbdbc884eb7558b23",
    ),
}


class InvalidSetup(ValueError):
    pass


def validate_runtime(env: dict[str, str]) -> None:
    if (
        env.get("GITHUB_ACTIONS") != "true"
        or env.get("CI") != "true"
        or any(
            not re.fullmatch(r"[1-9][0-9]*", env.get(key, ""))
            for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")
        )
        or not env.get("RUNNER_TEMP")
        or not Path(env["RUNNER_TEMP"]).is_absolute()
        or not Path(env["RUNNER_TEMP"]).is_dir()
    ):
        raise InvalidSetup


def verify_files(root: Path, expected: dict[str, str]) -> None:
    for relative, expected_hash in expected.items():
        if hashlib.sha256((root / relative).read_bytes()).hexdigest() != expected_hash:
            raise InvalidSetup


def verify_source(root: Path, source: Source, env: dict[str, str]) -> None:
    checkout = root / source.directory
    if (
        checkout.resolve() != checkout
        or env.get(f"PAIR_{source.name.upper()}_SHA") != source.commit
    ):
        raise InvalidSetup
    verify_files(
        checkout,
        {**FROZEN, MAPPER: source.mapper_sha256, SCRIPT_MODEL: source.script_model_sha256},
    )


def prepare(root: Path, env: dict[str, str]) -> int:
    for source in SOURCES.values():
        source.public(root).unlink(missing_ok=True)
        source.receipt(root).unlink(missing_ok=True)
    verify_files(root, FROZEN)
    for source in SOURCES.values():
        verify_source(root, source, env)

    dependencies = root / "gui/web/node_modules"
    if not (dependencies / "@playwright/test/cli.js").is_file():
        raise InvalidSetup
    for source in SOURCES.values():
        web = source.web(root)
        for relative, original in INPUTS.items():
            path = web / relative
            if path.resolve() != path:
                raise InvalidSetup
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / original, path)
        link = web / "node_modules"
        if link.is_symlink() and link.readlink() == dependencies:
            continue
        link.symlink_to(dependencies, target_is_directory=True)

    print("prepare: ready")
    return 0


def run_command(command: tuple[str, ...], cwd: Path, env: dict[str, str]) -> int:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


def passed_case(projection: object) -> bool:
    try:
        spec = projection["suites"][0]["specs"][0]
        attempt = spec["tests"][0]["results"][0]
        retry = attempt["retry"]
        if (
            type(retry) is not int
            or retry != 0
            or type(projection["global_error_count"]) is not int
            or type(spec["case_id"]) is not int
        ):
            return False
        if "duration" in attempt:
            duration = attempt["duration"]
            if (
                type(duration) not in (int, float)
                or not math.isfinite(duration)
                or not 0 <= duration <= 2**53
            ):
                return False
        clean_attempt = {key: value for key, value in attempt.items() if key != "duration"}
        expected_attempt = {"status": "passed", "retry": 0}
        expected = {
            "format": "sharecut-browser-public-v1",
            "global_error_count": 0,
            "suites": [
                {
                    "specs": [
                        {
                            "case_id": 1,
                            "tests": [
                                {
                                    "status": "expected",
                                    "expectedStatus": "passed",
                                    "results": [attempt],
                                }
                            ],
                        }
                    ],
                    "suites": [],
                }
            ],
        }
        return clean_attempt == expected_attempt and projection == expected
    except (AttributeError, IndexError, KeyError, TypeError, OverflowError):
        return False


def exercise(root: Path, source: Source, runtime_env: dict[str, str]) -> int:
    output = source.public(root)
    receipt = source.receipt(root)
    output.unlink(missing_ok=True)
    receipt.unlink(missing_ok=True)
    verify_source(root, source, runtime_env)
    web = source.web(root)
    harness = root / "gui/web"
    dependencies = web / "node_modules"
    if not dependencies.is_symlink() or dependencies.readlink() != harness / "node_modules":
        raise InvalidSetup
    for relative, original in INPUTS.items():
        if (web / relative).read_bytes() != (root / original).read_bytes():
            raise InvalidSetup

    env = dict(runtime_env)
    env.pop("BROWSER_RAW_REPORT", None)
    env.pop("BROWSER_CAPTURE_RECEIPT", None)
    env.pop("PLAYWRIGHT_JSON_OUTPUT_FILE", None)
    env["PYTHONPATH"] = str(root / source.directory / "src")
    env["VITE_SHARECUT_E2E"] = "1"
    env["SCRIPT_RECORDING_IDENTITY_PROFILE"] = source.name
    env["PODCAST_GUI_DIST"] = str(web / "dist")

    capture = ("bash", str(root / "scripts/private_browser_command.sh"))
    check_import = (
        "from importlib.util import find_spec; from pathlib import Path; import sys; "
        "spec = find_spec('podcast_mcp'); "
        "sys.exit(not (spec and spec.origin and Path(spec.origin).resolve() == Path(sys.argv[1])))"
    )
    origin = str(Path(env["PYTHONPATH"]) / "podcast_mcp/__init__.py")
    result = run_command((*capture, sys.executable, "-c", check_import, origin), web, env)
    print(f"{source.name} python-source: {result}")
    if result:
        return result
    result = run_command((*capture, "npm", "run", "build"), web, env)
    print(f"{source.name} build: {result}")
    if result:
        return result

    raw = f"playwright-report/3915-{source.name}.json"
    browser_env = env | {
        "BROWSER_RAW_REPORT": raw,
        "BROWSER_CAPTURE_RECEIPT": str(receipt),
        "PLAYWRIGHT_JSON_OUTPUT_FILE": raw,
    }
    result = run_command(
        (
            *capture,
            "npm",
            "run",
            "test:e2e",
            "--",
            SPEC,
            "--workers=1",
            "--retries=0",
            "--reporter=github,json",
        ),
        web,
        browser_env,
    )
    print(f"{source.name} test: {result}")
    if result:
        return result
    result = run_command(
        (
            sys.executable,
            str(root / "scripts/browser_public_report.py"),
            "--report",
            str(web / raw),
            "--output",
            str(output),
            "--capture-receipt",
            str(receipt),
        ),
        root,
        runtime_env,
    )
    print(f"{source.name} projection: {result}")
    if result:
        output.unlink(missing_ok=True)
        return result

    valid = False
    try:
        valid = passed_case(json.loads(output.read_text(encoding="utf-8")))
    finally:
        if not valid:
            output.unlink(missing_ok=True)
    print(f"{source.name} validation: {'passed' if valid else 'failed'}")
    return 0 if valid else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", *SOURCES))
    stage = parser.parse_args().stage
    env = dict(os.environ)
    try:
        validate_runtime(env)
        if stage == "prepare":
            return prepare(ROOT, env)
        return exercise(ROOT, SOURCES[stage], env)
    except (OSError, ValueError, RecursionError):
        print(f"{stage}: verification setup or result unavailable")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
