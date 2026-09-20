from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.setup_cmd import setup_app
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services import diagnostics as diagnostics_mod
from podcast_mcp.services.diagnostics import (
    MAX_BUNDLE_BYTES,
    DiagnosticsService,
    bundle_filename,
    collect_env_flags,
    is_allowed_bundle_name,
    resolve_bundle_file,
    sidecar_log_candidates,
)
from podcast_mcp.services.doctor import (
    DoctorCheck,
    DoctorReport,
    ffmpeg_probe_info,
    python_runtime_info,
    run_doctor_checks,
)


def _stub_health(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.run_doctor_checks",
        lambda _p=None: DoctorReport(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.component_status",
        lambda: {"ready": True, "components": {}},
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.ffmpeg_probe_info",
        lambda: {
            "ffmpeg": {
                "ok": True,
                "version": "ffmpeg",
                "path": "ffmpeg",
                "source": "system",
            },
            "ffprobe": {"ok": True, "version": "ffprobe", "path": "ffprobe"},
        },
    )


def _zip_names(path: Path) -> set[str]:
    with zipfile.ZipFile(path) as zf:
        return set(zf.namelist())


def _report(path: Path) -> dict:
    with zipfile.ZipFile(path) as zf:
        return json.loads(zf.read("report.json"))


def test_is_allowed_bundle_name_rejects_traversal() -> None:
    assert is_allowed_bundle_name("sharecut-diagnostics-20260919T120000Z-a1b2c3.zip")
    assert not is_allowed_bundle_name("sharecut-diagnostics-20260919T120000Z.zip")
    assert not is_allowed_bundle_name("../etc/passwd")
    assert not is_allowed_bundle_name("sharecut-diagnostics-../../x.zip")
    assert not is_allowed_bundle_name("sharecut-diagnostics-20260919T120000Z.zip/../x")
    assert not is_allowed_bundle_name("foo.zip")


def test_bundle_filename_is_unique_within_a_second() -> None:
    from datetime import UTC, datetime

    when = datetime(2026, 9, 19, 12, 0, 0, tzinfo=UTC)
    first = bundle_filename(when=when)
    second = bundle_filename(when=when)
    assert first != second
    assert is_allowed_bundle_name(first)
    assert is_allowed_bundle_name(second)


def test_resolve_bundle_file_stays_in_dir(tmp_path: Path) -> None:
    name = "sharecut-diagnostics-20260919T120000Z-a1b2c3.zip"
    (tmp_path / name).write_bytes(b"PK")
    found = resolve_bundle_file(name, extra_dirs=[tmp_path])
    assert found == (tmp_path / name).resolve()
    assert resolve_bundle_file("../etc/passwd", extra_dirs=[tmp_path]) is None


def test_build_bundle_contents_and_doctor_reuse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    (tmp_path / "home").mkdir()
    out = tmp_path / "out"
    spy = MagicMock(
        return_value=DoctorReport(checks=[DoctorCheck("ok", "ffmpeg (system): ffmpeg 7")])
    )
    monkeypatch.setattr("podcast_mcp.services.diagnostics.run_doctor_checks", spy)
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.component_status",
        lambda: {"ready": True, "components": {}},
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.ffmpeg_probe_info",
        lambda: {
            "ffmpeg": {
                "ok": True,
                "version": "ffmpeg",
                "path": "ffmpeg",
                "source": "system",
            },
            "ffprobe": {"ok": True, "version": "ffprobe", "path": "ffprobe"},
        },
    )
    logs = tmp_path / "home" / "Library" / "Logs" / "Sharecut Studio"
    logs.mkdir(parents=True)
    (logs / "sidecar.log").write_text(
        "hit /r/fantastic-acoustic-whale and secret=hunter2\n",
        encoding="utf-8",
    )
    project = EpisodeProject.create("ep", str(tmp_path / "ws"))
    report = DiagnosticsService().build_bundle(project, out_dir=out, include_logs=True)
    spy.assert_called_once()
    assert report.size_bytes <= MAX_BUNDLE_BYTES
    names = _zip_names(report.path)
    assert "report.json" in names
    assert "README.txt" in names
    assert "sidecar.log" in names
    assert "shares.json" not in names
    assert "sync.db" not in names
    assert "relay.yaml" not in names
    body = _report(report.path)
    assert body["app_version"]
    assert "python" in body
    assert "os" in body
    assert body["ffmpeg"]["ffmpeg"]["path"] == "ffmpeg"
    assert body["project"]["schema_version"] == "2.0"
    assert body["project"]["tracks"] == 0
    assert "doctor" in body
    log_text = zipfile.ZipFile(report.path).read("sidecar.log").decode()
    assert "fantastic-acoustic-whale" not in log_text
    assert "/r/<share-token>" in log_text
    assert "secret=<redacted>" in log_text


