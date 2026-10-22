"""Download progress, typed install failures and joining a running bootstrap (#2046 P2)."""

from __future__ import annotations

import errno
import hashlib
import json
import sys
import threading
import urllib.error
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from job_event_helpers import JobEventTap
from podcast_mcp.cli.main import app
from podcast_mcp.engines.models import registry
from podcast_mcp.engines.models.whisper import WhisperPinMismatchError
from podcast_mcp.engines.models.word_aligner import WordAlignerPinMismatchError
from podcast_mcp.services.jobs import BootstrapSlotBusyError, Job, JobManager
from podcast_mcp.services.jobs.reporter import JobProgressReporter
from podcast_mcp.services.pipeline import bootstrap as boot
from podcast_mcp.services.pipeline import install_failure
from podcast_mcp.services.pipeline.install_failure import InstallFailure
from podcast_mcp.util.asset_sources import (
    DOWNLOAD_TASK_ID,
    AssetIntegrityError,
    AssetSourceError,
    DownloadProgress,
    download_first_ok,
)
from podcast_mcp.util.model_manifest import PinnedSnapshot, _byte_bar, download_pinned_snapshot
from podcast_mcp.util.progress import CancelledProgress, progress_task
from test_asset_sources import _Opener, _serve

MIB = 1024 * 1024
RNNOISE = registry.model_spec("rnnoise")


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)


def _spec_raising(exc: BaseException):
    def install(variant, force, on_progress):
        raise exc

    return replace(RNNOISE, install=install)


def _install(spec) -> dict[str, Any]:
    return boot.install_model(spec, whisper_model="small.en")


