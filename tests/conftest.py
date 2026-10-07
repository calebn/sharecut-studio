from __future__ import annotations

import os
import subprocess
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.config import repo_root
from podcast_mcp.edits.review_shares import create_share
from podcast_mcp.edits.share_capabilities import ALL_CAPABILITIES
from podcast_mcp.edits.share_registry import reset_share_registry_for_tests
from podcast_mcp.models import EpisodeProject, Track, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests
from podcast_mcp.util import object_store as object_store_util
from podcast_mcp.util import pinned_media
from podcast_mcp.util.binaries import resolve_ffmpeg
from process_caches import reset_isolated_caches

_REPO_PIPELINE_DEFAULTS = repo_root() / ".agents" / "defaults" / "pipeline.yaml"

_OBJECT_STORE_ENV_KEYS = (
    "PODCAST_OBJECT_STORE_ENDPOINT_URL",
    "PODCAST_OBJECT_STORE_REGION",
    "PODCAST_OBJECT_STORE_BUCKET",
    "PODCAST_OBJECT_STORE_ACCESS_KEY_ID",
    "PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY",
    "PODCAST_OBJECT_STORE_CDN_ENDPOINT",
)

_SESSION_AUTHZ_ENV_KEYS = (
    "PODCAST_SESSION_AUTHZ",
    "PODCAST_SESSION_TOKEN",
)


def automatic_xdist_workers(cpu_count: int | None) -> int:
    """Return a conservative worker count for pytest-xdist's auto mode."""
    return min(4, max(1, cpu_count or 1))


def pytest_xdist_auto_num_workers(config: pytest.Config) -> int:
    """Cap only ``-n auto``; explicit ``-n N`` values remain untouched."""
    del config
    return automatic_xdist_workers(os.cpu_count())


@pytest.fixture(autouse=True)
def _isolate_host_limiters() -> None:
    """Prevent singleton rate-limit settings and leases from leaking between tests."""
    reset_host_limiters_for_tests()
    try:
        yield
    finally:
        reset_host_limiters_for_tests()


@pytest.fixture(autouse=True)
def _isolate_share_registry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Pin the host share registry to a per-test sqlite file.

    Tests that need a specific path (verbatim-override / two-registry cases)
    still ``setenv`` explicitly; the singleton is reset around every test so a
    connection never outlives its ``tmp_path``.
    """
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_path / "share_registry.sqlite"))
    reset_share_registry_for_tests()
    try:
        yield
    finally:
        reset_share_registry_for_tests()


@pytest.fixture(autouse=True)
def _isolate_relay_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Keep relay.yaml, the relay host_id and tunnel status out of the developer's home."""
    from podcast_mcp.services.collaboration import tunnel_status

    monkeypatch.setenv("PODCAST_RELAY_CONFIG", str(tmp_path / "relay.yaml"))
    monkeypatch.delenv("PODCAST_RELAY_HOST_ID", raising=False)
    for name in ("PODCAST_RELAY_URL", "PODCAST_RELAY_HOST_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(tunnel_status, "cache_dir", lambda: tmp_path / "machine-cache")


@pytest.fixture(autouse=True)
def _isolate_process_caches() -> Iterator[None]:
    """No cached answer (Silero unavailable, a mocked probe) outlives the test that made it."""
    reset_isolated_caches()
    yield
    reset_isolated_caches()


@pytest.fixture(autouse=True)
def _repo_pipeline_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """Isolate unit tests from PODCAST_MCP_PIPELINE_DEFAULTS in the shell."""
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(_REPO_PIPELINE_DEFAULTS))


