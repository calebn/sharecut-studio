from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from podcast_mcp.config import repo_root
from podcast_mcp.edits.share_registry import reset_share_registry_for_tests
from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests
from podcast_mcp.util import object_store as object_store_util

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
    """Keep relay.yaml and the persisted relay host_id out of the developer's home."""
    monkeypatch.setenv("PODCAST_RELAY_CONFIG", str(tmp_path / "relay.yaml"))
    monkeypatch.delenv("PODCAST_RELAY_HOST_ID", raising=False)


@pytest.fixture(autouse=True)
def _repo_pipeline_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """Isolate unit tests from PODCAST_MCP_PIPELINE_DEFAULTS in the shell."""
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(_REPO_PIPELINE_DEFAULTS))


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
        "podcast_mcp.services.review_media.load_object_store_config",
        _load,
    )


@pytest.fixture
def tmp_workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "episode_ws"
    ws.mkdir()
    return ws


@pytest.fixture(scope="session")
def sample_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("audio") / "tone.wav"
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-ar",
        "48000",
        "-ac",
        "1",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        pytest.skip(f"ffmpeg required for audio fixtures: {exc}")
    return out


@pytest.fixture
def minimal_project(tmp_workspace: Path, sample_wav: Path) -> Path:
    raw = tmp_workspace / "raw"
    raw.mkdir()
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("test_episode", str(tmp_workspace))
    project.ensure_dirs()
    return save_project(project)