def _http_error(status: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://up.example/m", status, "x", None, None)  # type: ignore[arg-type]


def _hub_http_error(status: int):
    import httpx2
    from huggingface_hub.errors import HfHubHTTPError

    return HfHubHTTPError(
        "hub said no",
        response=httpx2.Response(status, request=httpx2.Request("GET", "https://hub.example/x")),
    )


def _attempts(*errors: Exception) -> AssetSourceError:
    error = AssetSourceError("; ".join(str(e) for e in errors))
    error.attempts = errors
    return error


def _failure_cases():
    from huggingface_hub.errors import DryRunError, LocalEntryNotFoundError, OfflineModeIsEnabled

    return [
        ("403", _http_error(403), "http", 403),
        ("404", _http_error(404), "http", 404),
        ("503", _http_error(503), "http", 503),
        ("429", _http_error(429), "http", 429),
        ("hub 401", _hub_http_error(401), "http", 401),
        ("hub 404", _hub_http_error(404), "http", 404),
        ("url error", urllib.error.URLError("dns"), "network", None),
        ("timeout", TimeoutError("slow"), "network", None),
        ("reset", ConnectionResetError("reset"), "network", None),
        ("dry run", DryRunError("cannot reach"), "network", None),
        ("hub local only", LocalEntryNotFoundError("no cache"), "network", None),
        ("offline", OfflineModeIsEnabled("off"), "network", None),
        ("disk full", OSError(errno.ENOSPC, "No space left on device"), "disk", None),
        ("quota", OSError(errno.EDQUOT, "Quota"), "disk", None),
        ("read only", PermissionError(errno.EACCES, "denied"), "disk", None),
        ("whisper pin", WhisperPinMismatchError("small.en", "model.bin sha"), "pin_mismatch", None),
        (
            "aligner pin",
            WordAlignerPinMismatchError("onnx-base", "vocab sha"),
            "pin_mismatch",
            None,
        ),
        (
            "rnnoise size pin",
            AssetSourceError("size mismatch for rnnoise.rnnn: expected 297646 bytes, got 12"),
            "pin_mismatch",
            None,
        ),
        (
            "rnnoise sha pin",
            AssetSourceError("sha256 mismatch for rnnoise.rnnn: expected a, got b"),
            "pin_mismatch",
            None,
        ),
        ("sha", _attempts(AssetIntegrityError("sha256 mismatch")), "pin_mismatch", None),
        (
            "sha beats a later 404",
            _attempts(AssetIntegrityError("sha"), _http_error(404)),
            "pin_mismatch",
            None,
        ),
        (
            "last attempt wins",
            _attempts(_http_error(404), _http_error(403)),
            "http",
            403,
        ),
        ("refused redirect", _attempts(AssetSourceError("refusing redirect")), "network", None),
    ]


@pytest.mark.parametrize(
    ("exc", "kind", "status"),
    [pytest.param(*case[1:], id=case[0]) for case in _failure_cases()],
)
def test_install_model_classifies_a_known_cause_once(
    exc, kind, status, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("WARNING"), pytest.raises(InstallFailure) as raised:
        _install(_spec_raising(exc))
    failure = raised.value
    assert (failure.kind, failure.status) == (kind, status)
    assert failure.code == "install_failed"
    assert failure.__cause__ is exc
    (record,) = caplog.records
    assert record.exc_info is not None and record.exc_info[1] is exc
    assert record.getMessage() == f"bootstrap of rnnoise failed: {failure.plain}"


@pytest.mark.parametrize(
    "exc",
    [
        RuntimeError("boom"),
        ValueError("bad"),
        OSError(errno.EIO, "io"),
        _attempts(ValueError("refusing download host")),
    ],
)
def test_an_unknown_error_is_a_bug_and_is_not_labelled(exc) -> None:
    with pytest.raises(type(exc)) as raised:
        _install(_spec_raising(exc))
    assert raised.value is exc


def test_a_pin_mismatch_names_the_upgrade_command() -> None:
    with pytest.raises(InstallFailure) as raised:
        _install(_spec_raising(AssetIntegrityError("sha256 mismatch")))
    assert raised.value.plain == (
        "RNNoise noise reduction downloaded but isn't the expected version. "
        "Run: podcast bootstrap --component rnnoise --upgrade"
    )
    with pytest.raises(InstallFailure) as raised:
        boot.install_model(
            replace(
                registry.model_spec("whisper"),
                install=_spec_raising(AssetIntegrityError("x")).install,
            ),
            whisper_model="small.en",
        )
    assert raised.value.plain.endswith(
        "Run: podcast bootstrap --component whisper --whisper-model small.en --upgrade"
    )


def test_offline_mode_gets_its_own_wording(monkeypatch: pytest.MonkeyPatch) -> None:
    from huggingface_hub.errors import DryRunError

    monkeypatch.setattr("huggingface_hub.constants.HF_HUB_OFFLINE", True)
    with pytest.raises(InstallFailure) as raised:
        _install(_spec_raising(DryRunError("x")))
    assert raised.value.kind == "network"
    assert raised.value.plain == "Downloads are turned off on this machine."


def test_cancel_passes_through_install_model_unclassified() -> None:
    with pytest.raises(CancelledProgress):
        _install(_spec_raising(CancelledProgress("stop")))


def test_every_plain_text_is_free_of_paths_urls_and_env_vars() -> None:
    label = registry.model_spec("whisper").label
    for key, template in install_failure._PLAIN.items():
        plain = template.format(label=label, fix="podcast bootstrap --component whisper --upgrade")
        assert "http" not in plain.lower(), key
        assert "/" not in plain and "\\" not in plain, key
        assert "PODCAST_" not in plain and "HF_" not in plain, key
    for _, exc, _, _ in _failure_cases():
        failure = install_failure.classify(exc, label=label, fix="podcast bootstrap")
        assert failure is not None
        assert str(exc) not in failure.plain or str(exc) == ""
        assert str(failure) == failure.plain


def _cdn_spec(
    dest: Path,
    urls: list[str],
    sha: str | None = None,
    after_chunk: Callable[[], None] | None = None,
):
    def install(variant, force, on_progress):
        sink = on_progress
        if after_chunk is not None:

            def sink(progress: DownloadProgress) -> None:
                on_progress(progress)
                after_chunk()

        download_first_ok(urls, dest, expected_sha256=sha, on_progress=sink)
        return {"ok": True, "path": str(dest)}

    return replace(RNNOISE, install=install)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    ticks = iter(range(0, 10_000))
    monkeypatch.setattr("podcast_mcp.util.progress.task._update_clock", lambda: next(ticks) * 1.0)


def _run_in_job(
    job: Job, work: Callable[[], Any], cancel: Callable[[], bool] | None = None
) -> list[dict[str, Any]]:
    reporter = JobProgressReporter(job)
    with JobEventTap(job.id) as tap:
        try:
            with progress_task("bootstrap", "Bootstrap assets", total=1, reporter=reporter):
                work()
        finally:
            reporter.close()
        return tap.drain()


def _bytes_events(events: list[dict[str, Any]]) -> list[tuple[str, int, int | None]]:
    return [
        (e["kind"], e["current"], e["total"])
        for e in events
        if e["type"] == "progress" and e["task_id"] == DOWNLOAD_TASK_ID
    ]


def test_success_reports_bytes_and_fills_the_job_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, clock: None
) -> None:
    body = b"x" * (2 * MIB + 7)
    size = len(body)
    _serve(monkeypatch, _Opener({"https://up.example/m": body}))
    dest = tmp_path / "m.bin"
    job = Job.bootstrap("b1", ["rnnoise"])
    seen: list[dict[str, Any] | None] = []
    spec = _cdn_spec(
        dest,
        ["https://up.example/m"],
        hashlib.sha256(body).hexdigest(),
        after_chunk=lambda: seen.append(job.download and dict(job.download)),
    )
    events = _run_in_job(job, lambda: _install(spec))
    bytes_events = _bytes_events(events)
    assert [e for e in bytes_events if e[0] == "update"] == [
        ("update", 0, size),
        ("update", MIB, size),
        ("update", 2 * MIB, size),
        ("update", size, size),
    ]
    assert [e[0] for e in bytes_events][:1] == ["start"]
    assert [e[0] for e in bytes_events][-1] == "end"
    assert seen[-1] == {"component": "rnnoise", "bytes": size, "total": size}
    assert job.download is None
    assert dest.read_bytes() == body


def test_job_download_total_stays_none_without_content_length(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, clock: None
) -> None:
    _serve(monkeypatch, _Opener({"https://up.example/m": b"abc"}, length=False))
    job = Job.bootstrap("b1", ["rnnoise"])
    seen: list[dict[str, Any] | None] = []
    spec = _cdn_spec(
        tmp_path / "m.bin",
        ["https://up.example/m"],
        after_chunk=lambda: seen.append(job.download and dict(job.download)),
    )
    _run_in_job(job, lambda: _install(spec))
    assert seen[-1] == {"component": "rnnoise", "bytes": 3, "total": None}


def test_a_restart_opens_a_fresh_bytes_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, clock: None
) -> None:
    good = b"g" * 10
    _serve(
        monkeypatch,
        _Opener({"https://cdn.example.test/m": b"b" * 4, "https://up.example/m": good}),
    )
    spec = _cdn_spec(
        tmp_path / "m.bin",
        ["https://cdn.example.test/m", "https://up.example/m"],
        hashlib.sha256(good).hexdigest(),
    )
    events = _run_in_job(Job.bootstrap("b1", ["rnnoise"]), lambda: _install(spec))
    kinds = [k for k, _, _ in _bytes_events(events)]
    assert kinds.count("start") == 2 and kinds.count("end") == 2
    totals = [t for k, _, t in _bytes_events(events) if k == "start"]
    assert totals == [4, 10]


