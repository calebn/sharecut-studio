from __future__ import annotations

import json
import logging
import os
import re
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from filelock import Timeout
from pydantic import BaseModel, ValidationError

from podcast_mcp.gui.routes import diagnostics as diagnostics_route
from podcast_mcp.gui.server import create_app
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.support import diagnostics as diagnostics_mod
from podcast_mcp.services.support.diagnostics import NOT_OPENED_STATEMENT as STATEMENT
from podcast_mcp.services.support.doctor import DoctorReport

BASE_KEYS = [
    "app_version",
    "bootstrap",
    "created_at",
    "disk_free_bytes",
    "doctor",
    "env",
    "ffmpeg",
    "gpu",
    "gui_dist_present",
    "hardware",
    "jobs",
    "os",
    "project",
    "python",
    "whisper",
]


@pytest.fixture
def bundle_env(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.run_doctor_checks",
        lambda _p=None: DoctorReport(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.component_status",
        lambda: {"ready": True, "models": [], "tools": {}},
    )
    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.ffmpeg_probe_info",
        lambda: {"ffmpeg": {"ok": True}, "ffprobe": {"ok": True}},
    )
    out = tmp_path / "out"
    for target in (
        "podcast_mcp.gui.routes.diagnostics.default_bundle_dir",
        "podcast_mcp.services.support.diagnostics.default_bundle_dir",
    ):
        monkeypatch.setattr(target, lambda: out)
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [])
    return out


def _break(project_file: Path, state: str) -> None:
    if state == "truncated":
        project_file.write_bytes(project_file.read_bytes()[:150])
        return
    if state == "renamed":
        project_file.parent.rename(project_file.parent.with_name("moved-away"))
        return
    data = json.loads(project_file.read_text())
    data["version"] = {"newer": "99.0", "unsupported": "two"}[state]
    project_file.write_text(json.dumps(data))


CODES = {
    "newer": "project_version_newer",
    "unsupported": "project_version_unsupported",
    "truncated": "project_unreadable",
    "renamed": "project_not_found",
}


def _members(path: str) -> dict[str, str]:
    with zipfile.ZipFile(path) as zf:
        return {name: zf.read(name).decode() for name in zf.namelist()}


def _client(project_file: Path, jobs=None) -> TestClient:
    app = create_app(served_project=project_file)
    app.state.jobs = jobs
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("state", list(CODES))
def test_an_episode_that_will_not_open_still_gets_a_bundle(minimal_project, bundle_env, state):
    folder = str(minimal_project.parent)
    _break(minimal_project, state)
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    assert response.json()["files"] == ["report.json", "README.txt"]
    assert set(members) == {"report.json", "README.txt"}
    report = json.loads(members["report.json"])
    assert sorted(report) == sorted([*BASE_KEYS, "episode_not_opened"])
    assert report["project"] is None
    assert report["episode_not_opened"] == {"code": CODES[state], "statement": STATEMENT}
    assert STATEMENT in members["README.txt"]
    for text in members.values():
        assert folder not in text
    assert "schema_version" not in members["report.json"]


@pytest.mark.parametrize("state", list(CODES))
def test_the_folder_is_still_redacted_in_jobs_and_logs_of_an_unopened_bundle(
    minimal_project, bundle_env, monkeypatch, tmp_path, state
):
    folder = str(minimal_project.parent)
    log = tmp_path / "state" / "sidecar.log"
    log.parent.mkdir()
    log.write_text(f"failed to open {folder}/episode.sharecut\n")
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [log])
    jobs = MagicMock()
    jobs.recent_snapshots.return_value = [
        {"kind": "pipeline", "status": "failed", "message": f"no audio under {folder}/raw"}
    ]
    _break(minimal_project, state)
    with _client(minimal_project, jobs) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    assert "<workspace>/episode.sharecut" in members["sidecar.log"]
    job = json.loads(members["report.json"])["jobs"][0]
    assert job["message"] == "no audio under <workspace>/raw"
    for text in members.values():
        assert folder not in text


