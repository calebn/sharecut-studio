from __future__ import annotations

import http.client
import io
import json
import runpy
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from podcast_mcp.util import asset_sources

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_bootstrap_mirror.py"
SHA = "a" * 40


class Response(io.BytesIO):
    status = 200

    def __init__(self, payload=b"", status=200, *, head=False):
        super().__init__(payload)
        self.status = status
        self.head = head
        self.read_sizes = []

    def read(self, size=-1):
        assert not self.head, "HEAD must not read the body"
        self.read_sizes.append(size)
        return super().read(size)


@pytest.fixture
def checker():
    return runpy.run_path(str(SCRIPT))


@pytest.fixture
def manifest():
    return {
        "assets": {
            "http": {
                "kind": "http",
                "cdn_prefix": "models/http",
                "url": "https://upstream.example/file.bin",
            },
            "hf": {
                "kind": "huggingface",
                "cdn_prefix": "models/hf",
                "repo": "owner/model",
                "revision": "refs/pr/1",
            },
        }
    }


def install_opener(monkeypatch, *, payload=None, failure=None, status=200):
    requests = []
    responses = []

    class Opener:
        def open(self, request, *, timeout):
            requests.append((request, timeout))
            if failure is not None:
                raise failure
            data = (
                payload
                if payload is not None
                else json.dumps(
                    {
                        "sha": SHA,
                        "siblings": [{"rfilename": "model.bin"}, {"rfilename": ".gitattributes"}],
                    }
                ).encode()
            )
            response = Response(data, status, head=request.get_method() == "HEAD")
            responses.append(response)
            return response

    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: Opener())
    return requests, responses


def run(
    checker, monkeypatch, tmp_path, manifest, *, base="https://cdn.example/bootstrap", extra=()
):
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    monkeypatch.setattr(
        sys, "argv", [str(SCRIPT), "--base-url", base, "--manifest", str(path), *extra]
    )
    return checker["main"]()


def test_mixed_complete_plan(checker, monkeypatch, tmp_path, manifest, capsys):
    calls, responses = install_opener(monkeypatch)
    assert run(checker, monkeypatch, tmp_path, manifest) == 0
    assert [(r.get_method(), r.full_url) for r, _ in calls] == [
        ("GET", "https://huggingface.co/api/models/owner/model/revision/refs%2Fpr%2F1"),
        ("HEAD", "https://cdn.example/bootstrap/models/http/file.bin"),
        ("HEAD", "https://cdn.example/bootstrap/models/hf/.gitattributes"),
        ("HEAD", "https://cdn.example/bootstrap/models/hf/model.bin"),
    ]
    assert all(timeout == 10 for _, timeout in calls)
    assert all(not request.header_items() for request, _ in calls)
    assert all(response.closed for response in responses)
    assert responses[0].read_sizes == [262145]
    output = capsys.readouterr().out
    assert f"revision asset=hf sha={SHA}" in output
    assert "checked=3 available=3 unavailable=0 integrity=unverified" in output


@pytest.mark.parametrize(
    "base",
    [
        "http://cdn.example",
        "https://secret@cdn.example",
        "https://cdn.example?token=secret",
        "https://cdn.example/#secret",
        "https://localhost",
        "https://127.0.0.1",
        "https://localhost.",
        "https://169.254.169.254",
        "https://[::1]",
        "https://127.1",
        "https://cdn.example:bad",
        "https://cdn.example:",
        "https://cdn.example:0",
        "https://cdn.example/a/%2e%2e",
        "https://cdn.example/a%2Fb",
        "https://cdn.example/../escape",
        "https://cdn.example/a\\b",
        "https://cdn.example/\nsecret",
        "https://cdn.example/a//b",
        "https://cdn.example/%252e",
    ],
)
def test_base_guard_before_any_request(checker, monkeypatch, tmp_path, manifest, base, capsys):
    calls, _ = install_opener(monkeypatch)
    assert run(checker, monkeypatch, tmp_path, manifest, base=base) == 2
    assert calls == []
    assert "secret" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "field,value",
    [
        ("kind", "unknown"),
        ("cdn_prefix", "../escape"),
        ("cdn_prefix", "/root"),
        ("cdn_prefix", "bad//path"),
        ("cdn_prefix", "bad%2fpath"),
        ("repo", "bad/repo/extra"),
        ("repo", "token@host/model"),
        ("revision", "../escape"),
        ("revision", "secret?token"),
    ],
)
def test_all_local_fields_validate_before_metadata(
    checker, monkeypatch, tmp_path, manifest, field, value
):
    calls, _ = install_opener(monkeypatch)
    manifest["assets"]["bad"] = {**manifest["assets"]["hf"], field: value}
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert calls == []