def test_a_failed_download_ends_the_bytes_task_and_clears_the_job_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, clock: None
) -> None:
    _serve(monkeypatch, _Opener({"https://up.example/m": b"bad"}))
    job = Job.bootstrap("b1", ["rnnoise"])
    spec = _cdn_spec(
        tmp_path / "m.bin", ["https://up.example/m"], hashlib.sha256(b"good").hexdigest()
    )

    def work() -> None:
        with pytest.raises(InstallFailure) as raised:
            _install(spec)
        assert raised.value.kind == "pin_mismatch"

    events = _run_in_job(job, work)
    assert [k for k, _, _ in _bytes_events(events)][-1] == "fail"
    assert job.download is None
    assert list(tmp_path.glob("m.bin*")) == []


@pytest.mark.parametrize(
    ("route", "kind", "status"),
    [
        (_http_error(403), "http", 403),
        (_http_error(404), "http", 404),
        (urllib.error.URLError("dns"), "network", None),
    ],
)
def test_open_failures_reach_the_caller_typed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, route: Exception, kind: str, status
) -> None:
    _serve(monkeypatch, _Opener({"https://up.example/m": route}))
    dest = tmp_path / "m.bin"
    with pytest.raises(InstallFailure) as raised:
        _install(_cdn_spec(dest, ["https://up.example/m"]))
    assert (raised.value.kind, raised.value.status) == (kind, status)
    assert not dest.exists()


