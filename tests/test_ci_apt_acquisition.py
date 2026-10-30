from __future__ import annotations

import hashlib
import http.server
import io
import json
import signal
import ssl
import subprocess
import sys
import threading
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
        "stopped": threading.Event(),
        "secondary_sent": threading.Event(),
        "secondary_started": threading.Event(),
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            origin = self.path.strip("/")
            if origin == "secondary":
                state["secondary_started"].set()
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
                assert state["secondary_sent"].wait(3)
            if mode == "hedged":
                assert state["secondary_started"].wait(3)
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                if mode == "slow":
                    self.wfile.write(body[:1])
                    self.wfile.flush()
                    state["stopped"].wait(3)
                else:
                    self.wfile.write(body)
                    self.wfile.flush()
                if origin == "secondary":
                    state["secondary_sent"].set()
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
        state["stopped"].set()
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


@pytest.mark.parametrize(
    "entry",
    [
        "http://mirror.example.net/ubuntu",
        "https://mirror.example.net/ubuntu/",
        "https://mirror.example.net/ubuntu/\tpriority:10",
        "http://mirror.example.net/ubuntu  priority:2",
        "                https://mirror.example.net/ubuntu/\tpriority:999999",
    ],
)
@pytest.mark.parametrize("ending", ["\n", "\r\n"])
def test_rejected_public_mirror_diagnostic_identifies_exact_entry(api, entry, ending):
    _, method = api
    source = ending.join(("# runner mirrors", "", "https://archive.ubuntu.com/ubuntu/", entry, ""))
    with pytest.raises(ValueError, match="unsupported runner Ubuntu mirror entry") as error:
        method.rewrite_mirrors(source)
    message = str(error.value)
    prefix = "unsupported runner Ubuntu mirror entry "
    assert message.startswith(prefix)
    assert len(message.splitlines()) == 1
    assert len(message.encode()) <= 2048
    assert json.loads(message.removeprefix(prefix)) == {
        "line": 4,
        "length": len(entry),
        "entry": entry,
    }


@pytest.mark.parametrize(
    "entry",
    [
        "https://fixture-user:fixture-secret@mirror.example.net/ubuntu/",
        "https://mirror.example.net/ubuntu/?token=fixture-secret",
        "https://mirror.example.net/ubuntu/#fixture-secret",
        "https://mirror.example.net/ubuntu/\tfixture-secret",
        "https://mirror.example.net/ubuntu/\tpriority:fixture-secret",
        "https://mirror.example.net/ubuntu/\tpriority:1000000",
        "                 https://mirror.example.net/ubuntu/",
        "https://mirror.example.net/ubuntu/\x00fixture-secret",
        "https://mirror.example.net/ubuntu/\x1b[31mfixture-secret",
        "https://mirror.example.net/ubuntu/\u202efixture-secret",
        "https://mírror.example.net/ubuntu/",
        "https://mirror.example.net:443/ubuntu/",
        "https://[::1]/ubuntu/",
        "https://-mirror.example.net/ubuntu/",
        "https://mirror..example.net/ubuntu/",
        "https://" + "x" * 64 + ".example.net/ubuntu/",
        "https://" + ".".join(["x" * 63] * 4) + "/ubuntu/",
        "https://mirror.example.net/private-fixture-secret/",
        "https:///ubuntu/fixture-secret",
        "::error::fixture-secret",
        "https://mirror.example.net/ubuntu/ " + "9" * 4096,
        "https://mirror.example.net/ubuntu/\tpriority:" + "9" * 4096,
    ],
)
def test_rejected_unsafe_mirror_diagnostic_redacts_entire_entry(api, entry):
    _, method = api
    source = "https://archive.ubuntu.com/ubuntu/\n" + entry + "\n"
    with pytest.raises(ValueError, match="unsupported runner Ubuntu mirror entry") as error:
        method.rewrite_mirrors(source)
    message = str(error.value)
    prefix = "unsupported runner Ubuntu mirror entry "
    assert message.startswith(prefix)
    assert len(message.splitlines()) == 1
    assert len(message.encode()) <= 2048
    assert json.loads(message.removeprefix(prefix)) == {
        "line": 2,
        "length": len(entry),
        "entry": "<redacted>",
    }
    assert "fixture-secret" not in message
    assert "mirror.example.net" not in message