def test_build_bundle_size_bound(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.run_doctor_checks",
        lambda _p=None: DoctorReport(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.component_status",
        lambda: {"ready": True, "components": {}},
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.ffmpeg_probe_info",
        lambda: {
            "ffmpeg": {
                "ok": True,
                "version": "ffmpeg",
                "path": "ffmpeg",
                "source": "system",
            },
            "ffprobe": {"ok": True, "version": "ffprobe", "path": "ffprobe"},
        },
    )
    huge = "x" * (MAX_BUNDLE_BYTES + 2_000_000)
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics._collect_logs",
        lambda **_k: {"sidecar.log": huge},
    )
    report = DiagnosticsService().build_bundle(None, out_dir=tmp_path)
    assert report.size_bytes <= MAX_BUNDLE_BYTES
    with zipfile.ZipFile(report.path) as zf:
        assert len(zf.read("sidecar.log")) < MAX_BUNDLE_BYTES


def test_doctor_cli_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.run_doctor_checks",
        lambda _p=None: DoctorReport(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.component_status",
        lambda: {"ready": True, "components": {}},
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.ffmpeg_probe_info",
        lambda: {
            "ffmpeg": {
                "ok": True,
                "version": "ffmpeg",
                "path": "ffmpeg",
                "source": "system",
            },
            "ffprobe": {"ok": True, "version": "ffprobe", "path": "ffprobe"},
        },
    )
    opened: list[str] = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url) or True)
    result = CliRunner().invoke(
        setup_app,
        ["doctor", "--bundle", "--out", str(tmp_path), "--open"],
    )
    assert result.exit_code == 0, result.output
    assert "sharecut-diagnostics-" in result.stdout
    assert "https://github.com/calebn/sharecut-studio/issues" in result.stdout
    assert opened == [result.stdout.strip().splitlines()[-1]]


def test_diagnostics_routes_host_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.run_doctor_checks",
        lambda _p=None: DoctorReport(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.component_status",
        lambda: {"ready": True, "components": {}},
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.ffmpeg_probe_info",
        lambda: {
            "ffmpeg": {
                "ok": True,
                "version": "ffmpeg",
                "path": "ffmpeg",
                "source": "system",
            },
            "ffprobe": {"ok": True, "version": "ffprobe", "path": "ffprobe"},
        },
    )
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.diagnostics.default_bundle_dir",
        lambda: tmp_path,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.default_bundle_dir",
        lambda: tmp_path,
    )
    client = TestClient(create_app())
    created = client.post("/api/diagnostics/bundle", json={"out_dir": str(tmp_path)})
    assert created.status_code == 200
    body = created.json()
    name = body["filename"]
    assert is_allowed_bundle_name(name)
    downloaded = client.get(f"/api/diagnostics/bundle/{name}")
    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"].startswith("application/zip")

    bad = client.get("/api/diagnostics/bundle/..%2Fetc%2Fpasswd")
    assert bad.status_code in (400, 404)
    slash = client.get("/api/diagnostics/bundle/foo/bar.zip")
    assert slash.status_code in (400, 404)

    guest = client.post(
        "/api/diagnostics/bundle",
        json={},
        headers={"Host": "127.0.0.1:8765", "Origin": "https://evil.example"},
    )
    assert guest.status_code == 403

    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.diagnostics.peer_host",
        lambda _request: "10.0.0.5",
    )
    remote = TestClient(create_app()).post("/api/diagnostics/bundle", json={})
    assert remote.status_code == 403


def test_run_doctor_checks_is_the_cli_implementation() -> None:
    report = run_doctor_checks()
    assert report.checks
    assert any("ffmpeg" in c.message for c in report.checks)


