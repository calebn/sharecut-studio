"""Verify the fixed synthetic Editor flow once on each pinned app source."""

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
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = "e2e/stage-shell.spec.ts"
TITLE = (
    "an Editor's comment survives a normal reload-derived save "
    "and Undo/Redo restores only that comment"
)
FIXTURE_COMMIT = "5eed071928d78b6bcef35e251fdae79c09dbfd58"
SOURCES = {
    "control": "513a773213b0be201a29f4a78f9495bbbd637b62",
    "candidate": "ab1e209490f35e0fed5ebe79493c40bbc83ea535",
}
FROZEN = {
    "uv.lock": "fa281fd9ff090719ad47ea3a011ed17daa0caf3987afab12f0f534e64967de34",
    "pyproject.toml": "39dd41d2e41e1166ed1de5c6ef45a4cca9ef94910aeac9e8c72aa0697c574c62",
    "gui/web/package-lock.json": "e99650ce15498fe37c0eca392e00a3c76771fd86f947aedbdfa6e83a8bca0f21",
    "gui/web/package.json": "96e7e3d625e1079413efd43a1df4c736e3de82315359ec117862d41dcd35e286",
    "scripts/private_browser_command.sh": "28dc0c5b15c3ab50c9dbdf0ad6d41bfa45081ed7f4b9ff8d81fe760a16dcc896",
    "gui/web/playwright.config.ts": "44ad5a5d966111d33c4ded9626f2ada5bd568be24d9c8c9a00d0ed651e4b10e9",
    "gui/web/scripts/run-e2e.ts": "0db34828c7f1159f2d118d44743be6635b72b1a755602cfafef7158fceed78ff",
    "gui/web/e2e/shareableProject.ts": "2acdf093597086b53f11c4a6442b59dd065a336f510fda1414da4e2cd64776f1",
    "gui/web/e2e/shareNavigation.ts": "4bc6397a56e3e0ae0318b1408594e7f2c860fbae28b1582a8eb6663061c52d25",
    "gui/web/e2e/runtimeEnv.ts": "1897acbe149850f00e6adcc2171ccb764542218b0f99f529621c00601ec82cec",
    ".github/actions/install-locked-python/action.yml": "06049ee2ebd4629e569a1760b793028526db3a5c2e65d34b07825e021246a43a",
    ".github/actions/setup-ffmpeg/action.yml": "de45f54275ba5e3449a8e7acf57e0858e455e0a04221d77cd85b4e30902bba13",
}
APP_FILES = {
    "candidate": {
        "src/podcast_mcp/engines/source_proxy_audio.py": "7ea7ac96e112bedad982cea87fb50989c15f1e682025781ce64e426321bab2d7",
        "src/podcast_mcp/services/media/proxy_variants.py": "45345431d6a89e0aa5016979dbce8fc45d6a0eb0583a5b6f77045979945daace",
    },
    "control": {
        "src/podcast_mcp/engines/source_proxy_audio.py": "7992d1a0662ec03dabc2386a1e4650d3b1e5525ae3bcea5e8be9543f6560a5eb",
        "src/podcast_mcp/services/media/proxy_variants.py": "feae419481099f6707af047c82cfcf97e2c631ea11a5b56c014722d24570db42",
    },
}
FIXTURE_FILES = {
    "gui/web/e2e/stage-shell.spec.ts": "cc7ffd7ad543149d480dea6b31062238cfa6619dbc93865c07492763995b26c0",
    "scripts/browser_public_report.py": "cb46924117a8c7fe555e3a6071452a4546a88bc3a4ab9b724e64fb02541ac591",
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


def require_hash(root: Path, files: dict[str, str]) -> None:
    for relative, digest in files.items():
        path = root / relative
        if path.resolve() != path or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise InvalidSetup


def checkout(path: Path, actual: str | None, expected: str) -> Path:
    if path.resolve() != path or actual != expected:
        raise InvalidSetup
    return path


def app(side: str, env: dict[str, str]) -> Path:
    path = checkout(ROOT / f"pair-3923-{side}", env.get(f"PAIR_{side.upper()}_SHA"), SOURCES[side])
    require_hash(path, FROZEN | APP_FILES[side])
    return path


def prepare(env: dict[str, str]) -> int:
    checkout(ROOT, env.get("PAIR_WORKFLOW_SHA"), env["PAIR_PR_HEAD"])
    require_hash(ROOT, FROZEN)
    fixture = checkout(ROOT / "pair-3923-fixture", env.get("PAIR_FIXTURE_SHA"), FIXTURE_COMMIT)
    require_hash(fixture, FIXTURE_FILES)
    dependencies = ROOT / "gui/web/node_modules"
    if not (dependencies / "@playwright/test/cli.js").is_file():
        raise InvalidSetup
    for side in SOURCES:
        source = app(side, env)
        for name in FIXTURE_FILES:
            target = source / name
            if target.resolve() != target or not target.is_file():
                raise InvalidSetup
            shutil.copyfile(fixture / name, target)
        (source / "gui/web/node_modules").symlink_to(dependencies, target_is_directory=True)
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


def list_matches(report: object) -> bool:
    def discovered(suites: list) -> list:
        return [
            (spec.get("file"), spec.get("title"), len(spec["tests"]))
            for suite in suites
            for spec in suite["specs"]
        ] + [match for suite in suites for match in discovered(suite.get("suites", []))]

    return report["errors"] == [] and discovered(report["suites"]) == [
        ("stage-shell.spec.ts", TITLE, 1)
    ]


def exercise(side: str, runtime: dict[str, str]) -> int:
    source = app(side, runtime)
    require_hash(source, FIXTURE_FILES)
    web = source / "gui/web"
    dependencies = web / "node_modules"
    if not dependencies.is_symlink() or dependencies.readlink() != ROOT / "gui/web/node_modules":
        raise InvalidSetup

    env = {
        key: value
        for key, value in runtime.items()
        if key
        not in {"BROWSER_RAW_REPORT", "BROWSER_CAPTURE_RECEIPT", "PLAYWRIGHT_JSON_OUTPUT_FILE"}
    }
    env |= {
        "PYTHONPATH": str(source / "src"),
        "VITE_SHARECUT_E2E": "1",
        "PODCAST_GUI_DIST": str(web / "dist"),
    }
    capture = ("bash", str(ROOT / "scripts/private_browser_command.sh"))
    check_import = (
        "from importlib.util import find_spec; from pathlib import Path; import sys; "
        "spec = find_spec('podcast_mcp'); "
        "sys.exit(not (spec and spec.origin and Path(spec.origin).resolve() == Path(sys.argv[1])))"
    )
    origin = str(source / "src/podcast_mcp/__init__.py")
    for phase, command in (
        ("python-source", (sys.executable, "-c", check_import, origin)),
        ("build", ("npm", "run", "build")),
    ):
        result = run_command((*capture, *command), web, env)
        print(f"{side} {phase}: {result}")
        if result:
            return result

    command = (
        *capture,
        "npm",
        "run",
        "test:e2e",
        "--",
        SPEC,
        "--grep",
        TITLE + "$",
        "--workers=1",
        "--retries=0",
        "--reporter=json",
    )
    with tempfile.TemporaryDirectory(dir=runtime["RUNNER_TEMP"]) as private:
        scratch = Path(private)
        receipt = scratch / "capture.txt"
        output = scratch / "projection.json"
        raw = f"playwright-report/3923-{side}.json"
        browser_env = env | {
            "BROWSER_RAW_REPORT": raw,
            "BROWSER_CAPTURE_RECEIPT": str(receipt),
            "PLAYWRIGHT_JSON_OUTPUT_FILE": raw,
        }
        try:
            result = run_command((*command, "--list"), web, browser_env)
            if result or not list_matches(json.loads((web / raw).read_text(encoding="utf-8"))):
                print(f"{side} discovery: failed")
                return result or 2
            print(f"{side} discovery: one")
            result = run_command(command, web, browser_env)
            print(f"{side} test: {result}")
            if result:
                return result
            result = run_command(
                (
                    sys.executable,
                    str(source / "scripts/browser_public_report.py"),
                    "--report",
                    str(web / raw),
                    "--output",
                    str(output),
                    "--capture-receipt",
                    str(receipt),
                ),
                ROOT,
                runtime,
            )
            if result:
                print(f"{side} projection: {result}")
                return result
            passed = passed_case(json.loads(output.read_text(encoding="utf-8")))
            print(f"{side} validation: {'passed' if passed else 'failed'}")
            return 0 if passed else 2
        finally:
            (web / raw).unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", *SOURCES))
    stage = parser.parse_args().stage
    env = dict(os.environ)
    try:
        validate_runtime(env)
        if stage == "prepare":
            return prepare(env)
        return exercise(stage, env)
    except (OSError, ValueError, RecursionError, KeyError, TypeError):
        print(f"{stage}: verification setup or result unavailable")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
