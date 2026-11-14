#!/usr/bin/env python3
"""Launch the ShareCut app on the iOS Simulator and assert what it promises from the Mac.

    make ios-sim-proof            # IOS_SIM_DEVICE=<name or UDID>

The Simulator shares the Mac's loopback, so the engine's port is reachable here. A debug build of
the app also writes ``request-audit.jsonl`` in its log folder (``podcast_mcp.gui.request_audit``:
method, path without its query string, status and whether the query was empty, never a value),
which this script reads from the Mac. Assertions:

1. the app launches and the engine reaches Serving (the lifecycle log, the listening port,
   the health route answering and refusing a caller without the boot token), and the page
   reaches the bottom edge of the screen (1b: the last row of a screenshot is the colour of the
   first);
2. an owner route without a session is refused, the docs routes are absent, a code the engine
   never issued is refused and sets no cookie, and the audit shows the exchange answered 200
   exactly once (the app's own first navigation). The script cannot see that code, so replaying
   a real one is pinned by ``tests/test_gui_embedded_session.py``;
3. the page read ``/api/bootstrap/status`` under its session (200 in the audit); the Audio
   tools card text is on the screenshot;
4. the UI (the card, creating and opening a project) is not driven from here;
5. the page's host WebSocket was accepted (101), an event stream and a media request answered
   200, from the audit. The page's socket and stream URLs carry non-secret parameters (the
   project path, client ids, a job id), so ``query_empty`` is false for them and the audit,
   which never records a value, cannot show their names; that no token is in them rests on the
   engine accepting only the session cookie on this host, pinned by the same test file;
6. after the app goes to the background and returns, the same port answers and the lifecycle
   rechecked it;
7. a copy of the payload with a module removed shows the failure sentence and logs the reason;
8. private storage: Documents (the Files-visible folder) holds no share registry, identity store
   or relay config, and no sqlite file in it has an ``active_shares`` table; the registry sits
   under the private state folder, file mode 0600 in a 0700 directory. The registry exists only
   once the engine has opened it, so a run that never did is partly observed.

Assertion 5 needs a project open. ``--ui-window SECONDS`` keeps the app open that long (and
stops early once a WebSocket accept shows) so a person or the Simulator tool can open one.

``results.json`` and its statuses are described in docs/desktop-packaging.md § iOS app. The exit
code is non-zero only for ``failed``.

Evidence goes to gui/desktop/src-tauri/target/ios-sim-proof.
Nothing printed or saved contains the exchange code, a session id or a first-navigation URL:
this script never sees them.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import stat
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EVIDENCE = ROOT / "gui" / "desktop" / "src-tauri" / "target" / "ios-sim-proof"
PREFERENCES = "com.apple.Preferences"
FAILURE_SENTENCE = "ShareCut couldn't start on this device."


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


def bmp_pixel(data: bytes, x: int, y: int) -> tuple[int, int, int]:
    """The (r, g, b) at column ``x``, row ``y`` from the top of a 32-bit BMP (`simctl io screenshot --type=bmp`)."""
    offset = struct.unpack_from("<I", data, 10)[0]
    width, height = struct.unpack_from("<ii", data, 18)
    bits = struct.unpack_from("<H", data, 28)[0]
    if bits != 32 or not (0 <= x < width and 0 <= y < abs(height)):
        raise ValueError(f"no pixel ({x}, {y}) in a {width}x{height} {bits}-bit bitmap")
    row = y if height < 0 else abs(height) - 1 - y
    blue, green, red, _ = data[offset + row * width * 4 + x * 4 :][:4]
    return red, green, blue


EXCHANGE_PATH = "/api/session/exchange"
HOST_SOCKET_PATH = "/api/host/ws"
STATUS_PATH = "/api/bootstrap/status"
MEDIA_PREFIXES = ("/api/waveform/tiles/", "/api/waveform/pcm/")
AUDIT_FILE_NAME = "request-audit.jsonl"
FAILED, OBSERVED, PARTLY, NOT_OBSERVED = "failed", "observed", "partly_observed", "not_observed"


def parse_audit(text: str) -> list[dict[str, object]]:
    """The audit's JSON lines; a line cut off by a read in the middle of a write is skipped."""
    rows: list[dict[str, object]] = []
    for line in text.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