@pytest.mark.parametrize(
    "filename", ["../escape", "/escape", "a/b", "a%2fb", "a?token", "a#token", "a\\b", ""]
)
def test_invalid_http_filename(checker, monkeypatch, tmp_path, manifest, filename):
    calls, _ = install_opener(monkeypatch)
    manifest["assets"]["http"]["filename"] = filename
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert not calls


@pytest.mark.parametrize(
    "payload",
    [
        b"not json secret",
        b"\xff",
        b"[]",
        b"{}",
        b'{"sha": 1}',
        json.dumps({"sha": "no", "siblings": []}).encode(),
        json.dumps({"sha": SHA, "siblings": []}).encode(),
        json.dumps({"sha": SHA, "siblings": [{"rfilename": "../secret"}]}).encode(),
        json.dumps({"sha": SHA, "siblings": [None]}).encode(),
        json.dumps({"sha": SHA, "siblings": [{}]}).encode(),
        json.dumps({"sha": SHA, "siblings": [{"rfilename": "x"}, {"rfilename": "x"}]}).encode(),
        json.dumps({"sha": SHA, "siblings": [{"rfilename": str(i)} for i in range(65)]}).encode(),
        b"x" * 262145,
        ('{"sha":"' + SHA + '","sha":"' + SHA + '","siblings":[]}').encode(),
    ],
)
def test_metadata_failures_stop_all_heads(
    checker, monkeypatch, tmp_path, manifest, payload, capsys
):
    calls, responses = install_opener(monkeypatch, payload=payload)
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert [r.get_method() for r, _ in calls] == ["GET"]
    assert all(r.closed for r in responses)
    assert "secret" not in capsys.readouterr().out


def test_total_object_cap_and_duplicate_keys(checker, monkeypatch, tmp_path, manifest):
    payload = json.dumps(
        {"sha": SHA, "siblings": [{"rfilename": str(i)} for i in range(64)]}
    ).encode()
    calls, _ = install_opener(monkeypatch, payload=payload)
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert [r.get_method() for r, _ in calls] == ["GET"]
    manifest["assets"] = {"a": manifest["assets"]["http"], "b": manifest["assets"]["http"]}
    calls.clear()
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert not calls


@pytest.mark.parametrize("status", [201, 204, 299, 403, 404, 405, 500])
def test_head_status(checker, monkeypatch, tmp_path, manifest, status, capsys):
    manifest["assets"].pop("hf")
    _, responses = install_opener(monkeypatch, status=status)
    assert run(checker, monkeypatch, tmp_path, manifest) == (0 if status < 300 else 1)
    assert all(response.closed for response in responses)
    assert f"status={status}" in capsys.readouterr().out


@pytest.mark.parametrize(
    "failure", [TimeoutError("secret"), urllib.error.URLError("secret"), OSError("secret")]
)
def test_safe_transport_failure(checker, monkeypatch, tmp_path, manifest, failure, capsys):
    install_opener(monkeypatch, failure=failure)
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    manifest["assets"].pop("hf")
    assert run(checker, monkeypatch, tmp_path, manifest) == 1
    assert "secret" not in capsys.readouterr().out