@pytest.mark.parametrize("existing_installation", [False, True])
def test_rejected_mirror_configuration_preserves_all_files(api, tmp_path, existing_installation):
    _, method = api
    apt = tmp_path / "apt"
    (apt / "sources.list.d").mkdir(parents=True)
    (apt / "apt.conf.d").mkdir()
    methods = tmp_path / "methods"
    methods.mkdir()
    (apt / "apt-mirrors.txt").write_text(
        "# runner mirrors\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n"
        "https://security.ubuntu.com/ubuntu/\tpriority:3\n"
        "https://mirror.example.net/ubuntu/\tpriority:4\n"
    )
    (apt / "sources.list.d/ubuntu.sources").write_text(
        "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: resolute\n"
        "Components: main\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
    )
    installation = tmp_path / "installed"
    if existing_installation:
        installation.mkdir(mode=0o755)
        for path in (
            installation / "ci_apt_method.py",
            installation / "ci_apt_acquisition.py",
            methods / method.METHOD,
            apt / "apt.conf.d/99sharecut-acquisition",
        ):
            path.write_bytes(b"existing configuration\n")
            path.chmod(0o600)
    before = {
        path.relative_to(tmp_path): (
            path.stat().st_mode,
            path.read_bytes() if path.is_file() else None,
        )
        for path in tmp_path.rglob("*")
    }
    with pytest.raises(ValueError, match="unsupported runner Ubuntu mirror entry") as error:
        method.configure(apt, installation, methods)
    after = {
        path.relative_to(tmp_path): (
            path.stat().st_mode,
            path.read_bytes() if path.is_file() else None,
        )
        for path in tmp_path.rglob("*")
    }
    assert after == before
    prefix = "unsupported runner Ubuntu mirror entry "
    assert str(error.value).startswith(prefix)
    assert json.loads(str(error.value).removeprefix(prefix)) == {
        "line": 4,
        "length": len("https://mirror.example.net/ubuntu/\tpriority:4"),
        "entry": "https://mirror.example.net/ubuntu/\tpriority:4",
    }


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


def test_failure_diagnostics_include_bounded_network_fields(api, endpoint, tmp_path, capsys):
    import json

    transport, _ = api
    base, state = endpoint
    state.update(primary="absent", secondary="absent")
    identity = transport.HashedObject(1, "0" * 64)
    plan = transport.FetchPlan(
        identity, (base + "/primary", base + "/secondary"), budgets(transport)
    )
    with pytest.raises(RuntimeError):
        transport.acquire(plan, tmp_path / "absent")
    events = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert len(events) == 2
    assert {event["source"] for event in events} == {0, 1}
    assert all(
        event["outcome"] == "http-failure"
        and event["http_status"] == 404
        and event["remote_ip"] == "127.0.0.1"
        and event["budget"] == 1.5
        for event in events
    )
    assert all(
        set(event)
        == {
            "host",
            "path",
            "source",
            "outcome",
            "bytes",
            "elapsed",
            "budget",
            "curl_exit",
            "http_status",
            "remote_ip",
            "kind",
        }
        for event in events
    )


@pytest.mark.parametrize(
    "source",
    [
        "URIs: https://archive.ubuntu.com/ubuntu-lookalike\nSuites: resolute\nComponents: main\n",
        "URIs: http://archive.ubuntu.com/ubuntu/\nSuites: resolute\nComponents: main\n",
        "URIs: https://other.example/ubuntu/\nSuites: resolute\nComponents: main\n",
        "URIs: https://archive.ubuntu.com/ubuntu/\nSuites: future\nComponents: main\n",
    ],
)
def test_unsupported_runner_sources_fail_before_rewrite(api, source):
    _, method = api
    with pytest.raises(ValueError):
        method.rewrite_sources(source)


@pytest.mark.parametrize(
    "message",
    [
        "600 URI Acquire\nURI: x\x00y\n\n",
        "600 URI Acquire\nURI: " + "é" * 32768 + "\n\n",
        "600 URI Acquire\n" + "".join(f"Field{i}: value\n" for i in range(129)) + "\n",
    ],
)
def test_control_characters_and_encoded_message_bounds(api, message):
    _, method = api
    with pytest.raises(ValueError):
        method.read_message(io.StringIO(message))


def test_healthy_metadata_never_starts_the_secondary(api, endpoint, tmp_path, monkeypatch):
    transport, _ = api
    base, state = endpoint
    launched = []
    popen = transport.subprocess.Popen

    def start(*args, **kwargs):
        process = popen(*args, **kwargs)
        launched.append(process)
        return process

    monkeypatch.setattr(transport.subprocess, "Popen", start)
    monkeypatch.setattr(transport.time, "sleep", lambda _seconds: launched[0].wait())
    plan = transport.FetchPlan(
        transport.AptSignedMetadata(1024),
        (base + "/primary", base + "/secondary"),
        budgets(transport),
    )
    assert transport.acquire(plan, tmp_path / "InRelease").source == 0
    assert len(launched) == 1
    assert state["requests"] == ["primary"]