@dataclass(frozen=True)
class AuditFacts:
    """What the audit shows, counted."""

    requests: int
    exchange_200: int
    status_reads_200: int
    host_socket_accepts: int
    event_streams_200: tuple[str, ...]
    media_requests_200: tuple[str, ...]


def audit_facts(rows: list[dict[str, object]]) -> AuditFacts:
    def count(method: str, path: str, status: int) -> int:
        return sum(
            1
            for row in rows
            if (row.get("method"), row.get("path"), row.get("status")) == (method, path, status)
        )

    def paths_answered(keep: Callable[[str], bool]) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    str(row["path"])
                    for row in rows
                    if row.get("method") == "GET"
                    and row.get("status") == 200
                    and keep(str(row.get("path", "")))
                }
            )
        )

    return AuditFacts(
        requests=len(rows),
        exchange_200=count("GET", EXCHANGE_PATH, 200),
        status_reads_200=count("GET", STATUS_PATH, 200),
        host_socket_accepts=count("WEBSOCKET", HOST_SOCKET_PATH, 101),
        event_streams_200=paths_answered(lambda path: path.endswith("/events")),
        media_requests_200=paths_answered(lambda path: path.startswith(MEDIA_PREFIXES)),
    )


def traffic_assertions(facts: AuditFacts) -> dict[str, dict[str, object]]:
    """Assertions 3 and 5 from the audit."""
    seen = {
        "socket": facts.host_socket_accepts > 0,
        "stream": bool(facts.event_streams_200),
        "media": bool(facts.media_requests_200),
    }
    missing = [name for name, ok in seen.items() if not ok]
    if not missing:
        outcome, gap = OBSERVED, None
    elif len(missing) < len(seen):
        outcome, gap = PARTLY, f"not seen in the audit: {', '.join(missing)}"
    else:
        outcome, gap = NOT_OBSERVED, "no page traffic beyond Home; open a project (--ui-window)"
    return {
        "3_bootstrap_status_under_session": {
            "status": PARTLY if facts.status_reads_200 else NOT_OBSERVED,
            "status_reads_200": facts.status_reads_200,
            "gap": "the audit shows the read answered 200; the card's sentence is on the screenshot",
        },
        "5_page_traffic": {
            "status": outcome,
            "host_socket_accepts": facts.host_socket_accepts,
            "event_streams_200": list(facts.event_streams_200),
            "media_requests_200": list(facts.media_requests_200),
            "gap": gap,
        },
    }


STATE_RELDIR = Path("Library/Application Support/ShareCut/state")
REGISTRY_NAME = "share_registry.sqlite"
DOCUMENTS_FORBIDDEN_PREFIXES = (REGISTRY_NAME, "share_identity.sqlite", "relay.yaml")
SQLITE_MAGIC = b"SQLite format 3\0"


def _holds_registry_table(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            if handle.read(len(SQLITE_MAGIC)) != SQLITE_MAGIC:
                return False
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro&immutable=1", uri=True)
        try:
            found = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'active_shares'"
            ).fetchone()
        finally:
            connection.close()
    except (OSError, sqlite3.Error):
        return False
    return found is not None


