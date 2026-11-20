from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[3]
WEB = Path("gui/web")
PALETTE = WEB / "src/stage/dialogs/CommandPalette.tsx"
SMOKE = WEB / "e2e/paletteReconnectSmoke.ts"
SPEC = "e2e/palette-reconnect-pair.spec.ts"
FIXTURE = WEB / "e2e/fixtures/palette-reconnect.sharecut"
FROZEN = {
    Path("uv.lock"): "fa281fd9ff090719ad47ea3a011ed17daa0caf3987afab12f0f534e64967de34",
    Path("pyproject.toml"): "39dd41d2e41e1166ed1de5c6ef45a4cca9ef94910aeac9e8c72aa0697c574c62",
    WEB / "package-lock.json": "e99650ce15498fe37c0eca392e00a3c76771fd86f947aedbdfa6e83a8bca0f21",
    WEB / "package.json": "96e7e3d625e1079413efd43a1df4c736e3de82315359ec117862d41dcd35e286",
}
HARNESS = {
    SMOKE: "82f587b3c868adefb585ff8caf36895769051eda2ec28b690f7ec1d8b11754bc",
    WEB
    / "e2e/paletteFollowerProbe.ts": "e770ecc623d71eaa3f217fe0a6490a624a58b587809ed16095fcdfc9abd9aba8",
    WEB
    / "e2e/paletteReconnectProject.ts": "595971c8e3d99d8fe5f3be1aba4c440307757c0993f7fd37dc7f1f3113488bc7",
    FIXTURE: "0aa596a1c40cae5cce93aa9f574ec278389d4e7128d5496aba741a802c9916de",
}
PROTECTION = {
    Path(
        "scripts/private_browser_command.sh"
    ): "28dc0c5b15c3ab50c9dbdf0ad6d41bfa45081ed7f4b9ff8d81fe760a16dcc896",
    Path(
        "scripts/browser_public_report.py"
    ): "4c1c192cc771cbc472eed419201cd08ab25aabd1cb378914a46dae76a030f0ef",
}
MODE = b'const mode: string = "head";'
REGISTRATION = b'import { registerPaletteReconnectSmoke } from "./paletteReconnectSmoke";\n\nregisterPaletteReconnectSmoke();\n'


class Source(NamedTuple):
    commit: str
    palette: str
    verdict: str


SOURCES = {
    "parent": Source(
        "7239e6818e4d924c34f1c61c4623e68a415fd82c",
        "7c4dd05b8f446f5bbc2f059f07f38f39c14a7fe83e18563fe8660d39ffe945e7",
        "PARENT_BUG_REPRODUCED",
    ),
    "head": Source(
        "add4b0466ac529493d5eb8e9b62e3c7c61d7ffa2",
        "855e44c3a1ce4934787dc9f5f0a728da19efd9e2adace10384c5a1e7b07e496a",
        "HEAD_PASS",
    ),
}


class InvalidProof(ValueError):
    pass


def verify_files(root: Path, files: dict[Path, str]) -> None:
    for path, expected in files.items():
        if hashlib.sha256((root / path).read_bytes()).hexdigest() != expected:
            raise InvalidProof


def source_root(root: Path, mode: str, env: dict[str, str]) -> Path:
    source = SOURCES[mode]
    checkout = root / f"pair-3940-{mode}"
    if checkout.resolve() != checkout or env.get(f"PAIR_{mode.upper()}_SHA") != source.commit:
        raise InvalidProof
    verify_files(checkout, {**FROZEN, PALETTE: source.palette})
    return checkout


def harness_files(root: Path, mode: str) -> dict[Path, bytes]:
    verify_files(root, HARNESS)
    files = {path: (root / path).read_bytes() for path in HARNESS}
    if files[SMOKE].count(MODE) != 1:
        raise InvalidProof
    files[SMOKE] = files[SMOKE].replace(MODE, MODE.replace(b'"head"', f'"{mode}"'.encode()))
    return {**files, WEB / SPEC: REGISTRATION}


def prepare(root: Path, env: dict[str, str]) -> None:
    dependencies = root / WEB / "node_modules"
    if not (dependencies / "@playwright/test/cli.js").is_file():
        raise InvalidProof
    for mode in SOURCES:
        checkout = source_root(root, mode, env)
        for relative, content in harness_files(root, mode).items():
            destination = checkout / relative
            if destination.resolve() != destination:
                raise InvalidProof
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        (checkout / WEB / "node_modules").symlink_to(dependencies, target_is_directory=True)


def run(command: tuple[str, ...], cwd: Path, env: dict[str, str]) -> None:
    subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )


def passed_case(projection: dict) -> bool:
    (suite,) = projection["suites"]
    (case,) = suite["specs"]
    (test,) = case["tests"]
    (attempt,) = test["results"]
    return (
        projection["format"] == "sharecut-browser-public-v1"
        and projection["global_error_count"] == 0
        and not suite["suites"]
        and case["case_id"] == 1
        and (test["status"], test["expectedStatus"]) == ("expected", "passed")
        and (attempt["status"], attempt["retry"]) == ("passed", 0)
    )


