from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp import settings
from podcast_mcp.config.defaults import cache_dir
from podcast_mcp.config.runtime import default_relay_config_path
from podcast_mcp.services.app.recent_projects import default_workspace_dir
from podcast_mcp.services.collaboration.share_registry import default_share_registry_db_path
from podcast_mcp.services.share_auth.store import default_identity_db_path
from podcast_mcp.services.support.diagnostics import default_bundle_dir, sidecar_log_candidates
from podcast_mcp.util.host_platform import IOS, MACOS

OVERRIDES = (
    "PODCAST_CONFIG_DIR",
    "PODCAST_MCP_CACHE",
    "PODCAST_RELAY_CONFIG",
    "PODCAST_SHARE_REGISTRY",
    "PODCAST_SHARE_IDENTITY",
    "PODCAST_WORKSPACE_ROOT",
    "LOCALAPPDATA",
    "XDG_STATE_HOME",
)


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for name in OVERRIDES:
        monkeypatch.delenv(name, raising=False)
    root = tmp_path.resolve() / "home"
    root.mkdir()
    monkeypatch.setenv("HOME", str(root))
    return root


def test_macos_defaults_are_the_dotfile_paths(home: Path, host) -> None:
    host(MACOS)
    assert settings.config_dir() == home / ".config/podcast_mcp"
    assert cache_dir() == home / ".cache/podcast_mcp"
    assert default_relay_config_path() == home / ".config/podcast_mcp/relay.yaml"
    assert default_share_registry_db_path() == home / ".podcast_mcp/share_registry.sqlite"
    assert default_identity_db_path() == home / ".podcast_mcp/share_identity.sqlite"
    assert default_bundle_dir() == home / "Downloads"
    assert sidecar_log_candidates() == [
        home / "Library/Logs/ShareCut Studio/sidecar.log",
        home / ".local/state/SharecutStudio/sidecar.log",
    ]


def test_ios_defaults_live_in_the_app_container(home: Path, host) -> None:
    host(IOS)
    assert settings.config_dir() == home / "Library/Application Support/ShareCut"
    assert cache_dir() == home / "Library/Caches/ShareCut"
    assert default_relay_config_path() == home / "Library/Application Support/ShareCut/relay.yaml"
    assert (
        default_share_registry_db_path()
        == home / "Library/Application Support/ShareCut/state/share_registry.sqlite"
    )
    assert (
        default_identity_db_path()
        == home / "Library/Application Support/ShareCut/state/share_identity.sqlite"
    )
    assert default_bundle_dir() == home / "Documents/Exports"
    assert sidecar_log_candidates() == [home / "Library/Logs/ShareCut/sidecar.log"]
    assert default_workspace_dir("Episode One") == home / "Documents/Episode One"


def test_macos_new_episodes_go_under_sharecut_in_home(home: Path, host) -> None:
    host(MACOS)
    assert default_workspace_dir("Episode One") == home / "ShareCut/Episode One"


def test_the_documented_defaults_are_the_desktop_paths() -> None:
    defaults = {variable.name: variable.default for variable in settings.VARIABLES}
    assert defaults["PODCAST_MCP_CACHE"] == "~/.cache/podcast_mcp"
    assert defaults["PODCAST_CONFIG_DIR"] == "~/.config/podcast_mcp"
    assert defaults["PODCAST_WORKSPACE_ROOT"] == "~/ShareCut"
    assert defaults["PODCAST_SHARE_REGISTRY"] == "~/.podcast_mcp/share_registry.sqlite"
    assert defaults["PODCAST_SHARE_IDENTITY"] == "~/.podcast_mcp/share_identity.sqlite"
    assert defaults["PODCAST_RELAY_CONFIG"] == "~/.config/podcast_mcp/relay.yaml"