def private_storage_facts(container: Path) -> dict[str, object]:
    """Assertion 8 from the app's data container: where the share registry and its kin live."""
    documents = container / "Documents"
    visible = sorted(
        str(path.relative_to(container))
        for path in documents.rglob("*")
        if path.is_file()
        and (path.name.startswith(DOCUMENTS_FORBIDDEN_PREFIXES) or _holds_registry_table(path))
    )
    state = container / STATE_RELDIR
    registry = state / REGISTRY_NAME
    file_mode = directory_mode = None
    if registry.is_file():
        file_mode = stat.S_IMODE(registry.stat().st_mode)
        directory_mode = stat.S_IMODE(state.stat().st_mode)
    private = (file_mode, directory_mode) == (0o600, 0o700)
    if visible or (registry.is_file() and not private):
        status, gap = FAILED, None
    elif registry.is_file():
        status, gap = OBSERVED, None
    else:
        status, gap = PARTLY, "the engine never opened the registry, so its mode was not read"
    return {
        "status": status,
        "gap": gap,
        "visible_in_documents": visible,
        "registry_file_mode": None if file_mode is None else oct(file_mode),
        "state_directory_mode": None if directory_mode is None else oct(directory_mode),
    }


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

    def record(self, key: str, held: bool, *, partly: str | None = None, **detail: object) -> None:
        """One assertion: it ``failed``, held in full (``observed``) or held for what the script sees."""
        status = FAILED if not held else PARTLY if partly else OBSERVED
        self.results[key] = {"status": status, "gap": partly, **detail}
        print(f"{status} {key} {json.dumps(detail, sort_keys=True)}")

    def record_row(self, key: str, row: dict[str, object]) -> None:
        self.results[key] = row
        print(f"{row['status']} {key} {json.dumps(row, sort_keys=True)}")

    def audit_rows(self) -> list[dict[str, object]]:
        """The engine's request audit from the app's log folder (a debug build writes it)."""
        container = run("xcrun", "simctl", "get_app_container", self.device, self.bundle_id, "data")
        path = Path(container.strip()) / "Library" / "Logs" / "ShareCut" / AUDIT_FILE_NAME
        return parse_audit(path.read_text(encoding="utf-8")) if path.exists() else []

    def ui_window(self, seconds: float) -> None:
        """Leave the app open for a person to open a project; stop once the page's socket is accepted."""
        deadline = time.monotonic() + seconds
        while (
            time.monotonic() < deadline and audit_facts(self.audit_rows()).host_socket_accepts == 0
        ):
            time.sleep(2)

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

    def page_fills_screen(self) -> None:
        """The page's canvas reaches the bottom edge: the last row is the colour of the first."""
        shot = self.evidence / "screen.bmp"
        run("xcrun", "simctl", "io", self.device, "screenshot", "--type=bmp", str(shot))
        data = shot.read_bytes()
        shot.unlink()
        height = abs(struct.unpack_from("<i", data, 22)[0])
        top, bottom = bmp_pixel(data, 20, 10), bmp_pixel(data, 20, height - 1)
        self.record(
            "1b_page_fills_screen",
            top == bottom,
            top_row_rgb=list(top),
            bottom_row_rgb=list(bottom),
        )

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
        facts = audit_facts(self.audit_rows())
        owner, _ = http(self.port, "/api/projects/recent")
        docs = {path: http(self.port, path)[0] for path in ("/docs", "/redoc", "/openapi.json")}
        guesses = [http(self.port, f"{EXCHANGE_PATH}?code=not-a-code-{i}") for i in range(2)]
        self.record(
            "2_refusals",
            owner in (401, 403)
            and all(code == 404 for code in docs.values())
            and all(code == 403 and "Set-Cookie" not in headers for code, headers in guesses)
            and facts.exchange_200 == 1,
            partly="replaying the real code needs the code, which only the app sees; "
            "tests/test_gui_embedded_session.py replays a real one and gets 403 with no cookie",
            owner_route_without_session=owner,
            docs_routes=docs,
            made_up_code_statuses=[code for code, _ in guesses],
            exchange_answered_200_times=facts.exchange_200,
        )

    def page_traffic(self) -> None:
        for key, row in traffic_assertions(audit_facts(self.audit_rows())).items():
            self.record_row(key, row)

    def private_storage(self) -> None:
        container = run("xcrun", "simctl", "get_app_container", self.device, self.bundle_id, "data")
        self.record_row("8_private_storage", private_storage_facts(Path(container.strip())))

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


UI_ASSERTION = {
    "status": NOT_OBSERVED,
    "gap": "needs the UI: Home's Audio tools card, creating and opening a project; "
    "screenshots are kept with the proof",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--device", default="booted")
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--bundle-id", required=True)
    parser.add_argument("--ui-window", type=float, default=0, metavar="SECONDS")
    args = parser.parse_args()
    proof = Proof(args.device, args.app, args.bundle_id, DEFAULT_EVIDENCE)
    served = proof.serving()
    if served:
        time.sleep(8)
        proof.screenshot("1_serving")
        proof.page_fills_screen()
        proof.ui_window(args.ui_window)
        proof.refusals()
        proof.page_traffic()
        proof.record_row("4_ui", dict(UI_ASSERTION))
        proof.private_storage()
        proof.background_and_return()
        proof.broken_payload()
    report = {"schema": 2, "device": args.device, "assertions": dict(sorted(proof.results.items()))}
    (DEFAULT_EVIDENCE / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    failed = [key for key, row in proof.results.items() if row["status"] == FAILED]
    return 0 if served and not failed else 1


if __name__ == "__main__":
    sys.exit(main())
