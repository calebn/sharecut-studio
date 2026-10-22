from __future__ import annotations

import hashlib
import http.server
import io
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from script_loader import SCRIPTS, load_script


@pytest.fixture
def api(monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    transport = load_script("ci_apt_acquisition", register=True)
    method = load_script("ci_apt_method", register=True)
    return transport, method


@pytest.fixture
def endpoint(tmp_path, monkeypatch):
    key, cert = tmp_path / "key.pem", tmp_path / "cert.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    monkeypatch.setenv("CURL_CA_BUNDLE", str(cert))
    state = {
        "primary": "healthy",
        "secondary": "healthy",
        "requests": [],
        "body": b"apt-authenticated bytes" * 8,
        "started": threading.Event(),
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            origin = self.path.strip("/")
            state["requests"].append(origin)
            state["started"].set()
            mode = state[origin]
            if mode == "absent":
                self.send_error(404)
                return
            body = state["body"]
            if mode == "corrupt":
                body = b"x" * len(body)
            if mode == "oversize":
                body += b"x" * 1024
            if mode == "delayed":
                time.sleep(0.3)
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                if mode == "slow":
                    for value in body:
                        self.wfile.write(bytes([value]))
                        self.wfile.flush()
                        time.sleep(0.05)
                else:
                    self.wfile.write(body)
            except (OSError, ssl.SSLError):
                pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"https://127.0.0.1:{server.server_port}", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def budgets(transport):
    return transport.Budgets(
        connect=0.5,
        low_speed=1,
        low_speed_seconds=1,
        hedge=0.08,
        object_total=1.5,
        metadata_attempt=0.3,
        metadata_total=1.2,
    )


@pytest.mark.parametrize(
    "primary,secondary,winner",
    [
        ("healthy", "absent", 0),
        ("slow", "healthy", 1),
        ("delayed", "corrupt", 0),
        ("absent", "healthy", 1),
        ("oversize", "healthy", 1),
    ],
)
def test_accepts_only_authenticated_complete_bytes(
    api, endpoint, tmp_path, primary, secondary, winner
):
    transport, _ = api
    base, state = endpoint
    state.update(primary=primary, secondary=secondary)
    expected = state["body"]
    identity = transport.HashedObject(len(expected), hashlib.sha256(expected).hexdigest())
    plan = transport.FetchPlan(
        identity, (base + "/primary", base + "/secondary"), budgets(transport)
    )
    destination = tmp_path / "archive.deb"
    result = transport.acquire(plan, destination)
    assert result.source == winner
    assert destination.read_bytes() == expected
    assert not list(tmp_path.glob(".sharecut-apt-*"))


@pytest.mark.parametrize("mode", ["corrupt", "absent", "oversize", "slow"])
def test_all_failed_sources_publish_nothing(api, endpoint, tmp_path, mode):
    transport, _ = api
    base, state = endpoint
    state.update(primary=mode, secondary=mode)
    identity = transport.HashedObject(len(state["body"]), hashlib.sha256(state["body"]).hexdigest())
    plan = transport.FetchPlan(
        identity, (base + "/primary", base + "/secondary"), budgets(transport)
    )
    destination = tmp_path / "archive.deb"
    destination.write_bytes(b"previous valid file")
    with pytest.raises(RuntimeError):
        transport.acquire(plan, destination)
    assert destination.read_bytes() == b"previous valid file"
    assert not list(tmp_path.glob(".sharecut-apt-*"))


def test_zero_size_authenticated_object_is_valid(api, endpoint, tmp_path):
    transport, _ = api
    base, state = endpoint
    state["body"] = b""
    plan = transport.FetchPlan(
        transport.HashedObject(0, hashlib.sha256(b"").hexdigest()),
        (base + "/primary", base + "/secondary"),
        budgets(transport),
    )
    target = tmp_path / "empty"
    assert transport.acquire(plan, target).size == 0
    assert target.read_bytes() == b""


@pytest.mark.parametrize(
    "primary,winner,requests",
    [
        ("healthy", 0, ["primary"]),
        ("slow", 1, ["primary", "secondary"]),
    ],
)
def test_initial_metadata_preserves_primary_priority(
    api, endpoint, tmp_path, primary, winner, requests
):
    transport, _ = api
    base, state = endpoint
    state["primary"] = primary
    plan = transport.FetchPlan(
        transport.AptSignedMetadata(1024),
        (base + "/primary", base + "/secondary"),
        budgets(transport),
    )
    result = transport.acquire(plan, tmp_path / "InRelease")
    assert result.source == winner
    assert state["requests"] == requests


def fields(**changes):
    result = {
        "URI": "sharecut-https://archive.ubuntu.com/ubuntu/pool/main/h/hello/hello_1_amd64.deb",
        "Expected-SHA256": "0" * 64,
        "Expected-Checksum-FileSize": "0",
    }
    result.update(changes)
    return result


@pytest.mark.parametrize(
    "changes",
    [
        {"Expected-SHA256": "bad"},
        {"Expected-SHA256": "A" * 64},
        {"Expected-Checksum-FileSize": "-1"},
        {"Expected-Checksum-FileSize": "1.0"},
        {"Expected-Checksum-FileSize": "9" * 20},
        {"URI": "sharecut-https://evil.example/ubuntu/pool/main/h/hello/hello.deb"},
        {"URI": "sharecut-https://archive.ubuntu.com/ubuntu/pool/main/../evil"},
        {"URI": "sharecut-https://archive.ubuntu.com/ubuntu/pool/main/%2e%2e/evil"},
        {"URI": "sharecut-https://archive.ubuntu.com/ubuntu/pool/main/%00evil"},
        {"URI": "sharecut-https://user:secret@archive.ubuntu.com/ubuntu/pool/main/a"},
        {"URI": "sharecut-https://archive.ubuntu.com/ubuntu/pool/main/a?token=secret"},
        {
            "URI": "sharecut-https://archive.ubuntu.com/ubuntu/dists/unknown/main/binary-amd64/Packages"
        },
        {"Target-Architecture": "arm64"},
    ],
)
def test_rejects_malformed_or_outside_policy_requests(api, changes):
    _, method = api
    with pytest.raises((ValueError, KeyError)):
        method.plan_request(fields(**changes))


def test_apt_identity_and_security_route_are_preserved(api):
    transport, method = api
    request = fields(
        URI="sharecut-https://security.ubuntu.com/ubuntu/dists/resolute-security/main/binary-amd64/by-hash/SHA256/"
        + "a" * 64
    )
    plan = method.plan_request(request)
    assert isinstance(plan.identity, transport.HashedObject)
    assert plan.identity.size == 0
    assert plan.identity.sha256 == "0" * 64
    assert plan.urls == (
        "https://security.ubuntu.com/ubuntu/dists/resolute-security/main/binary-amd64/by-hash/SHA256/"
        + "a" * 64,
        "https://mirrors.edge.kernel.org/ubuntu/dists/resolute-security/main/binary-amd64/by-hash/SHA256/"
        + "a" * 64,
    )


@pytest.mark.parametrize(
    "message",
    [
        "600 URI Acquire\nURI: x\nURI: y\n\n",
        "600 URI Acquire\nFilename: x\n",
        "600 URI Acquire\nBadField\n\n",
        "600 URI Acquire\nURI: x\r\n\n",
        "600 URI Acquire\nURI: " + "x" * 65536 + "\n\n",
    ],
)
def test_protocol_framing_fails_closed(api, message):
    _, method = api
    with pytest.raises(ValueError):
        method.read_message(io.StringIO(message))


def test_symlink_destinations_fail_without_changing_target(api, tmp_path):
    _, method = api
    original = tmp_path / "original"
    original.write_bytes(b"keep")
    symlink = tmp_path / "destination"
    symlink.symlink_to(original)
    with pytest.raises(ValueError):
        method.destination_path(str(symlink))
    assert original.read_bytes() == b"keep"


def test_configuration_is_idempotent_and_preserves_source_metadata(api, tmp_path):
    _, method = api
    apt = tmp_path / "apt"
    (apt / "sources.list.d").mkdir(parents=True)
    (apt / "apt.conf.d").mkdir()
    methods = tmp_path / "methods"
    methods.mkdir()
    mirrors = apt / "apt-mirrors.txt"
    mirrors.write_text(
        "# runner mirrors\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n"
        "https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
        "https://security.ubuntu.com/ubuntu/\tpriority:3\n"
    )
    ubuntu = apt / "sources.list.d/ubuntu.sources"
    ubuntu.write_text(
        "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: resolute\n"
        "Components: main\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
    )
    installation = tmp_path / "installed"
    for _ in range(2):
        method.configure(apt, installation, methods)
    assert mirrors.read_text() == (
        "# runner mirrors\nsharecut-https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
        "sharecut-https://security.ubuntu.com/ubuntu/\tpriority:3\n"
    )
    assert ubuntu.read_text().endswith(
        "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
    )
    assert (
        apt / "apt.conf.d/99sharecut-acquisition"
    ).read_text() == 'APT::Update::Error-Mode "any";\n'
    assert (methods / method.METHOD).stat().st_mode & 0o777 == 0o755
    assert (installation / "ci_apt_acquisition.py").stat().st_mode & 0o777 == 0o644
    assert (apt / "apt.conf.d/99sharecut-acquisition").stat().st_mode & 0o777 == 0o644


def test_cancelled_transfer_reaps_children_and_publishes_nothing(api, endpoint, tmp_path):
    base, state = endpoint
    state.update(primary="slow", secondary="slow")
    target = tmp_path / "cancelled"
    code = """import signal,sys
from pathlib import Path
from ci_apt_acquisition import AptSignedMetadata,Budgets,FetchPlan,acquire
from ci_apt_method import cancelled
signal.signal(signal.SIGTERM,cancelled)
plan=FetchPlan(AptSignedMetadata(1024),(sys.argv[1]+"/primary",sys.argv[1]+"/secondary"),Budgets(metadata_attempt=10,metadata_total=20))
acquire(plan,Path(sys.argv[2]))
"""
    process = subprocess.Popen([sys.executable, "-c", code, base, str(target)], cwd=SCRIPTS)
    try:
        assert state["started"].wait(5)
        children = [
            int(p.name)
            for p in Path("/proc").iterdir()
            if p.name.isdigit()
            and (p / "status").exists()
            and f"PPid:\t{process.pid}\n" in (p / "status").read_text()
        ]
        assert children
        process.terminate()
        assert process.wait(timeout=3) == 0
        assert all(not Path(f"/proc/{pid}").exists() for pid in children)
        assert not target.exists()
        assert not list(tmp_path.glob(".sharecut-apt-*"))
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