def test_a_gone_folder_still_reports_free_space(minimal_project, bundle_env):
    _break(minimal_project, "renamed")
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    report = json.loads(_members(response.json()["path"])["report.json"])
    assert isinstance(report["disk_free_bytes"], int)


@pytest.mark.parametrize("version", ["99.31415", "unsup-zq77", "2.2.7.8.9.1"])
def test_the_format_value_is_in_no_member_and_the_readme_gains_one_sentence(
    minimal_project, bundle_env, version
):
    with _client(minimal_project) as client:
        healthy = _members(client.post("/api/diagnostics/bundle", json={}).json()["path"])
    data = json.loads(minimal_project.read_text())
    data["version"] = version
    minimal_project.write_text(json.dumps(data))
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    for name, text in members.items():
        assert version not in text, name
    assert members["README.txt"] == healthy["README.txt"] + f"\n{STATEMENT}\n"


def test_a_healthy_bundle_has_exactly_its_fifteen_keys_and_no_statement(
    minimal_project, bundle_env
):
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200
    members = _members(response.json()["path"])
    report = json.loads(members["report.json"])
    assert sorted(report) == BASE_KEYS
    assert report["project"]["schema_version"] == "2.2"
    assert STATEMENT not in members["README.txt"]


def test_a_missing_path_gets_a_bundle_only_when_it_is_the_served_project(
    minimal_project, bundle_env, tmp_path
):
    elsewhere = tmp_path / "elsewhere" / "episode.sharecut"
    _break(minimal_project, "renamed")
    with _client(minimal_project) as client:
        stranger = client.post("/api/diagnostics/bundle", json={"path": str(elsewhere)})
        assert stranger.status_code == 404
        assert stranger.headers["x-sharecut-error-code"] == "project_not_found"
        assert _no_bundle_written(bundle_env)
        served = client.post("/api/diagnostics/bundle", json={"path": str(minimal_project)})
    assert served.status_code == 200
    report = json.loads(_members(served.json()["path"])["report.json"])
    assert report["episode_not_opened"]["code"] == "project_not_found"


def _no_bundle_written(out: Path) -> bool:
    return not out.exists() or list(out.glob("*.zip")) == []


def test_a_real_episode_the_server_does_not_serve_gets_403_and_no_bundle(
    minimal_project, bundle_env, tmp_path
):
    other = tmp_path / "other" / "episode.sharecut"
    other.parent.mkdir()
    other.write_bytes(minimal_project.read_bytes())
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={"path": str(other)})
    assert response.status_code == 403
    assert response.headers["x-sharecut-error-code"] == "project_path_not_allowed"
    assert _no_bundle_written(bundle_env)


def test_an_invalid_path_gets_400_and_no_bundle(minimal_project, bundle_env):
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={"path": "bad\x00path"})
    assert response.status_code == 400
    assert response.headers["x-sharecut-error-code"] == "project_path_invalid"
    assert _no_bundle_written(bundle_env)


@pytest.mark.parametrize("state", ["newer", "truncated", "renamed"])
def test_who_may_export_is_unchanged_for_an_unopenable_episode(
    minimal_project, bundle_env, monkeypatch, state
):
    _break(minimal_project, state)
    with _client(minimal_project) as client:
        evil = client.post(
            "/api/diagnostics/bundle",
            json={},
            headers={"Host": "127.0.0.1:8765", "Origin": "https://evil.example"},
        )
    assert evil.status_code == 403
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setattr("podcast_mcp.gui.routes.deps.peer_host", lambda _request: "10.0.0.5")
    with _client(minimal_project) as client:
        remote = client.post("/api/diagnostics/bundle", json={})
    assert remote.status_code == 403
    assert _no_bundle_written(bundle_env)


def _lower_hex_escapes(encoded: str) -> str:
    return re.sub(r"%[0-9A-F]{2}", lambda m: m.group(0).lower(), encoded)


