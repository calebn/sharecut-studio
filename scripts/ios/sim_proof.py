#!/usr/bin/env python3
"""Launch the ShareCut app on the iOS Simulator and assert what it promises from the Mac.

    make ios-sim-proof            # IOS_SIM_DEVICE=<name or UDID>, IOS_SIM_APP=<path to the .app>

The Simulator shares the Mac's loopback, so the engine's port is reachable here. Checks:

1. the app launches and the engine reaches Serving (the lifecycle log, the listening port,
   the health route answering and refusing a caller without the boot token);
2. an owner route without a session is refused, the docs routes are absent, a code the engine
   never issued is refused and sets no cookie;
6. after the app goes to the background and returns, the same port answers and the lifecycle
   rechecked it;
7. a copy of the payload with a module removed shows the failure sentence and logs the reason.

What needs a person in the UI (Home's Audio tools card, creating and opening a project, the
event stream and media requests under the session cookie) is not driven from here. This script
saves the screenshots and the connection table that evidence needs next to its own results.

Evidence goes to ``--evidence-dir`` (default: gui/desktop/src-tauri/target/ios-sim-proof).
Nothing printed or saved contains the exchange code, a session id or a first-navigation URL:
this script never sees them.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EVIDENCE = ROOT / "gui" / "desktop" / "src-tauri" / "target" / "ios-sim-proof"
PREFERENCES = "com.apple.Preferences"
FAILURE_SENTENCE = "ShareCut couldn't start on this device. Try again."


def parse_launch_pid(output: str) -> int:
    """`simctl launch` prints `<bundle id>: <pid>`."""
    match = re.search(r":\s*(\d+)\s*$", output.strip())
    if match is None:
        raise ValueError(f"no pid in simctl launch output: {output!r}")
    return int(match.group(1))


def parse_listen_port(lsof_output: str) -> int | None:
    """The TCP port of the first `127.0.0.1:<port> (LISTEN)` line of `lsof -nP`."""
    match = re.search(r"127\.0\.0\.1:(\d+)\s+\(LISTEN\)", lsof_output)
    return int(match.group(1)) if match else None


def run(*command: str, check: bool = True) -> str:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if check and result.returncode != 0:
        raise SystemExit(f"{command[0]} failed: {(result.stdout + result.stderr).strip()[-400:]}")
    return result.stdout + result.stderr


def http(port: int, path: str) -> tuple[int, dict[str, str]]:
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=5) as response:
            return response.status, dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


class Proof:
    def __init__(self, device: str, app: Path, bundle_id: str, evidence: Path) -> None:
        self.device, self.app, self.bundle_id, self.evidence = device, app, bundle_id, evidence
        self.results: dict[str, dict[str, object]] = {}
        self.since = time.strftime("%Y-%m-%d %H:%M:%S")
        evidence.mkdir(parents=True, exist_ok=True)

    def record(self, key: str, passed: bool, **detail: object) -> None:
        self.results[key] = {"passed": passed, **detail}
        print(f"{'PASS' if passed else 'FAIL'} {key} {json.dumps(detail, sort_keys=True)}")

    def stderr_log(self) -> str:
        """The app's stderr lines since this launch (the Simulator routes them to the unified log)."""
        text = run(
            "xcrun",
            "simctl",
            "spawn",
            self.device,
            "log",
            "show",
            "--style",
            "compact",
            "--start",
            self.since,
            "--predicate",
            f'subsystem == "{self.bundle_id}"',
            check=False,
        )
        lines = [
            line for line in text.splitlines() if "[stderr]" in line or line.startswith("ShareCut")
        ]
        (self.evidence / "stderr.log").write_text("\n".join(lines) + "\n")
        return "\n".join(lines)

    def screenshot(self, name: str) -> None:
        run("xcrun", "simctl", "io", self.device, "screenshot", str(self.evidence / f"{name}.png"))

    def launch(self) -> int:
        run("xcrun", "simctl", "terminate", self.device, self.bundle_id, check=False)
        (self.evidence / "stderr.log").unlink(missing_ok=True)
        output = run(
            "xcrun",
            "simctl",
            "launch",
            f"--stdout={self.evidence / 'stdout.log'}",
            f"--stderr={self.evidence / 'stderr.log'}",
            self.device,
            self.bundle_id,
        )
        return parse_launch_pid(output)

    def listen_port(self, pid: int, timeout: float) -> tuple[int | None, float]:
        started = time.monotonic()
        while time.monotonic() - started < timeout:
            port = parse_listen_port(
                run("lsof", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN", "-nP", check=False)
            )
            if port:
                return port, time.monotonic() - started
            time.sleep(1)
        return None, timeout

    def wait_health(self, port: int, timeout: float) -> tuple[int | None, float]:
        """The port is bound before the engine finishes importing, so the first answer can lag."""
        started = time.monotonic()
        while time.monotonic() - started < timeout:
            try:
                return http(port, "/api/health")[0], time.monotonic() - started
            except OSError:
                time.sleep(1)
        return None, timeout

    def serving(self) -> int:
        pid = self.launch()
        port, listen_sec = self.listen_port(pid, 240)
        health, health_sec = None, None
        if port:
            health, health_sec = self.wait_health(port, 240)
        log = self.stderr_log()
        self.record(
            "1_launch_and_serving",
            port is not None and health == 401 and "Starting -> Serving" in log,
            pid=pid,
            port=port,
            seconds_to_listening_port=round(listen_sec, 1),
            seconds_to_health_answer=None
            if health_sec is None
            else round(listen_sec + health_sec, 1),
            health_without_boot_token=health,
            lifecycle_reached_serving="Starting -> Serving" in log,
        )
        self.pid, self.port = pid, port or 0
        return self.port

    def refusals(self) -> None:
        owner, _ = http(self.port, "/api/projects/recent")
        docs = {path: http(self.port, path)[0] for path in ("/docs", "/redoc", "/openapi.json")}
        guesses = [
            http(self.port, "/api/session/exchange?code=not-a-code-" + str(i)) for i in range(2)
        ]
        self.record(
            "2_refusals",
            owner in (401, 403)
            and all(code == 404 for code in docs.values())
            and all(code == 403 and "Set-Cookie" not in headers for code, headers in guesses),
            owner_route_without_session=owner,
            docs_routes=docs,
            unissued_code_statuses=[code for code, _ in guesses],
            note="the real code is spent by the app's first navigation; this script never sees it",
        )

    def background_and_return(self) -> None:
        before = self.listen_port(self.pid, 5)[0]
        run("xcrun", "simctl", "launch", self.device, PREFERENCES)
        time.sleep(10)
        pid_after = parse_launch_pid(run("xcrun", "simctl", "launch", self.device, self.bundle_id))
        time.sleep(8)
        after = self.listen_port(pid_after, 20)[0]
        log = self.stderr_log()
        health = http(after, "/api/health")[0] if after else None
        self.screenshot("6_after_foreground")
        self.record(
            "6_background_then_foreground",
            before == after
            and pid_after == self.pid
            and health == 401
            and "Serving -> Rechecking" in log
            and "Rechecking -> Serving" in log,
            same_pid=pid_after == self.pid,
            same_port=before == after,
            health_without_boot_token=health,
            rechecked="Serving -> Rechecking" in log,
            served_again="Rechecking -> Serving" in log,
        )

    def broken_payload(self) -> None:
        clone = self.evidence / "broken" / self.app.name
        shutil.rmtree(clone.parent, ignore_errors=True)
        clone.parent.mkdir(parents=True)
        run("cp", "-cR", str(self.app), str(clone))
        shutil.rmtree(clone / "app_packages" / "yaml")
        run("codesign", "--force", "--sign", "-", str(clone), check=False)
        run("xcrun", "simctl", "install", self.device, str(clone))
        self.launch()
        deadline = time.monotonic() + 90
        while (
            time.monotonic() < deadline and "ShareCut engine did not start" not in self.stderr_log()
        ):
            time.sleep(2)
        time.sleep(4)
        self.screenshot("7_broken_payload_splash")
        log = self.stderr_log()
        self.record(
            "7_broken_payload",
            "ShareCut engine did not start" in log and "Starting -> Failed" in log,
            reason_logged="ShareCut engine did not start" in log,
            lifecycle_failed="Starting -> Failed" in log,
            sentence_expected_on_splash=FAILURE_SENTENCE,
            screenshot="7_broken_payload_splash.png",
        )
        shutil.rmtree(clone.parent, ignore_errors=True)
        run("xcrun", "simctl", "install", self.device, str(self.app))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--device", default="booted")
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--bundle-id", required=True)
    parser.add_argument("--evidence-dir", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--skip-broken", action="store_true")
    args = parser.parse_args()
    proof = Proof(args.device, args.app, args.bundle_id, args.evidence_dir)
    if not proof.serving():
        (args.evidence_dir / "results.json").write_text(json.dumps(proof.results, indent=2))
        return 1
    time.sleep(8)
    proof.screenshot("1_serving")
    proof.refusals()
    proof.background_and_return()
    if not args.skip_broken:
        proof.broken_payload()
    (args.evidence_dir / "results.json").write_text(json.dumps(proof.results, indent=2) + "\n")
    return 0 if all(row["passed"] for row in proof.results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