@pytest.mark.parametrize("interrupt", ["SIGTERM", "SIGINT"])
def test_cancellation_during_child_registration_reaps_the_child(endpoint, tmp_path, interrupt):
    base, state = endpoint
    state.update(primary="slow", secondary="slow")
    code = """import os,signal,sys
from pathlib import Path
import ci_apt_acquisition as transport
from ci_apt_method import cancelled
source=Path(transport.__file__)
line=next(i for i,text in enumerate(source.read_text().splitlines(),1) if "attempts.append(Attempt(process, path))" in text)
observed=[]
signal.signal(getattr(signal,sys.argv[3]),cancelled)
def inject(frame,event,arg):
    if event=="line" and frame.f_code.co_filename==str(source) and frame.f_lineno==line:
        sys.settrace(None)
        observed.append(frame.f_locals["process"])
        os.kill(os.getpid(),getattr(signal,sys.argv[3]))
    return inject
try:
    sys.settrace(inject)
    transport.acquire(transport.FetchPlan(transport.AptSignedMetadata(1024),(sys.argv[1]+"/primary",sys.argv[1]+"/secondary")),Path(sys.argv[2]))
except SystemExit:
    assert observed and observed[0].poll() is not None, "curl survived cancellation before registration"
    assert not Path(sys.argv[2]).exists()
finally:
    sys.settrace(None)
    for child in observed:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=3)
"""
    result = subprocess.run(
        [sys.executable, "-c", code, base, str(tmp_path / "InRelease"), interrupt],
        cwd=SCRIPTS,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert not list(tmp_path.glob(".sharecut-apt-*"))


def test_failed_process_creation_restores_cancellation_handlers(api, tmp_path, monkeypatch):
    transport, _ = api
    previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}

    def failed_start(*_args, **_kwargs):
        raise OSError("fixture process creation failed")

    monkeypatch.setattr(transport.subprocess, "Popen", failed_start)
    plan = transport.FetchPlan(
        transport.AptSignedMetadata(1024),
        ("https://archive.ubuntu.com/ubuntu/dists/resolute/InRelease",) * 2,
    )
    with pytest.raises(OSError, match="fixture process creation failed"):
        transport.acquire(plan, tmp_path / "InRelease")
    assert all(signal.getsignal(number) == handler for number, handler in previous.items())
    assert not list(tmp_path.glob(".sharecut-apt-*"))


@pytest.mark.parametrize("interrupt", ["SIGTERM", "SIGINT"])
def test_cancellation_before_loser_cleanup_reaps_all_children(endpoint, tmp_path, interrupt):
    base, state = endpoint
    state.update(primary="hedged", secondary="slow")
    code = """import hashlib,os,signal,sys
from pathlib import Path
import ci_apt_acquisition as transport
from ci_apt_method import cancelled
source=Path(transport.__file__)
line=next(i for i,text in enumerate(source.read_text().splitlines(),1) if "attempt.process.terminate()" in text)
observed=[]
signal.signal(getattr(signal,sys.argv[3]),cancelled)
def inject(frame,event,arg):
    if event=="line" and frame.f_code.co_filename==str(source) and frame.f_lineno==line:
        sys.settrace(None)
        observed.extend(a.process for a in frame.f_locals["attempts"])
        assert any(child.poll() is None for child in observed)
        os.kill(os.getpid(),getattr(signal,sys.argv[3]))
    return inject
try:
    sys.settrace(inject)
    plan=transport.FetchPlan(transport.HashedObject(int(sys.argv[4]),sys.argv[5]),(sys.argv[1]+"/primary",sys.argv[1]+"/secondary"),transport.Budgets(hedge=0))
    transport.acquire(plan,Path(sys.argv[2]))
except SystemExit:
    assert observed and all(child.poll() is not None for child in observed), "curl survived cancellation before loser cleanup"
    assert hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest()==sys.argv[5]
finally:
    sys.settrace(None)
    for child in observed:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=3)
"""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            code,
            base,
            str(tmp_path / "package.deb"),
            interrupt,
            str(len(state["body"])),
            hashlib.sha256(state["body"]).hexdigest(),
        ],
        cwd=SCRIPTS,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert not list(tmp_path.glob(".sharecut-apt-*"))