def case_verdict(report: dict, mode: str) -> bool:
    (suite,) = report["suites"]
    (group,) = suite["suites"]
    (case,) = group["specs"]
    (test,) = case["tests"]
    (attempt,) = test["results"]
    (receipt,) = attempt["attachments"]
    verdict = json.loads(base64.b64decode(receipt["body"], validate=True))
    return (
        not suite["specs"]
        and not group.get("suites")
        and case["title"] == "real reconnect keeps palette actions current while open"
        and receipt["name"] == "palette-reconnect-verdict"
        and receipt["contentType"] == "application/json"
        and verdict["mode"] == mode
        and verdict["outcome"] == SOURCES[mode].verdict
        and verdict["browserVersion"] == "158.0.8127.18"
        and verdict["browserRevision"] == 1254
        and verdict["fixtureSha256"] == HARNESS[FIXTURE]
    )


def verify_cleanup(tmp: Path) -> None:
    if any(tmp.glob("sharecut-e2e-*")):
        raise InvalidProof


def exercise(root: Path, mode: str, env: dict[str, str]) -> None:
    checkout = source_root(root, mode, env)
    web = checkout / WEB
    for relative, content in harness_files(root, mode).items():
        if (checkout / relative).read_bytes() != content:
            raise InvalidProof
    dependencies = web / "node_modules"
    if not dependencies.is_symlink() or dependencies.readlink() != root / WEB / "node_modules":
        raise InvalidProof

    temp = Path(tempfile.mkdtemp(prefix=f"pair-3940-{mode}-", dir=env["TMPDIR"]))
    raw = "playwright-report/palette-pair.json"
    receipt = temp / "capture.txt"
    projection = temp / "result.json"
    source_env = env | {
        "TMPDIR": str(temp),
        "PYTHONPATH": str(checkout / "src"),
        "VITE_SHARECUT_E2E": "1",
        "PODCAST_GUI_DIST": str(web / "dist"),
    }
    capture = ("bash", str(root / "scripts/private_browser_command.sh"))
    import_check = (
        "from importlib.util import find_spec; from pathlib import Path; import sys; "
        "spec = find_spec('podcast_mcp'); "
        "sys.exit(not (spec and spec.origin and Path(spec.origin).resolve() == Path(sys.argv[1])))"
    )
    for key in ("BROWSER_RAW_REPORT", "BROWSER_CAPTURE_RECEIPT", "PLAYWRIGHT_JSON_OUTPUT_FILE"):
        source_env.pop(key, None)
    run(
        (
            *capture,
            sys.executable,
            "-c",
            import_check,
            str(checkout / "src/podcast_mcp/__init__.py"),
        ),
        web,
        source_env,
    )
    run((*capture, "npm", "run", "build"), web, source_env)
    try:
        run(
            (
                *capture,
                "npm",
                "run",
                "test:e2e",
                "--",
                SPEC,
                "--workers=1",
                "--retries=0",
                "--reporter=json",
            ),
            web,
            source_env
            | {
                "BROWSER_RAW_REPORT": raw,
                "BROWSER_CAPTURE_RECEIPT": str(receipt),
                "PLAYWRIGHT_JSON_OUTPUT_FILE": raw,
            },
        )
    finally:
        verify_cleanup(temp)

    run(
        (
            sys.executable,
            str(root / "scripts/browser_public_report.py"),
            "--report",
            str(web / raw),
            "--output",
            str(projection),
            "--capture-receipt",
            str(receipt),
        ),
        root,
        env,
    )
    if not passed_case(json.loads(projection.read_bytes())) or not case_verdict(
        json.loads((web / raw).read_bytes()), mode
    ):
        raise InvalidProof
    (web / raw).unlink()
    shutil.rmtree(temp)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Exercise exact Sharecut app revisions with the same synthetic palette smoke."
    )
    parser.add_argument("stage", choices=("prepare", *SOURCES))
    stage = parser.parse_args().stage
    env = dict(os.environ)
    try:
        if (
            env.get("GITHUB_ACTIONS") != "true"
            or env.get("CI") != "true"
            or env.get("GITHUB_RUN_ATTEMPT") != "1"
            or not re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_RUN_ID", ""))
            or env.get("PAIR_EVENT_BASE") != SOURCES["parent"].commit
            or not all(
                Path(env[key]).is_absolute() and Path(env[key]).is_dir()
                for key in ("TMPDIR", "RUNNER_TEMP")
            )
            or any(
                env.get(key)
                for key in (
                    "DAW_E2E_PROJECT",
                    "DAW_E2E_PORT",
                    "DAW_E2E_PIN_PROJECT",
                    "UX_DEMO_SCREENSHOTS",
                )
            )
        ):
            raise InvalidProof
        verify_files(ROOT, {**FROZEN, **PROTECTION})
        if stage == "prepare":
            prepare(ROOT, env)
        else:
            exercise(ROOT, stage, env)
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        RecursionError,
        subprocess.CalledProcessError,
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