def test_resolve_bundle_file_missing_and_oserror(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    name = "sharecut-diagnostics-20260919T120000Z-a1b2c3.zip"
    assert resolve_bundle_file(name, extra_dirs=[tmp_path]) is None
    orig = Path.resolve

    def boom(self: Path) -> Path:
        raise OSError("unreadable")

    monkeypatch.setattr(Path, "resolve", boom)
    assert resolve_bundle_file(name, extra_dirs=[tmp_path]) is None
    monkeypatch.setattr(Path, "resolve", orig)


def test_sidecar_candidates_env_and_dedupe(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    home.mkdir()
    xdg = home / ".local" / "state"
    xdg.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "la"))
    monkeypatch.setenv("XDG_STATE_HOME", str(xdg))
    paths = sidecar_log_candidates()
    assert any(p.parts[-2:] == ("SharecutStudio", "sidecar.log") for p in paths)
    orig = Path.resolve

    def boom(self: Path) -> Path:
        if "Sharecut Studio" in str(self):
            raise OSError("x")
        return orig(self)

    monkeypatch.setattr(Path, "resolve", boom)
    again = sidecar_log_candidates()
    assert again


def test_collect_env_flags_and_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_BATCH", "TRUE")
    monkeypatch.setenv("PODCAST_GUI_MAX_BODY_BYTES", "4096")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "hunter2")
    flags = collect_env_flags()
    assert flags["PODCAST_BATCH"] == "true"
    assert flags["PODCAST_GUI_MAX_BODY_BYTES"] == "4096"
    assert flags["PODCAST_SESSION_TOKEN"] == "<redacted>"

    real_import = __import__

    def fake_import(name: str, *args: object, **kwargs: object):
        if name == "torch":
            raise ImportError("no torch")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    assert diagnostics_mod._torch_gpu_flags() == {
        "torch": False,
        "cuda": False,
        "mps": False,
    }


def test_torch_gpu_flags_with_fake_module(monkeypatch: pytest.MonkeyPatch) -> None:
    class Cuda:
        @staticmethod
        def is_available() -> bool:
            return True

    class Mps:
        @staticmethod
        def is_available() -> bool:
            return True

    fake = SimpleNamespace(cuda=Cuda(), backends=SimpleNamespace(mps=Mps()))
    monkeypatch.setitem(sys.modules, "torch", fake)
    assert diagnostics_mod._torch_gpu_flags() == {"torch": True, "cuda": True, "mps": True}


def test_build_bundle_logs_jobs_and_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_health(monkeypatch)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    macos = home / "Library" / "Logs" / "Sharecut Studio"
    linux = home / ".local" / "state" / "SharecutStudio"
    macos.mkdir(parents=True)
    linux.mkdir(parents=True)
    (macos / "sidecar.log").write_text("ok\n", encoding="utf-8")
    (macos / "dir.log").mkdir()
    (macos / "extra.log").write_text("one\n", encoding="utf-8")
    (linux / "extra.log").write_text("two\n", encoding="utf-8")
    (macos / "bad.log").write_text("nope\n", encoding="utf-8")
    orig_open = Path.open

    def maybe_fail(self: Path, *args: object, **kwargs: object):
        if self.name == "bad.log":
            raise OSError("unreadable")
        return orig_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", maybe_fail)
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    monkeypatch.setenv("PODCAST_GUI_DIST", str(dist))
    monkeypatch.setenv("PODCAST_BATCH", "1")
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.shutil.disk_usage",
        MagicMock(side_effect=OSError("disk")),
    )
    out = tmp_path / "out"
    report = DiagnosticsService().build_bundle(
        None,
        out_dir=out,
        include_logs=True,
        job_snapshots=[
            {
                "kind": "pipeline",
                "status": "running",
                "elapsed_sec": 1.5,
                "message": str(home / "secret"),
                "steps": [{"name": "transcribe"}],
            },
            {
                "kind": "bounce",
                "status": "done",
                "message": None,
                "steps": [],
            },
            {"kind": "agent", "status": "queued", "steps": ["x"]},
        ],
    )
    body = _report(report.path)
    assert body["gui_dist_present"] is True
    assert body["disk_free_bytes"] is None
    assert body["env"]["PODCAST_BATCH"] == "1"
    assert body["jobs"][0]["phase"] == "transcribe"
    assert "~/secret" in (body["jobs"][0]["message"] or "")
    names = _zip_names(report.path)
    assert "sidecar.log" in names
    assert "extra.log" in names
    assert any(n.endswith("-extra.log") or n == "SharecutStudio-extra.log" for n in names)
    skipped = DiagnosticsService().build_bundle(None, out_dir=out, include_logs=False)
    assert "sidecar.log" not in _zip_names(skipped.path)