def test_the_percent_encoded_folder_in_a_server_log_line_is_replaced(
    minimal_project, bundle_env, monkeypatch, tmp_path
):
    folder = minimal_project.parent
    encoded = quote(str(minimal_project), safe="")
    # Only the hex digits of the escapes change case: lowercasing the whole line would
    # also change the folder's own letters and name a different path.
    lower_hex = _lower_hex_escapes(encoded)
    log = tmp_path / "state" / "sidecar.log"
    log.parent.mkdir()
    log.write_text(
        f'INFO:     127.0.0.1:34074 - "WebSocket /api/host/ws?path={encoded}&client_id=v" 403\n'
        f'INFO:     127.0.0.1:34075 - "GET /api/document/state?path={lower_hex} HTTP/1.1" 400\n'
    )
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [log])
    for state in ("healthy", "newer"):
        if state == "newer":
            _break(minimal_project, state)
        with _client(minimal_project) as client:
            response = client.post("/api/diagnostics/bundle", json={})
        assert response.status_code == 200, response.text
        members = _members(response.json()["path"])
        assert "path=<workspace>%2Fepisode.sharecut&client_id=v" in members["sidecar.log"]
        for text in members.values():
            assert str(folder) not in text
            assert folder.name not in text
            assert quote(str(folder), safe="") not in text
            assert _lower_hex_escapes(quote(str(folder), safe="")) not in text


class _Rows(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.texts: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.texts.append(self.format(record))


def _wrong_shape(project_file: Path) -> None:
    """Valid JSON that is not a project: a marker sits in each field that fails validation."""
    data = json.loads(project_file.read_text())
    data["meta"]["name"] = {"v": MARKERS["name"]}
    data["timeline"]["tracks"] = [{"id": {"v": MARKERS["track"]}, "name": [MARKERS["track"]]}]
    data["timeline"]["clips"] = [{"id": [MARKERS["clip"]], "start": MARKERS["clip"]}]
    data["transcripts"]["per_track"] = [
        {"track_id": "t", "words": [{"text": {"v": MARKERS["word"]}, "start": MARKERS["word"]}]}
    ]
    data["meta"]["ingest_alignment"] = {MARKERS["key"]: {"align_method": 7}}
    data.setdefault("editorial", {})["session_suggestions"] = [
        {"track_follows": {MARKERS["key"]: [7]}}
    ]
    project_file.write_text(json.dumps(data))


MARKERS = {
    "key": "ZQKEY85",
    "name": "ZQNAME81",
    "track": "ZQTRACK82",
    "word": "ZQWORD83",
    "clip": "ZQCLIP84",
}


def test_a_guest_mcp_call_on_a_damaged_episode_leaves_none_of_it_in_the_bundle(
    minimal_project, published_share, bundle_env, monkeypatch, tmp_path
):
    with write_grant(WriteGrantKind.DISPATCHER):
        token = published_share()[2]["token"]
    _wrong_shape(minimal_project)
    log = tmp_path / "state" / "sidecar.log"
    log.parent.mkdir()
    handler = logging.FileHandler(log)
    handler.setLevel(logging.WARNING)
    logging.getLogger().addHandler(handler)
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [log])
    try:
        with _client(minimal_project) as client:
            guest = client.post(
                f"/mcp/{token}/mcp",
                headers={"Accept": "application/json, text/event-stream"},
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            )
            handler.flush()
            assert any(m in log.read_text() for m in ("Resolving a guest MCP share", "Field")), (
                guest.text
            )
            response = client.post("/api/diagnostics/bundle", json={})
    finally:
        logging.getLogger().removeHandler(handler)
        handler.close()
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    assert "sidecar.log" in members
    folder = minimal_project.parent
    for name, text in members.items():
        for marker in MARKERS.values():
            assert marker not in text, (name, marker)
        assert str(folder) not in text
        assert folder.name not in text


