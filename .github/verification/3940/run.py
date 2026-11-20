from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
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


PARENT = "7239e6818e4d924c34f1c61c4623e68a415fd82c"
HEAD = "add4b0466ac529493d5eb8e9b62e3c7c61d7ffa2"
HEAD_PALETTE = "855e44c3a1ce4934787dc9f5f0a728da19efd9e2adace10384c5a1e7b07e496a"
RAW_REPORT = "playwright-report/palette-pair.json"


class InvalidProof(ValueError):
    pass


def verify_files(root: Path, files: dict[Path, str]) -> None:
    for path, expected in files.items():
        if hashlib.sha256((root / path).read_bytes()).hexdigest() != expected:
            raise InvalidProof


def fixed_source(root: Path, env: dict[str, str]) -> Path:
    checkout = root / "pair-3940-head"
    if checkout.resolve() != checkout or env.get("PROOF_HEAD_SHA") != HEAD:
        raise InvalidProof
    verify_files(checkout, {**FROZEN, PALETTE: HEAD_PALETTE})
    return checkout


def harness_files(root: Path) -> dict[Path, bytes]:
    verify_files(root, HARNESS)
    files = {path: (root / path).read_bytes() for path in HARNESS}
    if files[SMOKE].count(MODE) != 1:
        raise InvalidProof
    return {**files, WEB / SPEC: REGISTRATION}


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


def case_verdict(report: dict) -> bool:
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
        and verdict["mode"] == "head"
        and verdict["outcome"] == "HEAD_PASS"
        and verdict["browserVersion"] == "158.0.8127.18"
        and verdict["browserRevision"] == 1254
        and verdict["fixtureSha256"] == HARNESS[FIXTURE]
    )


def verify_cleanup(tmp: Path) -> None:
    if any(tmp.glob("sharecut-e2e-*")):
        raise InvalidProof


class ProofRun(NamedTuple):
    root: Path
    checkout: Path
    temp: Path
    identity: str
    env: dict[str, str]

    @property
    def web(self) -> Path:
        return self.checkout / WEB

    @property
    def capture(self) -> tuple[str, str]:
        return ("bash", str(self.root / "scripts/private_browser_command.sh"))

    @property
    def source_env(self) -> dict[str, str]:
        env = self.env | {
            "TMPDIR": str(self.temp),
            "PYTHONPATH": str(self.checkout / "src"),
            "VITE_SHARECUT_E2E": "1",
            "PODCAST_GUI_DIST": str(self.web / "dist"),
        }
        for key in ("BROWSER_RAW_REPORT", "BROWSER_CAPTURE_RECEIPT", "PLAYWRIGHT_JSON_OUTPUT_FILE"):
            env.pop(key, None)
        return env

    def state(self) -> str:
        directory = self.temp.lstat()
        if (
            not stat.S_ISDIR(directory.st_mode)
            or stat.S_IMODE(directory.st_mode) != 0o700
            or directory.st_uid != os.geteuid()
        ):
            raise InvalidProof
        marker = self.temp / "state"
        info = marker.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_uid != os.geteuid()
        ):
            raise InvalidProof
        identity, state = marker.read_text(encoding="utf-8").splitlines()
        if identity != self.identity:
            raise InvalidProof
        return state

    def record(self, state: str) -> None:
        temporary = self.temp / "state.next"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as marker:
            marker.write(f"{self.identity}\n{state}\n")
        temporary.replace(self.temp / "state")

    def require(self, state: str) -> None:
        if self.state() != state:
            raise InvalidProof


def prepare(proof: ProofRun) -> None:
    proof.temp.mkdir(mode=0o700)
    dependencies = proof.root / WEB / "node_modules"
    if not (dependencies / "@playwright/test/cli.js").is_file():
        raise InvalidProof
    for relative, content in harness_files(proof.root).items():
        destination = proof.checkout / relative
        if destination.resolve() != destination:
            raise InvalidProof
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    (proof.web / "node_modules").symlink_to(dependencies, target_is_directory=True)
    import_check = (
        "from importlib.util import find_spec; from pathlib import Path; import sys; "
        "spec = find_spec('podcast_mcp'); "
        "sys.exit(not (spec and spec.origin and Path(spec.origin).resolve() == Path(sys.argv[1])))"
    )
    run(
        (
            *proof.capture,
            sys.executable,
            "-c",
            import_check,
            str(proof.checkout / "src/podcast_mcp/__init__.py"),
        ),
        proof.web,
        proof.source_env,
    )
    proof.record("source")