def test_collect_logs_skips_forbidden_and_glob_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = tmp_path / "clip.wav"
    wav.write_bytes(b"RIFF")
    forbidden = tmp_path / "shares.json"
    forbidden.write_text("nope", encoding="utf-8")
    ok = tmp_path / "app.log"
    ok.write_text("hello", encoding="utf-8")

    class BoomDir:
        def is_dir(self) -> bool:
            return True

        def glob(self, _pattern: str) -> list[Path]:
            raise OSError("nope")

    class FakeDir:
        def is_dir(self) -> bool:
            return True

        def glob(self, _pattern: str) -> list[Path]:
            return [wav, forbidden, ok]

    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.state_log_dirs",
        lambda: [BoomDir(), FakeDir()],
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.sidecar_log_candidates",
        lambda: [],
    )
    logs = diagnostics_mod._collect_logs(
        include_logs=True,
        home=tmp_path,
        workspace=None,
    )
    assert logs == {"app.log": "hello"}


def test_collect_logs_resolve_oserror_and_duplicate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sidecar = tmp_path / "sidecar.log"
    extra = tmp_path / "other.log"
    sidecar.write_text("side", encoding="utf-8")
    extra.write_text("more", encoding="utf-8")
    orig = Path.resolve

    def boom(self: Path) -> Path:
        raise OSError("x")

    monkeypatch.setattr(Path, "resolve", boom)
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.sidecar_log_candidates",
        lambda: [sidecar, sidecar],
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.state_log_dirs",
        lambda: [tmp_path],
    )
    logs = diagnostics_mod._collect_logs(
        include_logs=True,
        home=tmp_path,
        workspace=None,
    )
    assert "sidecar.log" in logs
    assert "other.log" in logs
    monkeypatch.setattr(Path, "resolve", orig)


def test_truncate_logs_drops_from_largest() -> None:
    logs = {
        "a.log": "aaaa",
        "b.log": "bbbbbbbb",
        "c.log": "cc",
    }
    out = diagnostics_mod._truncate_logs(logs, budget=8)
    assert sum(len(v.encode()) for v in out.values()) <= 8


def test_build_bundle_skips_unsafe_zip_names_and_size_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_health(monkeypatch)
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics._collect_logs",
        lambda **_k: {"../escape.log": "nope", "ok.log": "yes"},
    )
    report = DiagnosticsService().build_bundle(None, out_dir=tmp_path, include_logs=True)
    names = _zip_names(report.path)
    assert "ok.log" in names
    assert "../escape.log" not in names

    orig_stat = Path.stat

    def fat(self: Path, *args: object, **kwargs: object):
        if self.suffix == ".zip" and self.parent == overflow:
            return SimpleNamespace(st_size=MAX_BUNDLE_BYTES + 10)
        return orig_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", fat)
    overflow = tmp_path / "overflow"
    overflow.mkdir()
    with pytest.raises(RuntimeError, match="5 MB"):
        DiagnosticsService().build_bundle(None, out_dir=overflow)
    assert not list(overflow.glob("*.zip"))