def test_no_route_logs_the_content_of_a_damaged_episode(
    minimal_project, published_share, bundle_env
):
    with write_grant(WriteGrantKind.DISPATCHER):
        token = published_share()[2]["token"]
    _wrong_shape(minimal_project)
    rows = _Rows()
    rows.setFormatter(logging.Formatter("%(message)s"))
    logging.getLogger().addHandler(rows)
    fill = {"token": token, "path": str(minimal_project)}
    try:
        for served in (None, minimal_project):
            app = create_app(served_project=served)
            client = TestClient(app, raise_server_exceptions=False)
            for route, operations in app.openapi()["paths"].items():
                if "shutdown" in route:
                    continue
                url = re.sub(r"\{(\w+)(:\w+)?\}", lambda m: fill.get(m.group(1), "x1"), route)
                for method in operations:
                    if method.upper() not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                        continue
                    client.request(
                        method.upper(),
                        url,
                        params={"phase": "shell", "path": str(minimal_project)},
                        json=None if method.upper() == "GET" else {},
                    )
            for guest_url in (f"/mcp/{token}/mcp", f"/r/{token}/mcp"):
                client.post(
                    guest_url,
                    headers={"Accept": "application/json, text/event-stream"},
                    json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                )
    finally:
        logging.getLogger().removeHandler(rows)
    assert rows.texts
    for text in rows.texts:
        for marker in MARKERS.values():
            assert marker not in text, text[:300]


def _history_index(project_file: Path) -> None:
    index = project_file.parent / "history" / "index.json"
    index.parent.mkdir(exist_ok=True)
    index.write_text("{not json " + MARKERS["name"])


def _unreadable_mode(project_file: Path) -> None:
    project_file.chmod(0)


def _deeply_nested(project_file: Path) -> None:
    project_file.write_text("[" * 100000 + MARKERS["name"])


def _long_integer(project_file: Path) -> None:
    project_file.write_text('{"version": ' + "7" * 5000 + ', "meta": {}}')


@pytest.mark.parametrize(
    "damage",
    [_history_index, _unreadable_mode, _deeply_nested, _long_integer],
)
def test_any_failure_to_open_the_episode_still_gets_a_bundle(minimal_project, bundle_env, damage):
    if damage is _unreadable_mode and os.geteuid() == 0:
        pytest.skip("root reads a file whatever its mode bits")
    folder = str(minimal_project.parent)
    damage(minimal_project)
    try:
        with _client(minimal_project) as client:
            response = client.post("/api/diagnostics/bundle", json={})
    finally:
        minimal_project.chmod(0o644)
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    report = json.loads(members["report.json"])
    assert report["project"] is None
    code = report["episode_not_opened"]["code"]
    assert re.fullmatch(r"[a-z][a-z0-9_]{2,63}", code), code
    for text in members.values():
        assert folder not in text
        assert MARKERS["name"] not in text
        assert "7777777" not in text


def test_a_busy_episode_gets_a_bundle_without_it(minimal_project, bundle_env, monkeypatch):
    def busy(_path):
        raise Timeout(str(minimal_project) + ".lock")

    monkeypatch.setattr("podcast_mcp.gui.routes.diagnostics.ProjectWorkspace.open", busy)
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    assert json.loads(members["report.json"])["episode_not_opened"]["code"] == "project_busy"
    for text in members.values():
        assert str(minimal_project.parent) not in text


def test_an_interrupt_is_not_swallowed_by_the_export(minimal_project, monkeypatch):
    def interrupted(_path):
        raise KeyboardInterrupt

    monkeypatch.setattr("podcast_mcp.gui.routes.diagnostics.resolve_project", lambda p, r: Path(p))
    monkeypatch.setattr("podcast_mcp.gui.routes.diagnostics.ProjectWorkspace.open", interrupted)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(served_project=None)))
    with pytest.raises(KeyboardInterrupt):
        diagnostics_route._load_project(request, str(minimal_project))