def test_a_disk_error_while_writing_is_typed_and_leaves_no_part(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve(monkeypatch, _Opener({"https://up.example/m": b"abc"}))

    def full_disk(*_a: object, **_k: object) -> None:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr("podcast_mcp.util.asset_sources._copy_bounded", full_disk)
    dest = tmp_path / "m.bin"
    with pytest.raises(InstallFailure) as raised:
        _install(_cdn_spec(dest, ["https://up.example/m"]))
    assert raised.value.kind == "disk"
    assert list(tmp_path.glob("m.bin*")) == []


def test_cancel_mid_stream_stops_the_download_and_later_components(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve(monkeypatch, _Opener({"https://up.example/m": b"x" * (3 * MIB)}))
    dest = tmp_path / "m.bin"
    cancel = threading.Event()
    started: list[str] = []
    first = _cdn_spec(dest, ["https://up.example/m"], after_chunk=cancel.set)

    def never(variant, force, on_progress):
        started.append("word-aligner")
        return {"ok": True}

    specs = {
        "rnnoise": first,
        "word-aligner": replace(registry.model_spec("word-aligner"), install=never),
    }
    monkeypatch.setattr(boot, "model_spec", lambda model_id: specs[model_id])
    monkeypatch.setattr(boot, "component_status", lambda **_k: {})
    with pytest.raises(CancelledProgress):
        boot.run_bootstrap(["rnnoise", "word-aligner"], cancel_check=cancel.is_set)
    assert started == []
    assert list(tmp_path.glob("m.bin*")) == []


def test_a_cancelled_job_ends_cancelled_without_an_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve(monkeypatch, _Opener({"https://up.example/m": b"x" * (3 * MIB)}))
    job = Job.bootstrap("b1", ["rnnoise"])
    spec = _cdn_spec(
        tmp_path / "m.bin",
        ["https://up.example/m"],
        after_chunk=lambda: setattr(job, "cancel_requested", True),
    )
    monkeypatch.setattr(boot, "model_spec", lambda model_id: spec)
    JobManager()._run_bootstrap_job(job)
    assert (job.status, job.error, job.message) == ("cancelled", None, "Bootstrap cancelled")
    assert job.download is None
    assert list(tmp_path.glob("m.bin*")) == []


def test_a_failed_job_carries_the_first_failure_and_its_plain_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    specs = {"rnnoise": _spec_raising(_http_error(404))}
    monkeypatch.setattr(boot, "model_spec", lambda model_id: specs[model_id])
    monkeypatch.setattr(boot, "component_status", lambda **_k: {})
    job = Job.bootstrap("b1", ["rnnoise"])
    JobManager()._run_bootstrap_job(job)
    plain = "The download server doesn't have RNNoise noise reduction."
    assert (job.status, job.error, job.message) == ("error", plain, plain)
    assert job.failure == {"kind": "http", "status": 404, "plain": plain}
    snap = job.snapshot()
    assert snap["failure"] == job.failure and snap["download"] is None


def test_a_failed_model_reports_its_failure_and_the_next_still_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def installs(variant, force, on_progress):
        return {"ok": True, "path": "/stub/word-aligner"}

    specs = {
        "rnnoise": _spec_raising(_http_error(404)),
        "word-aligner": replace(registry.model_spec("word-aligner"), install=installs),
    }
    monkeypatch.setattr(boot, "model_spec", lambda model_id: specs[model_id])
    monkeypatch.setattr(boot, "component_status", lambda **_k: {})
    out = boot.run_bootstrap(["rnnoise", "word-aligner"])
    plain = "The download server doesn't have RNNoise noise reduction."
    assert out["ok"] is False
    assert out["results"]["rnnoise"]["failure"] == {"kind": "http", "status": 404, "plain": plain}
    assert out["results"]["rnnoise"]["error"] == plain
    assert out["results"]["word-aligner"] == {"ok": True, "path": "/stub/word-aligner"}


SECRET = "/home/someone/secret/model.bin"


def _leaky_spec():
    def install(variant, force, on_progress):
        on_progress(DownloadProgress(0, 10))
        raise OSError(errno.EIO, "disk exploded", SECRET)

    return replace(RNNOISE, install=install)


def test_an_unexpected_error_never_reaches_the_event_stream(clock: None) -> None:
    job = Job.bootstrap("b1", ["rnnoise"])

    def work() -> None:
        with pytest.raises(OSError, match="disk exploded"):
            _install(_leaky_spec())

    events = _run_in_job(job, work)
    assert SECRET not in json.dumps(events) and "disk exploded" not in json.dumps(events)
    (failed,) = [e for e in events if e["task_id"] == DOWNLOAD_TASK_ID and e["kind"] == "fail"]
    assert failed["message"].endswith(": RNNoise noise reduction could not be installed.")
    assert job.error is None


def test_a_failed_job_after_an_unexpected_error_carries_only_the_generic_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(boot, "model_spec", lambda model_id: _leaky_spec())
    monkeypatch.setattr(boot, "component_status", lambda **_k: {})
    job = Job.bootstrap("b1", ["rnnoise"])
    JobManager()._run_bootstrap_job(job)
    plain = "RNNoise noise reduction could not be installed."
    assert (job.status, job.error, job.message, job.failure) == ("error", plain, plain, None)


def test_a_crash_outside_any_component_gives_the_job_a_generic_error(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def crash(*_a: object, **_k: object) -> None:
        raise RuntimeError(SECRET)

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", crash)
    job = Job.bootstrap("b1", ["rnnoise"])
    with caplog.at_level("ERROR"):
        JobManager()._run_bootstrap_job(job)
    plain = "The download could not be completed."
    assert (job.status, job.error, job.message) == ("error", plain, plain)
    assert caplog.records[0].exc_info[1].args == (SECRET,)


@pytest.mark.parametrize("results", [{}, {"rnnoise": {}}])
def test_a_not_ok_result_without_a_failed_entry_still_ends_the_job(
    monkeypatch: pytest.MonkeyPatch, results: dict[str, Any]
) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.run_bootstrap",
        lambda *_a, **_k: {"ok": False, "results": results},
    )
    job = Job.bootstrap("b1", ["rnnoise"])
    JobManager()._run_bootstrap_job(job)
    assert (job.status, job.error, job.failure) == ("error", "Bootstrap failed", None)


REVISION = "a" * 40
HF_FILES = {"model.bin": b"m" * 5000, "config.json": b"{}" * 20, "vocab.txt": b"v" * 300}
PIN = PinnedSnapshot(
    "acme/model",
    REVISION,
    tuple((name, hashlib.sha256(data).hexdigest()) for name, data in HF_FILES.items()),
)


@pytest.fixture
def fake_hub(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Real ``snapshot_download`` over a faked listing and a faked per-file download."""
    from huggingface_hub import _snapshot_download as module
    from huggingface_hub.file_download import DryRunFileInfo
    from huggingface_hub.hf_api import RepoFile

    class FakeApi:
        def __init__(self, **_kwargs: object) -> None:
            return None

        def list_repo_tree(self, **_kwargs: object):
            return [RepoFile(path=n, size=len(d), oid="0" * 40) for n, d in HF_FILES.items()]

    state: dict[str, Any] = {"extra": 0, "files": HF_FILES}

    def fake_download(repo_id, *, filename, revision, cache_dir, tqdm_class, dry_run, **_kw):
        data = state["files"][filename]
        if dry_run:
            return DryRunFileInfo(revision, len(data), filename, "", False, True)
        bar = tqdm_class(total=len(data), initial=0, desc=filename, unit="B", unit_scale=True)
        for start in range(0, len(data), 1000):
            step = len(data[start : start + 1000])
            bar.update(step)
            bar.update_transfer(step)
        bar.update(state["extra"])
        snap = tmp_path / "hub" / "models--acme--model" / "snapshots" / revision / filename
        snap.parent.mkdir(parents=True, exist_ok=True)
        snap.write_bytes(data)
        return str(snap)

    monkeypatch.setattr(module, "HfApi", FakeApi)
    monkeypatch.setattr(module, "hf_hub_download", fake_download)
    return state


def test_pinned_download_counts_reconstructed_bytes_against_the_dry_run_total(
    tmp_path: Path, fake_hub: dict[str, Any]
) -> None:
    events: list[DownloadProgress] = []
    lock = threading.Lock()

    def sink(progress: DownloadProgress) -> None:
        with lock:
            events.append(progress)

    path, mismatch = download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=sink)
    total = sum(len(d) for d in HF_FILES.values())
    assert mismatch is None and (path / "model.bin").is_file()
    assert events[0] == DownloadProgress(0, total)
    assert {e.total for e in events} == {total}
    counts = [e.bytes for e in events]
    assert counts == sorted(counts)
    assert counts[-1] == total


def test_pinned_download_never_reports_past_the_total(
    tmp_path: Path, fake_hub: dict[str, Any]
) -> None:
    fake_hub["extra"] = 999
    events: list[DownloadProgress] = []
    download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=events.append)
    total = sum(len(d) for d in HF_FILES.values())
    assert max(e.bytes for e in events) == total


def test_pinned_refetch_after_a_mismatch_restarts_at_zero(
    tmp_path: Path, fake_hub: dict[str, Any]
) -> None:
    fake_hub["files"] = {**HF_FILES, "vocab.txt": b"w" * 300}
    events: list[DownloadProgress] = []
    _, mismatch = download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=events.append)
    assert mismatch is not None
    assert [e.bytes for e in events].count(0) == 2


def test_pinned_download_stops_when_the_sink_raises(
    tmp_path: Path, fake_hub: dict[str, Any]
) -> None:
    def sink(progress: DownloadProgress) -> None:
        if progress.bytes > 1000:
            raise CancelledProgress("stop")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=sink)


def test_pinned_download_offline_fails_before_downloading(
    tmp_path: Path, fake_hub: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    from huggingface_hub import _snapshot_download as module

    class DownApi:
        def __init__(self, **_kwargs: object) -> None:
            return None

        def list_repo_tree(self, **_kwargs: object):
            raise OSError("offline")

    monkeypatch.setattr(module, "HfApi", DownApi)
    with pytest.raises(OSError):
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=lambda _p: None)


def test_a_renamed_hub_bar_reports_no_total_instead_of_a_wrong_one(
    caplog: pytest.LogCaptureFixture,
) -> None:
    events: list[DownloadProgress] = []
    bar = _byte_bar(events.append, 100)
    files = bar(total=2, desc="Fetching 2 files")
    renamed = bar(total=0, desc="Writing to disk", unit="B")
    renamed.update(40)
    files.update(1)
    assert events == [DownloadProgress(0, None), DownloadProgress(0, None)]
    assert caplog.text.count("reported no byte progress") == 1


def test_the_reconstruct_bar_is_the_only_counter() -> None:
    events: list[DownloadProgress] = []
    bar = _byte_bar(events.append, 100)
    reconstruct = bar(total=0, desc="Reconstructing (incomplete total...)", unit="B")
    transfer = bar(total=0, desc="Downloading bytes", unit="B")
    transfer.update(60)
    reconstruct.update(30)
    reconstruct.update(30)
    assert [e.bytes for e in events] == [0, 30, 60]
    assert {e.total for e in events} == {100}


def test_unpinned_whisper_reports_one_indeterminate_tick(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import types

    from podcast_mcp.engines.models import whisper

    constructed: list[str] = []
    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = lambda name, **_k: constructed.append(name)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: tmp_path)
    monkeypatch.setattr(whisper, "persist_whisper_model", lambda _m: None)
    unpinned = next(m for m in whisper.WHISPER_SIZE_ENUM if m not in whisper.WHISPER_PINS)
    events: list[DownloadProgress] = []
    whisper.bootstrap_whisper_model(unpinned, on_progress=events.append)
    assert constructed == [unpinned]
    assert events == [DownloadProgress(0, None)]


@pytest.fixture
def blocked_run(monkeypatch: pytest.MonkeyPatch):
    """Every ``run_bootstrap`` call waits on ``gate``; ``calls`` records its requests."""
    gate = threading.Event()
    calls: list[tuple[Any, ...]] = []

    def run(components=None, *, whisper_model=None, force=False, progress=None, **_extra):
        calls.append((tuple(components or ()), whisper_model, force))
        gate.wait(timeout=5)
        return {"ok": True, "results": {}}

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", run)
    yield gate, calls
    gate.set()


def _live(
    mgr: JobManager, components: list[str], *, model="small.en", force=False, **fields
) -> Job:
    job = Job.bootstrap("live", components, whisper_model=model, force=force)
    job.status = "running"
    for name, value in fields.items():
        setattr(job, name, value)
    mgr._catalog._bootstrap_job = job
    return job


JOIN_ROWS = [
    ("same set", ["whisper"], {}, ["whisper"], {}, True),
    ("subset", ["whisper", "rnnoise"], {}, ["rnnoise"], {}, True),
    ("subset wanting the same whisper", ["whisper", "rnnoise"], {}, ["whisper"], {}, True),
    (
        "other whisper not wanted",
        ["whisper", "rnnoise"],
        {},
        ["rnnoise"],
        {"model": "tiny.en"},
        True,
    ),
    ("force on a forced job", ["whisper"], {"force": True}, ["whisper"], {"force": True}, True),
    ("unforced on a forced job", ["whisper"], {"force": True}, ["whisper"], {}, True),
    ("force on an unforced job", ["whisper"], {}, ["whisper"], {"force": True}, False),
    ("superset", ["whisper"], {}, ["whisper", "rnnoise"], {}, False),
    ("disjoint", ["whisper"], {}, ["rnnoise"], {}, False),
    ("other whisper model", ["whisper"], {}, ["whisper"], {"model": "tiny.en"}, False),
    ("cancelling", ["whisper"], {"cancel_requested": True}, ["whisper"], {}, False),
    (
        "retry of a component the live job failed",
        ["whisper", "rnnoise"],
        {"failed_components": ["rnnoise"]},
        ["rnnoise"],
        {},
        False,
    ),
    (
        "another component failed",
        ["whisper", "rnnoise"],
        {"failed_components": ["whisper"]},
        ["rnnoise"],
        {},
        True,
    ),
]


@pytest.mark.parametrize(
    ("live", "live_opts", "wanted", "wanted_opts", "joins"),
    [pytest.param(*row[1:], id=row[0]) for row in JOIN_ROWS],
)
def test_start_bootstrap_joins_or_refuses(
    blocked_run, live, live_opts, wanted, wanted_opts, joins
) -> None:
    mgr = JobManager()
    running = _live(mgr, live, **{"model": "small.en", **live_opts})
    request = {"whisper_model": "small.en", **wanted_opts}
    request["whisper_model"] = request.pop("model", request["whisper_model"])
    if joins:
        job, adopted = mgr.start_bootstrap(components=wanted, **request)
        assert (job, adopted) == (running, True)
        assert mgr._catalog._bootstrap_job is running
    else:
        with pytest.raises(BootstrapSlotBusyError) as raised:
            mgr.start_bootstrap(components=wanted, **request)
        assert raised.value.running == live
        assert raised.value.cancelling is bool(live_opts.get("cancel_requested"))
        assert raised.value.code == "bootstrap_job_running"


def test_the_job_records_each_failed_component(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = {"rnnoise": _spec_raising(_http_error(404)), "word-aligner": _leaky_spec()}
    monkeypatch.setattr(boot, "model_spec", lambda model_id: specs[model_id])
    monkeypatch.setattr(boot, "component_status", lambda **_k: {})
    job = Job.bootstrap("b1", ["rnnoise", "word-aligner"])
    JobManager()._run_bootstrap_job(job)
    assert job.failed_components == ["rnnoise", "word-aligner"]


def test_a_bare_request_means_the_first_run_set(blocked_run) -> None:
    mgr = JobManager()
    running = _live(mgr, ["whisper", "rnnoise"], model="large-v3-turbo")
    assert mgr.start_bootstrap() == (running, True)


@pytest.mark.parametrize("status", ["ok", "error", "cancelled"])
def test_a_finished_job_is_replaced_by_a_new_one(blocked_run, status: str) -> None:
    gate, _ = blocked_run
    mgr = JobManager()
    done = _live(mgr, ["whisper"])
    done.status = status
    job, adopted = mgr.start_bootstrap(components=["whisper"])
    assert adopted is False and job is not done
    assert mgr.get_bootstrap_job("live") is done
    gate.set()


def test_start_bootstrap_refuses_unknown_components_up_front(blocked_run) -> None:
    with pytest.raises(ValueError, match="unsupported"):
        JobManager().start_bootstrap(components=["speaker"])


def test_two_simultaneous_identical_requests_make_one_run(blocked_run) -> None:
    gate, calls = blocked_run
    mgr = JobManager()
    results: list[tuple[Job, bool]] = []
    barrier = threading.Barrier(2)

    def start() -> None:
        barrier.wait()
        results.append(mgr.start_bootstrap(components=["whisper"]))

    threads = [threading.Thread(target=start) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    gate.set()
    assert results[0][0] is results[1][0]
    assert sorted(adopted for _, adopted in results) == [False, True]
    assert len(calls) == 1


runner = CliRunner()


def _terminal_log(monkeypatch: pytest.MonkeyPatch):
    """What Python's last-resort handler prints: the CLI has no logging of its own.

    Called in the test body because pytest attaches its own root handler per phase.
    """
    import io
    import logging

    buffer = io.StringIO()
    monkeypatch.setattr(logging, "lastResort", logging.StreamHandler(buffer))
    monkeypatch.setattr(logging.getLogger(), "handlers", [])
    return buffer


def _cli_stub(monkeypatch: pytest.MonkeyPatch, *, fail: bool = False) -> None:
    def install(variant, force, on_progress):
        on_progress(DownloadProgress(0, 2 * MIB))
        on_progress(DownloadProgress(2 * MIB, 2 * MIB))
        if fail:
            raise _http_error(404)
        return {"ok": True, "path": "/stub/rnnoise"}

    models = tuple(
        replace(spec, install=install) if spec.id == "rnnoise" else spec for spec in registry.MODELS
    )
    monkeypatch.setattr(registry, "MODELS", models)
    monkeypatch.setattr("podcast_mcp.cli.setup_cmd.MODELS", models)
    monkeypatch.setattr(
        boot, "model_spec", lambda model_id: next(s for s in models if s.id == model_id)
    )


def test_cli_off_a_terminal_prints_line_updates_and_no_bar(monkeypatch: pytest.MonkeyPatch) -> None:
    _cli_stub(monkeypatch)
    result = runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 0
    assert result.stdout.splitlines() == [
        "[get] rnnoise (~0.3 MB)",
        "[ok] rnnoise: /stub/rnnoise",
        "Bootstrap complete.",
    ]
    assert result.stderr == ""


def test_cli_failure_off_a_terminal_prints_the_plain_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _cli_stub(monkeypatch, fail=True)
    result = runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 1
    assert result.stdout == "[get] rnnoise (~0.3 MB)\n"
    assert (
        result.stderr
        == "[fail] rnnoise: The download server doesn't have RNNoise noise reduction.\n"
    )


def test_cli_json_progress_carries_the_byte_events(monkeypatch: pytest.MonkeyPatch) -> None:
    _cli_stub(monkeypatch)
    result = runner.invoke(app, ["--json-progress", "bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 0
    events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]
    sizes = [
        (e["current"], e["total"])
        for e in events
        if e["task_id"] == DOWNLOAD_TASK_ID and e["kind"] == "update"
    ]
    assert sizes[0] == (0, 2 * MIB) and sizes[-1] == (2 * MIB, 2 * MIB)
    assert "[get] rnnoise" in result.stdout


class _TtyStderr:
    def isatty(self) -> bool:
        return True

    def __getattr__(self, name: str) -> Any:
        return getattr(sys.stderr, name)


class _TtyShim:
    @property
    def stderr(self) -> _TtyStderr:
        return _TtyStderr()

    def __getattr__(self, name: str) -> Any:
        return getattr(sys, name)


def test_cli_on_a_terminal_feeds_bytes_to_the_progress_bar(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.util.progress.reporters import CliProgressReporter

    _cli_stub(monkeypatch)
    for module in ("podcast_mcp.cli.setup_cmd", "podcast_mcp.util.progress.sinks"):
        monkeypatch.setattr(f"{module}.sys", _TtyShim())
    monkeypatch.setattr("podcast_mcp.util.progress.reporters.sys", _TtyShim())
    bar_updates: list[tuple[str, int, int | None]] = []
    real_update = CliProgressReporter.update

    def spy(self, task_id, current, *, total=None, **kwargs):
        bar_updates.append((task_id, current, total))
        return real_update(self, task_id, current, total=total, **kwargs)

    monkeypatch.setattr(CliProgressReporter, "update", spy)
    result = runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 0
    assert result.stdout.splitlines() == ["[ok] rnnoise: /stub/rnnoise", "Bootstrap complete."]
    assert (DOWNLOAD_TASK_ID, 2 * MIB, 2 * MIB) in bar_updates


def _cli_leaky(monkeypatch: pytest.MonkeyPatch) -> None:
    models = tuple(
        replace(spec, install=_leaky_spec().install) if spec.id == "rnnoise" else spec
        for spec in registry.MODELS
    )
    monkeypatch.setattr("podcast_mcp.cli.setup_cmd.MODELS", models)
    monkeypatch.setattr(
        boot, "model_spec", lambda model_id: next(s for s in models if s.id == model_id)
    )


def test_cli_unexpected_error_prints_only_the_generic_line(monkeypatch: pytest.MonkeyPatch) -> None:
    terminal_log = _terminal_log(monkeypatch)
    _cli_leaky(monkeypatch)
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    result = runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 1
    assert result.stderr == "[fail] rnnoise: RNNoise noise reduction could not be installed.\n"
    assert terminal_log.getvalue() == ""


def test_cli_known_failure_keeps_its_logged_cause_off_the_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    terminal_log = _terminal_log(monkeypatch)
    _cli_stub(monkeypatch, fail=True)
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert terminal_log.getvalue() == ""


def test_cli_debug_prints_the_traceback(monkeypatch: pytest.MonkeyPatch) -> None:
    terminal_log = _terminal_log(monkeypatch)
    _cli_leaky(monkeypatch)
    monkeypatch.setenv("PODCAST_DEBUG", "1")
    runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert "Traceback" in terminal_log.getvalue() and "disk exploded" in terminal_log.getvalue()


@pytest.mark.parametrize(
    ("cached", "upgrade", "lines"),
    [
        (False, False, ["[get] rnnoise (~0.3 MB)", "[ok] rnnoise: /stub/rnnoise"]),
        (True, False, ["[skip] rnnoise: cached"]),
        (True, True, ["[get] rnnoise (~0.3 MB)", "[ok] rnnoise: /stub/rnnoise"]),
    ],
)
def test_cli_get_line_prints_only_when_the_model_will_install(
    monkeypatch: pytest.MonkeyPatch, cached: bool, upgrade: bool, lines: list[str]
) -> None:
    def install(variant, force, on_progress):
        if not force and cached:
            return {"ok": True, "skipped": True, "reason": "cached"}
        return {"ok": True, "path": "/stub/rnnoise"}

    models = tuple(
        replace(spec, install=install) if spec.id == "rnnoise" else spec for spec in registry.MODELS
    )
    monkeypatch.setattr("podcast_mcp.cli.setup_cmd.MODELS", models)
    monkeypatch.setattr(
        "podcast_mcp.cli.setup_cmd.model_status",
        lambda *_a, **_k: {"state": "installed" if cached else "missing"},
    )
    monkeypatch.setattr(
        boot, "model_spec", lambda model_id: next(s for s in models if s.id == model_id)
    )
    args = ["bootstrap", "--component", "rnnoise", *(["--upgrade"] if upgrade else [])]
    result = runner.invoke(app, args)
    assert result.stdout.splitlines() == [*lines, "Bootstrap complete."]


def test_the_rnnoise_size_pin_failure_is_a_pin_mismatch(tmp_path: Path) -> None:
    from podcast_mcp.services.pipeline.install_failure import classify
    from podcast_mcp.util import model_assets

    model = tmp_path / "rnnoise.rnnn"
    model.write_bytes(b"short")
    with pytest.raises(AssetSourceError) as raised:
        model_assets._verify_pinned_size(model, 297646)
    failure = classify(
        raised.value, label="RNNoise", fix="podcast bootstrap --component rnnoise --upgrade"
    )
    assert failure is not None
    assert failure.kind == "pin_mismatch"
    assert failure.plain.endswith("Run: podcast bootstrap --component rnnoise --upgrade")
    assert str(tmp_path) not in failure.plain