def test_doctor_probe_and_timebase_edges(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    info = ffmpeg_probe_info()
    assert "ffmpeg" in info and "ffprobe" in info
    assert python_runtime_info()["implementation"]

    monkeypatch.setattr(
        "podcast_mcp.util.process.run",
        lambda *_a, **_k: SimpleNamespace(returncode=1, stdout="", stderr="fail"),
    )
    failed = ffmpeg_probe_info()
    assert failed["ffprobe"]["ok"] is False

    def missing(*_a: object, **_k: object):
        raise FileNotFoundError("ffprobe")

    monkeypatch.setattr("podcast_mcp.util.process.run", missing)
    missing_info = ffmpeg_probe_info()
    assert missing_info["ffprobe"]["version"] == "ffprobe not found"

    from podcast_mcp.util.process import TimeoutExpired

    def timed(*_a: object, **_k: object):
        raise TimeoutExpired(cmd="ffprobe", timeout=10)

    monkeypatch.setattr("podcast_mcp.util.process.run", timed)
    timed_info = ffmpeg_probe_info()
    assert timed_info["ffprobe"]["ok"] is False

    monkeypatch.setattr(
        "podcast_mcp.engines.vad_silero.is_available",
        lambda: False,
    )
    ep = EpisodeProject.create("ep", str(tmp_path / "ws"))
    monkeypatch.setattr(
        "podcast_mcp.engines.session_timeline.timebase_qc_report",
        lambda _ep: {
            "tracks": {"host": {"max_drift_sec": 0.2, "unmapped_words": 4}},
            "issues": ["gap"],
        },
    )
    report = run_doctor_checks(ep)
    assert any("unmapped_words=4" in c.message for c in report.checks)
    assert any(c.message == "timebase: gap" for c in report.checks)
    assert any("silero-vad: not available" in c.message for c in report.checks)


def test_diagnostics_routes_meta_errors_and_served_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, minimal_project: Path
) -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui.server import create_app

    _stub_health(monkeypatch)
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.diagnostics.default_bundle_dir",
        lambda: tmp_path,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.default_bundle_dir",
        lambda: tmp_path,
    )
    app = create_app(served_project=Path(minimal_project))
    app.state.jobs = None
    client = TestClient(app)
    monkeypatch.setenv("PODCAST_DISTRIBUTION_SUPPORT_URL", "https://support.example.test/help")
    monkeypatch.setenv("PODCAST_DISTRIBUTION_PRIVACY_URL", "https://privacy.example.test/policy")
    monkeypatch.setenv("PODCAST_DISTRIBUTION_REPOSITORY_URL", "https://code.example.test/sharecut")
    monkeypatch.setenv(
        "PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL",
        "https://downloads.example.test/latest.json",
    )
    meta = client.get("/api/diagnostics")
    assert meta.status_code == 200
    assert meta.json() == {
        "support_url": "https://support.example.test/help",
        "privacy_url": "https://privacy.example.test/policy",
        "repository_url": "https://code.example.test/sharecut",
        "release_manifest_url": "https://downloads.example.test/latest.json",
    }

    created = client.post(
        "/api/diagnostics/bundle",
        json={"path": str(tmp_path / "missing.json"), "out_dir": str(tmp_path)},
    )
    assert created.status_code == 404
    served = client.post("/api/diagnostics/bundle", json={"out_dir": str(tmp_path)})
    assert served.status_code == 200
    assert served.json()["support_url"] == "https://support.example.test/help"

    other = tmp_path / "other.project.json"
    other.write_text(Path(minimal_project).read_text(encoding="utf-8"), encoding="utf-8")
    pinned = client.post(
        "/api/diagnostics/bundle",
        json={"path": str(other), "out_dir": str(tmp_path)},
    )
    assert pinned.status_code == 403

    invalid = client.get("/api/diagnostics/bundle/not-a-bundle.zip")
    assert invalid.status_code == 400
    missing = client.get("/api/diagnostics/bundle/sharecut-diagnostics-20200101T000000Z-deadbe.zip")
    assert missing.status_code == 404

    leaked = tmp_path / "sharecut-diagnostics-20200101T000000Z-deadbe.zip"
    leaked.write_bytes(b"PK")
    assert (
        client.get(
            "/api/diagnostics/bundle/sharecut-diagnostics-20200101T000000Z-deadbe.zip"
        ).status_code
        == 404
    )

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.diagnostics.DiagnosticsService.build_bundle",
        MagicMock(side_effect=OSError("disk full at /secret/path")),
    )
    failed = client.post("/api/diagnostics/bundle", json={"out_dir": str(tmp_path)})
    assert failed.status_code == 400
    assert failed.json()["detail"] == "could not write diagnostics bundle"
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.diagnostics.DiagnosticsService.build_bundle",
        MagicMock(side_effect=RuntimeError("too big")),
    )
    assert (
        client.post("/api/diagnostics/bundle", json={"out_dir": str(tmp_path)}).status_code == 500
    )