def verify_overlay(proof: ProofRun) -> None:
    for relative, content in harness_files(proof.root).items():
        target = proof.checkout / relative
        if target.resolve() != target or target.read_bytes() != content:
            raise InvalidProof
    dependencies = proof.web / "node_modules"
    if (
        not dependencies.is_symlink()
        or dependencies.readlink() != proof.root / WEB / "node_modules"
    ):
        raise InvalidProof


def build(proof: ProofRun) -> None:
    proof.require("source")
    verify_overlay(proof)
    run((*proof.capture, "npm", "run", "build"), proof.web, proof.source_env)
    proof.record("built")


def browser(proof: ProofRun) -> None:
    proof.require("built")
    verify_overlay(proof)
    proof.record("browser-started")
    run(
        (
            *proof.capture,
            "npm",
            "run",
            "test:e2e",
            "--",
            SPEC,
            "--workers=1",
            "--retries=0",
            "--reporter=json",
        ),
        proof.web,
        proof.source_env
        | {
            "BROWSER_RAW_REPORT": RAW_REPORT,
            "BROWSER_CAPTURE_RECEIPT": str(proof.temp / "capture.txt"),
            "PLAYWRIGHT_JSON_OUTPUT_FILE": RAW_REPORT,
        },
    )
    proof.record("browser-passed")


def cleanup(proof: ProofRun) -> None:
    state = proof.state()
    if state not in {"browser-started", "browser-passed"}:
        raise InvalidProof
    verify_cleanup(proof.temp)
    proof.record("cleaned-pass" if state == "browser-passed" else "cleaned-failure")


def verdict(proof: ProofRun) -> None:
    proof.require("cleaned-pass")
    raw = proof.web / RAW_REPORT
    receipt = proof.temp / "capture.txt"
    projection = proof.temp / "result.json"
    if any(path.resolve() != path or not path.is_file() for path in (raw, receipt)):
        raise InvalidProof
    run(
        (
            sys.executable,
            str(proof.root / "scripts/browser_public_report.py"),
            "--report",
            str(raw),
            "--output",
            str(projection),
            "--capture-receipt",
            str(receipt),
        ),
        proof.root,
        proof.env,
    )
    if not passed_case(json.loads(projection.read_bytes())) or not case_verdict(
        json.loads(raw.read_bytes())
    ):
        raise InvalidProof
    raw.unlink()
    shutil.rmtree(proof.temp)


def main() -> int:
    stages = {
        "source": prepare,
        "build": build,
        "browser": browser,
        "cleanup": cleanup,
        "verdict": verdict,
    }
    parser = argparse.ArgumentParser(
        description="Verify the pinned fixed Sharecut source with the synthetic palette smoke."
    )
    parser.add_argument("stage", choices=stages)
    stage = parser.parse_args().stage
    env = dict(os.environ)
    try:
        tmp = Path(env["TMPDIR"])
        if (
            env.get("GITHUB_ACTIONS") != "true"
            or env.get("CI") != "true"
            or env.get("GITHUB_RUN_ATTEMPT") != "1"
            or not re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_RUN_ID", ""))
            or env.get("PROOF_EVENT_BASE") != PARENT
            or tmp.resolve() != tmp
            or not tmp.is_dir()
            or not Path(env["RUNNER_TEMP"]).is_absolute()
            or not Path(env["RUNNER_TEMP"]).is_dir()
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
        identity = f"{env['GITHUB_RUN_ID']} {env['GITHUB_RUN_ATTEMPT']} {HEAD}"
        proof = ProofRun(ROOT, fixed_source(ROOT, env), tmp / "3940-fixed-proof", identity, env)
        stages[stage](proof)
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