@pytest.mark.parametrize("timeout", ["0", "-1", "nan", "inf", "61", "secret"])
def test_invalid_timeout(checker, monkeypatch, tmp_path, manifest, timeout):
    calls, _ = install_opener(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        run(checker, monkeypatch, tmp_path, manifest, extra=("--timeout", timeout))
    assert exc.value.code == 2
    assert not calls


@pytest.mark.parametrize("flag", ["--upload", "--out-dir"])
def test_no_write_modes(checker, monkeypatch, tmp_path, manifest, flag):
    calls, _ = install_opener(monkeypatch)
    with pytest.raises(SystemExit):
        run(checker, monkeypatch, tmp_path, manifest, extra=(flag,))
    assert not calls


def test_checked_in_manifest_uses_declared_repos(checker, monkeypatch, tmp_path):
    manifest = json.loads((SCRIPT.parents[1] / "contracts/bootstrap-assets.json").read_text())
    calls, _ = install_opener(monkeypatch)
    assert run(checker, monkeypatch, tmp_path, manifest) == 0
    gets = [r.full_url for r, _ in calls if r.get_method() == "GET"]
    assert gets == [
        f"https://huggingface.co/api/models/{entry['repo']}/revision/{entry['revision']}"
        for entry in manifest["assets"].values()
        if entry["kind"] == "huggingface"
    ]
    assert len([r for r, _ in calls if r.get_method() == "HEAD"]) == 6


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
@pytest.mark.parametrize("location", ["https://[", None, "https://signed.example/?token=secret"])
def test_redirect_refused_and_response_closed(monkeypatch, status, location):
    response = Response(b"secret", head=True)
    opener = urllib.request.build_opener(asset_sources._RefusePublicRedirects)
    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: opener)
    request = urllib.request.Request("https://cdn.example/file", method="HEAD")

    def perform_open(req, *, timeout):
        assert req.get_method() == "HEAD"
        assert timeout == 10
        return opener.error(
            "http",
            req,
            response,
            status,
            "secret",
            {"location": location} if location is not None else {},
        )

    monkeypatch.setattr(opener, "open", perform_open)
    with pytest.raises(asset_sources.PublicRequestError, match=r"^redirect$"):
        with asset_sources.public_request(request.full_url, method="HEAD", timeout=10):
            pytest.fail("redirect must fail")
    assert response.closed


def test_http_error_closes_response(monkeypatch):
    body = Response(b"secret")
    error = urllib.error.HTTPError("https://secret", 403, "secret", {}, body)
    install_opener(monkeypatch, failure=error)
    with pytest.raises(asset_sources.PublicRequestError) as exc:
        with asset_sources.public_request("https://cdn.example/file", method="HEAD", timeout=10):
            pytest.fail("HTTP error must fail")
    assert exc.value.status == 403
    assert str(exc.value) == "http_status"
    assert body.closed


def test_skips_assets_without_mirror_prefix(checker, monkeypatch, tmp_path, manifest, capsys):
    calls, _ = install_opener(monkeypatch)
    manifest["assets"]["unmirrored"] = {"kind": "unsupported"}
    assert run(checker, monkeypatch, tmp_path, manifest) == 0
    assert len(calls) == 4
    assert "unmirrored" not in capsys.readouterr().out
    manifest["assets"] = {"unmirrored": {"kind": "unsupported"}}
    calls.clear()
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert not calls


def test_explicit_filename_needs_no_upstream(checker, monkeypatch, tmp_path, manifest):
    calls, _ = install_opener(monkeypatch)
    manifest["assets"] = {
        "http": {
            "kind": "http",
            "cdn_prefix": "models/http",
            "filename": "file.bin",
            "url": "unused secret-like upstream",
        }
    }
    assert run(checker, monkeypatch, tmp_path, manifest) == 0
    assert [r.full_url for r, _ in calls] == ["https://cdn.example/bootstrap/models/http/file.bin"]
    manifest["assets"]["http"].pop("url")
    assert run(checker, monkeypatch, tmp_path, manifest) == 0


def test_nested_and_oversize_manifest(checker, monkeypatch, tmp_path, capsys):
    calls, _ = install_opener(monkeypatch)
    path = tmp_path / "manifest.json"
    monkeypatch.setattr(
        sys, "argv", [str(SCRIPT), "--base-url", "https://cdn.example", "--manifest", str(path)]
    )
    for payload in [b"[" * 2000 + b"]" * 2000, b"x" * 262145, b'{"assets":{},"assets":{}}']:
        path.write_bytes(payload)
        assert checker["main"]() == 2
    assert not calls
    assert "Traceback" not in capsys.readouterr().out


def test_nested_metadata_and_non_200(checker, monkeypatch, tmp_path, manifest):
    calls, responses = install_opener(monkeypatch, payload=b"[" * 2000 + b"]" * 2000)
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert [r.get_method() for r, _ in calls] == ["GET"]
    assert all(response.closed for response in responses)
    calls, responses = install_opener(monkeypatch, status=204)
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert [r.get_method() for r, _ in calls] == ["GET"]
    assert all(response.closed for response in responses)


def test_metadata_timeout_closes_response(checker, monkeypatch, tmp_path, manifest, capsys):
    calls, responses = install_opener(monkeypatch)
    monkeypatch.setattr(
        Response, "read", lambda *args: (_ for _ in ()).throw(TimeoutError("secret"))
    )
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert [r.get_method() for r, _ in calls] == ["GET"]
    assert all(response.closed for response in responses)
    assert "secret" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "manifest",
    [
        None,
        [],
        {},
        {"assets": []},
        {"assets": {}},
        {"assets": {"bad id": {}}},
        {"assets": {"ok": None}},
    ],
)
def test_malformed_manifest(checker, monkeypatch, tmp_path, manifest):
    calls, _ = install_opener(monkeypatch)
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert not calls