def test_read_log_tail_keeps_last_lines(tmp_path: Path) -> None:
    path = tmp_path / "big.log"
    path.write_text("".join(f"line-{i}\n" for i in range(600)), encoding="utf-8")
    tail = diagnostics_mod._read_log_tail(path, lines=500)
    lines = tail.splitlines()
    assert lines[0] == "line-100"
    assert lines[-1] == "line-599"
    assert len(lines) == 500


def test_read_log_tail_caps_bytes(tmp_path: Path) -> None:
    path = tmp_path / "huge.log"
    path.write_bytes(b"keep\n" + (b"x" * 8000) + b"\nlast\n")
    tail = diagnostics_mod._read_log_tail(path, lines=50, max_bytes=20)
    assert "last" in tail
    assert "keep" not in tail


def test_report_json_scrubs_non_home_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / "opt" / "podcast-cache"
    cache.mkdir(parents=True)
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(cache))
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.run_doctor_checks",
        lambda _p=None: DoctorReport(checks=[DoctorCheck("ok", f"cache writable: {cache}")]),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.component_status",
        lambda: {
            "ready": True,
            "components": {
                "whisper": {"cache": str(cache / "whisper")},
                "rnnoise": {"path": str(cache / "models" / "std.rnnn")},
            },
        },
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.ffmpeg_probe_info",
        lambda: {
            "ffmpeg": {"ok": True, "version": "ffmpeg", "path": "ffmpeg", "source": "system"},
            "ffprobe": {"ok": True, "version": "ffprobe", "path": "ffprobe"},
        },
    )
    report = DiagnosticsService().build_bundle(None, out_dir=tmp_path, include_logs=False)
    text = zipfile.ZipFile(report.path).read("report.json").decode()
    assert str(cache) not in text
    assert "<cache>" in text


def test_build_bundle_prefers_parent_progress(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from contextlib import contextmanager

    _stub_health(monkeypatch)
    seen: dict[str, object] = {}

    @contextmanager
    def fake_resolve(*_args: object, **kwargs: object):
        seen.update(kwargs)

        class Task:
            def set_phase(self, *_a: object, **_k: object) -> None:
                return None

            def advance(self, *_a: object, **_k: object) -> None:
                return None

        yield Task()

    monkeypatch.setattr("podcast_mcp.services.diagnostics.resolve_progress_task", fake_resolve)
    DiagnosticsService().build_bundle(None, out_dir=tmp_path, include_logs=False)
    assert seen.get("prefer_parent") is True


def test_build_bundle_cleans_temp_zip_on_write_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_health(monkeypatch)

    def boom(*_a: object, **_k: object):
        raise OSError("disk")

    monkeypatch.setattr("podcast_mcp.services.diagnostics.zipfile.ZipFile", boom)
    with pytest.raises(OSError, match="disk"):
        DiagnosticsService().build_bundle(None, out_dir=tmp_path, include_logs=False)
    assert not list(tmp_path.glob("*.zip"))


def test_collect_logs_skips_symlink_to_forbidden(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    secret = tmp_path / "episode.project.json"
    secret.write_text('{"token": "fantastic-acoustic-whale"}', encoding="utf-8")
    leak = logs / "leak.log"
    leak.symlink_to(secret)
    ok = logs / "app.log"
    ok.write_text("ok\n", encoding="utf-8")
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.state_log_dirs",
        lambda: [logs],
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.sidecar_log_candidates",
        lambda: [],
    )
    collected = diagnostics_mod._collect_logs(
        include_logs=True,
        home=tmp_path,
        workspace=None,
    )
    assert collected == {"app.log": "ok"}


def test_http_bundle_ignores_client_out_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui.server import create_app

    _stub_health(monkeypatch)
    dest = tmp_path / "downloads"
    dest.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.diagnostics.default_bundle_dir",
        lambda: dest,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.diagnostics.default_bundle_dir",
        lambda: dest,
    )
    client = TestClient(create_app())
    created = client.post("/api/diagnostics/bundle", json={"out_dir": str(other)})
    assert created.status_code == 200
    name = created.json()["filename"]
    assert (dest / name).is_file()
    assert not (other / name).exists()