@pytest.fixture(autouse=True)
def _hide_host_word_aligner(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Unit tests never see the developer's downloaded word aligner (#780).

    Forced alignment is on whenever the snapshot is installed, so a test that transcribes
    with default options would otherwise load the real model on a machine that has it.
    Tests plant a fake snapshot (``model_pin_helpers.plant_pinned_word_aligner``) or stub
    ``WordAligner.load``; ``e2e_real`` tests keep the host cache.
    """
    if request.node.get_closest_marker("e2e_real"):
        return
    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    monkeypatch.setattr(
        "podcast_mcp.config.word_aligner_cache_dir", lambda: tmp_path / "word-aligner"
    )


@pytest.fixture(autouse=True)
def _transcript_refine_gate_off_by_default(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep existing edit/pipeline unit tests green; opt in with @pytest.mark.refine_gate."""
    if request.node.get_closest_marker("refine_gate"):
        return
    import podcast_mcp.edits.transcript_refine_status as refine_mod

    monkeypatch.setattr(refine_mod, "refine_mode_from_defaults", lambda defaults=None: "off")


@pytest.fixture(autouse=True)
def _isolate_session_authz_env() -> None:
    """Clear session authz env leaked by SUTs that write os.environ directly.

    ``monkeypatch.delenv`` does not register undo when the key was already
    unset, so ``ensure_non_loopback_session_auth`` can leave strict mode on for
    the rest of an xdist worker (TestClient peer is ``testclient``, not loopback).
    """
    saved = {key: os.environ.pop(key, None) for key in _SESSION_AUTHZ_ENV_KEYS}
    try:
        yield
    finally:
        for key in _SESSION_AUTHZ_ENV_KEYS:
            os.environ.pop(key, None)
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value


@pytest.fixture(autouse=True)
def _isolate_host_object_store(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """Do not use host object-store credentials or environment in unit tests.

    Review-share audio otherwise redirects to configured storage and TestClient
    follows to a missing object (404). Explicit ``config_path`` and per-test
    monkeypatches still work.
    """
    for key in _OBJECT_STORE_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    empty = tmp_path_factory.mktemp("no_host_object_store") / "relay.yaml"
    empty.write_text("{}\n", encoding="utf-8")
    real_load = object_store_util.load_object_store_config

    def _load(config_path: Path | None = None):
        return real_load(config_path if config_path is not None else empty)

    monkeypatch.setattr(object_store_util, "load_object_store_config", _load)
    monkeypatch.setattr(
        "podcast_mcp.services.media.review_media.load_object_store_config",
        _load,
    )


@pytest.fixture
def one_phrase_copy_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    """Let the bleed gate trust a copy path from one short foreign phrase.

    The gate needs 30 s of the peer's speech before it trusts a copy path, which
    ``test_bleed_attenuation`` pins. Fixtures with one phrase test other behaviour.
    """
    from podcast_mcp.engines import bleed_gate

    monkeypatch.setattr(bleed_gate, "_MIN_PATH_FRAMES", 50)


@pytest.fixture
def tmp_workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "episode_ws"
    ws.mkdir()
    return ws


def _lavfi_wav(out: Path, source: str) -> Path:
    cmd = [resolve_ffmpeg(), "-y", "-f", "lavfi", "-i", source, "-ar", "48000", "-ac", "1"]
    try:
        subprocess.run([*cmd, str(out)], check=True, capture_output=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        pytest.skip(f"ffmpeg required for audio fixtures: {exc}")
    return out


@pytest.fixture(scope="session")
def sample_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _lavfi_wav(
        tmp_path_factory.mktemp("audio") / "tone.wav", "sine=frequency=440:duration=2"
    )


@pytest.fixture(scope="session")
def peaky_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """-22 LUFS with -0.5 dBTP clicks: +6 dB to -16 LUFS would put peaks at +5.5 dBTP."""
    return _lavfi_wav(
        tmp_path_factory.mktemp("audio") / "peaky.wav",
        "aevalsrc='0.1*sin(2*PI*220*t)"
        "+if(lt(mod(t,0.5),0.003),0.85*sin(2*PI*1000*t),0)':s=48000:d=6",
    )


@pytest.fixture(scope="session")
def dense_clicks_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Clicks every 10 ms: every re-drive just limits harder, so the limiter never reaches -16 LUFS."""
    return _lavfi_wav(
        tmp_path_factory.mktemp("audio") / "dense_clicks.wav",
        "aevalsrc='0.01*sin(2*PI*220*t)"
        "+if(lt(mod(t,0.01),0.0005),0.9*sin(2*PI*1000*t),0)':s=48000:d=6",
    )


@pytest.fixture(scope="session")
def short_peaky_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Shorter than the 400 ms loudness gate, so ebur128 reports no integrated loudness."""
    return _lavfi_wav(
        tmp_path_factory.mktemp("audio") / "short_peaky.wav",
        "aevalsrc='0.02*sin(2*PI*220*t)+if(lt(mod(t,0.1),0.003),0.85*sin(2*PI*1000*t),0)'"
        ":s=48000:d=0.3",
    )


@pytest.fixture(scope="session")
def gentle_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """-26 LUFS, -20 dBTP, 1.8 LU range: linear loudnorm reaches -16 LUFS."""
    return _lavfi_wav(
        tmp_path_factory.mktemp("audio") / "gentle.wav",
        "aevalsrc='(0.05+0.05*gte(mod(t,4),2))*sin(2*PI*220*t)':s=48000:d=8",
    )


@pytest.fixture
def minimal_project(tmp_workspace: Path, sample_wav: Path) -> Path:
    raw = tmp_workspace / "raw"
    raw.mkdir()
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("test_episode", str(tmp_workspace))
    project.ensure_dirs()
    return save_project(project)


@pytest.fixture
def envelope_project(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.timeline.tracks = [Track(id=track_id, label=track_id) for track_id in ("host", "guest")]
    save_project(project)
    return minimal_project


@pytest.fixture
def published_share(
    minimal_project: Path, sample_wav: Path
) -> Callable[..., tuple[ProjectWorkspace, dict[str, Any], dict[str, Any]]]:
    """Publish a review version, then mint a share from the saved project."""

    def make_share(
        *, capabilities: list[str] | None = None, label: str = "test"
    ) -> tuple[ProjectWorkspace, dict[str, Any], dict[str, Any]]:
        project = load_project(minimal_project)
        premix = Path(project.workspace_dir) / "artifacts" / "premix.wav"
        premix.parent.mkdir(parents=True, exist_ok=True)
        premix.write_bytes(sample_wav.read_bytes())
        save_project(project, minimal_project)
        ws = ProjectWorkspace.open(minimal_project)
        version = ReviewService(ws).publish(label=label)
        persisted_project = load_project(minimal_project)
        share = create_share(
            persisted_project,
            review_version_id=version["id"],
            capabilities=list(ALL_CAPABILITIES) if capabilities is None else capabilities,
        )
        return ws, version, share

    return make_share


@pytest.fixture
def pinned_media_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    """Route ``open_pinned_media`` through its Windows path fallback on any OS."""
    monkeypatch.setattr(os, "supports_dir_fd", set())
    monkeypatch.setattr(pinned_media, "_PATH_FALLBACK_PLATFORM", True)
    assert not pinned_media.descriptor_walk_supported()


@pytest.fixture
def raising_stop_tasks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make ``GuestWsConnection.stop_tasks`` run its real teardown, then raise.

    Guest WebSocket cleanup tests use this to prove that the concurrency slot and
    session presence are still released when task teardown fails.
    """
    from podcast_mcp.gui.routes.guest_ws_common import GuestWsConnection

    real_stop = GuestWsConnection.stop_tasks

    async def _stop_then_raise(self: GuestWsConnection) -> None:
        await real_stop(self)
        raise RuntimeError("stop_tasks boom")

    monkeypatch.setattr(GuestWsConnection, "stop_tasks", _stop_then_raise)


@pytest.fixture
def removed_session_clients(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Spy on ``SessionSyncService.remove_client`` and return the removed client ids in call order."""
    from podcast_mcp.services.session_sync.service import SessionSyncService

    removed: list[str] = []
    real_remove = SessionSyncService.remove_client

    def _spy_remove(
        self: SessionSyncService, client_id: str, *, generation: int | None = None
    ) -> None:
        removed.append(client_id)
        real_remove(self, client_id, generation=generation)

    monkeypatch.setattr(SessionSyncService, "remove_client", _spy_remove)
    return removed


class FakeRichProgress:
    """No-op fake for ``rich.progress.Progress``: records add_task/update/remove_task calls.

    A real ``Progress`` spins a background auto-refresh thread against real stderr;
    ``Progress.stop()`` does not guarantee that thread has exited before returning, so
    under CI's heavier scheduling a late write can land inside a *different* test's
    ``capsys`` capture (see #645). Every test that builds a ``CliProgressReporter`` with
    ``sys.stderr.isatty`` mocked True must go through this fixture instead of the real
    ``rich.progress`` module.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.ctor_kwargs = kwargs
        self.add_task_calls: list[dict[str, Any]] = []
        self.update_calls: list[tuple[Any, dict[str, Any]]] = []
        self.removed_tasks: list[Any] = []
        self._next_bar = 0

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None

    def add_task(self, label: str, total: int | float | None = 0) -> int:
        self._next_bar += 1
        self.add_task_calls.append({"label": label, "total": total})
        return self._next_bar

    def update(self, bar: Any, **kwargs: Any) -> None:
        self.update_calls.append((bar, kwargs))

    def remove_task(self, bar: Any) -> None:
        self.removed_tasks.append(bar)


@pytest.fixture
def fake_rich_progress() -> Iterator[type[FakeRichProgress]]:
    """Patch ``sys.modules["rich.progress"]`` so ``CliProgressReporter`` never starts a
    real background-thread Progress. Yields the fake class for call assertions."""
    module = MagicMock(
        BarColumn=MagicMock(),
        Progress=FakeRichProgress,
        SpinnerColumn=MagicMock(),
        TaskProgressColumn=MagicMock(),
        TextColumn=MagicMock(),
        TimeElapsedColumn=MagicMock(),
    )
    with patch.dict("sys.modules", {"rich.progress": module}):
        yield FakeRichProgress