def test_the_statement_says_what_is_provable():
    assert STATEMENT == (
        "The episode could not be opened, so this report has no project counts. "
        "Job messages and log tails are sanitized, as in every report."
    )


def test_a_speaker_name_in_a_damaged_dict_does_not_reach_the_bundle_through_a_guest_call(
    minimal_project, published_share, bundle_env, monkeypatch, tmp_path
):
    with write_grant(WriteGrantKind.DISPATCHER):
        token = published_share()[2]["token"]
    data = json.loads(minimal_project.read_text())
    speaker = "ZQSPEAKER9182 Quimby"
    data["meta"]["ingest_alignment"] = {speaker: {"align_method": 7}}
    minimal_project.write_text(json.dumps(data))
    log = tmp_path / "state" / "sidecar.log"
    log.parent.mkdir()
    handler = logging.FileHandler(log)
    handler.setLevel(logging.WARNING)
    logging.getLogger().addHandler(handler)
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [log])
    try:
        with _client(minimal_project) as client:
            client.post(
                f"/mcp/{token}/mcp",
                headers={"Accept": "application/json, text/event-stream"},
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            )
            handler.flush()
            assert "Resolving a guest MCP share" in log.read_text()
            response = client.post("/api/diagnostics/bundle", json={})
    finally:
        logging.getLogger().removeHandler(handler)
        handler.close()
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    assert "sidecar.log" in members
    for name, text in members.items():
        assert "ZQSPEAKER9182" not in text, name
        assert "Quimby" not in text, name


def test_a_log_written_before_the_fix_is_masked_at_the_bundle(
    minimal_project, bundle_env, monkeypatch, tmp_path
):
    log = tmp_path / "state" / "sidecar.log"
    log.parent.mkdir()
    log.write_text(
        "1 validation error for EpisodeProject\n"
        "meta.ingest_alignment.ZQOLD771 Quimby.align_method\n"
        "  Input should be a valid string [type=string_type]\n"
        "    For further information visit https://errors.pydantic.dev/2.14/v/string_type\n"
        "ProjectUnreadableError: The project file is damaged and could not be read "
        "(unexpected contents at meta.ingest_alignment.ZQOLD771 Quimby.align_method). "
        "Restore it from a backup, or open a copy of the project.\n"
    )
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [log])
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    members = _members(response.json()["path"])
    assert "ZQOLD771" not in members["sidecar.log"]
    assert "meta.ingest_alignment.*" in members["sidecar.log"]
    assert "align_method" in members["sidecar.log"]


def test_another_model_validation_error_in_the_log_holds_no_value_in_the_bundle(
    minimal_project, bundle_env, monkeypatch, tmp_path
):
    # ProjectHistory does not hide its input, so only the bundle's rule keeps the value out.
    from pydantic import ValidationError

    from podcast_mcp.models.episode import ProjectHistory

    marker = "ZQHIST" + "6612"  # not spelled out: a traceback quotes the line of code
    log = tmp_path / "state" / "sidecar.log"
    log.parent.mkdir()
    handler = logging.FileHandler(log)
    logging.getLogger().addHandler(handler)
    try:
        try:
            ProjectHistory.model_validate({"entries": [{"label": [marker]}]})
        except ValidationError:
            logging.getLogger("podcast_mcp.test").error("history failed", exc_info=True)
        handler.flush()
    finally:
        logging.getLogger().removeHandler(handler)
        handler.close()
    assert marker in log.read_text()
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [log])
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    members = _members(response.json()["path"])
    assert "input_value=<hidden>" in members["sidecar.log"]
    for name, text in members.items():
        assert marker not in text, name