def test_missing_manifest_and_base(checker, monkeypatch, tmp_path):
    calls, _ = install_opener(monkeypatch)
    monkeypatch.setattr(
        sys,
        "argv",
        [str(SCRIPT), "--base-url", "https://cdn.example", "--manifest", str(tmp_path / "missing")],
    )
    assert checker["main"]() == 2
    monkeypatch.setattr(sys, "argv", [str(SCRIPT)])
    with pytest.raises(SystemExit):
        checker["main"]()
    assert not calls


def test_metadata_access_error_names_asset_and_status(
    checker, monkeypatch, tmp_path, manifest, capsys
):
    calls, _ = install_opener(
        monkeypatch,
        failure=urllib.error.HTTPError("https://secret", 401, "secret", {}, Response(b"secret")),
    )
    assert run(checker, monkeypatch, tmp_path, manifest) == 2
    assert [r.get_method() for r, _ in calls] == ["GET"]
    output = capsys.readouterr().out
    assert "inventory asset=hf status=401 error=http_status" in output
    assert "checked=0" in output
    assert "secret" not in output


def test_checker_never_resolves_application_credentials(checker, monkeypatch, tmp_path, manifest):
    import netrc

    def fail(*args, **kwargs):
        pytest.fail("checker must not load application settings or credentials")

    monkeypatch.setattr(asset_sources.settings, "text", fail)
    monkeypatch.setattr(asset_sources, "bootstrap_cdn_base", fail)
    monkeypatch.setattr(netrc, "netrc", fail)
    monkeypatch.setenv("HF_TOKEN", "sentinel-unused")
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "sentinel-unused")
    calls, _ = install_opener(monkeypatch)
    assert run(checker, monkeypatch, tmp_path, manifest, extra=("--timeout", "0.5")) == 0
    assert all(timeout == 0.5 for _, timeout in calls)
    assert all(not req.header_items() for req, _ in calls)


@pytest.mark.parametrize("metadata", [True, False])
def test_stdlib_protocol_failures_are_sanitized_and_closed(
    checker, monkeypatch, tmp_path, manifest, capsys, metadata
):
    wire = (
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n"
        if metadata
        else b"status-line-secret\r\n"
    )
    stream = io.BytesIO(wire)
    calls = []
    responses = []

    class Socket:
        def makefile(self, *args, **kwargs):
            return stream

    class Opener:
        def open(self, request, *, timeout):
            calls.append(request.get_method())
            response = http.client.HTTPResponse(Socket(), method=request.get_method())
            responses.append(response)
            response.begin()
            return response

    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: Opener())
    manifest["assets"].pop("http" if metadata else "hf")
    assert run(checker, monkeypatch, tmp_path, manifest) == (2 if metadata else 1)
    assert calls == ["GET" if metadata else "HEAD"]
    assert stream.closed
    assert all(response.isclosed() for response in responses)
    output = capsys.readouterr()
    assert "secret" not in output.out + output.err
    assert "Traceback" not in output.out + output.err
    assert "error=transport" in output.out
    assert ("inventory asset=hf status=none" if metadata else "asset=http") in output.out
    assert ("checked=0" if metadata else "checked=1") in output.out


@pytest.mark.parametrize("location", ["https://[", None, "https://signed.example/?token=secret"])
def test_redirect_cli_output_is_sanitized(
    checker, monkeypatch, tmp_path, manifest, capsys, location
):
    response = Response(b"payload-secret", head=True)
    opener = urllib.request.build_opener(asset_sources._RefusePublicRedirects)

    def perform_open(request, *, timeout):
        assert request.get_method() == "HEAD"
        return opener.error(
            "http",
            request,
            response,
            302,
            "secret",
            {"location": location} if location is not None else {},
        )

    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: opener)
    monkeypatch.setattr(opener, "open", perform_open)
    manifest["assets"].pop("hf")
    assert run(checker, monkeypatch, tmp_path, manifest) == 1
    assert response.closed
    output = capsys.readouterr()
    assert "status=302 error=redirect" in output.out
    assert "secret" not in output.out + output.err
    assert "Traceback" not in output.out + output.err