class _Failing(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        if code is not None:
            self.code = code


def test_the_warning_for_an_unopened_episode_names_the_class_and_the_code_only(
    minimal_project, bundle_env, monkeypatch, caplog
):
    def fails(_path):
        raise _Failing("ZQMSG5521 words of the file", code="odd_failure")

    monkeypatch.setattr("podcast_mcp.gui.routes.diagnostics.ProjectWorkspace.open", fails)
    with caplog.at_level(logging.DEBUG):
        with _client(minimal_project) as client:
            response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200, response.text
    assert all("ZQMSG5521" not in r.getMessage() for r in caplog.records)
    # Only this route's own records: the app's startup warm-up logs a failed open with its
    # traceback too, and that text is what the bundle's sanitizing is for.
    own = [r for r in caplog.records if r.name == diagnostics_route.__name__]
    assert own
    assert all("ZQMSG5521" not in r.getMessage() and not r.exc_info for r in own)
    named = [r.getMessage() for r in own if "did not open" in r.getMessage()]
    assert len(named) == 1
    assert "_Failing" in named[0]
    assert "odd_failure" in named[0]


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("Upper_Case", "project_open_failed"),
        ("has space", "project_open_failed"),
        ("/etc/passwd", "project_open_failed"),
        ("a" * 70, "project_open_failed"),
        ("ab", "project_open_failed"),
        (7, "project_open_failed"),
        (None, "project_open_failed"),
        ("fine_code_2", "fine_code_2"),
    ],
)
def test_a_failed_open_is_reported_under_its_own_code_only_when_it_is_a_fixed_identifier(
    code, expected
):
    exc = _Failing("x")
    exc.code = code
    assert diagnostics_route._failure_code(exc) == expected
    assert diagnostics_route.PROJECT_OPEN_FAILED_CODE == "project_open_failed"


def test_a_failed_job_message_with_a_folder_that_has_spaces_is_not_in_the_bundle(
    tmp_path, bundle_env
):
    from podcast_mcp.services.jobs.job import short_fail_message

    folder = tmp_path / "Episode 12 with ZQDani"
    folder.mkdir()
    project_file = folder / "episode.sharecut"
    project_file.write_text("{not json")
    message = short_fail_message(f"ffmpeg failed: {folder}/raw/dani.wav: No such file or directory")
    jobs = MagicMock()
    jobs.recent_snapshots.return_value = [
        {"kind": "pipeline", "status": "failed", "message": message}
    ]
    with _client(project_file, jobs) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    assert json.loads(members["report.json"])["jobs"][0]["message"]
    for name, text in members.items():
        assert "ZQDani" not in text, name
        assert "dani.wav" not in text, name


class _Inner(BaseModel):
    align_method: str


class _Outer(BaseModel):
    meta: dict[str, _Inner]


def _outer_error(key: str) -> ValidationError:
    try:
        _Outer.model_validate({"meta": {key: {"align_method": 7}}})
    except ValidationError as exc:
        return exc
    raise AssertionError("the model accepted the damage")


@pytest.mark.parametrize("shape", ["exc_info", "percent_s", "wrapped"])
def test_a_key_in_a_prefixed_log_line_is_not_in_the_bundle(
    minimal_project, bundle_env, monkeypatch, tmp_path, shape
):
    key = "Dani" + "ela Secret" + "name"  # built here: a traceback quotes the source line
    log = tmp_path / "state" / "sidecar.log"
    log.parent.mkdir()
    handler = logging.FileHandler(log)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger = logging.getLogger("podcast_mcp.probe_keys")
    logger.addHandler(handler)
    try:
        error = _outer_error(key)
        if shape == "exc_info":
            try:
                raise error
            except ValidationError:
                logger.error("failed", exc_info=True)
        elif shape == "percent_s":
            logger.error("failed: %s", error)
        else:
            try:
                raise RuntimeError(f"wrapped: {error}") from error
            except RuntimeError:
                logger.error("failed", exc_info=True)
        handler.flush()
    finally:
        logger.removeHandler(handler)
        handler.close()
    assert key in log.read_text()
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [log])
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    members = _members(response.json()["path"])
    for name, text in members.items():
        assert "Daniela" not in text, name
        assert "Secretname" not in text, name
    assert "align_method" in members["sidecar.log"]
