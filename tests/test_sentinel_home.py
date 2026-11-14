from __future__ import annotations

import os
from pathlib import Path

from podcast_mcp.services.share_auth.store import default_identity_db_path, get_identity_store
from podcast_mcp.util import host_platform
from sentinel_home import THIRD_PARTY_PREFIXES, TOOLCHAIN_CACHES, passthrough_env, stray_files


def test_the_session_home_is_not_the_developers_home(_sentinel_home: Path) -> None:
    assert Path.home() == _sentinel_home
    assert Path(os.environ["HOME"]) == _sentinel_home
    assert host_platform.data_roots().state.is_relative_to(_sentinel_home)


def test_the_identity_store_opens_inside_the_test_folder(tmp_path: Path) -> None:
    assert default_identity_db_path() == tmp_path / "share_identity.sqlite"
    store = get_identity_store()
    assert store.path == tmp_path / "share_identity.sqlite"


def test_a_stray_file_in_the_session_home_is_reported_and_an_empty_folder_is_not(
    tmp_path: Path,
) -> None:
    (tmp_path / ".podcast_mcp").mkdir()
    (tmp_path / ".podcast_mcp" / "share_identity.sqlite").write_bytes(b"x")
    (tmp_path / "Documents").mkdir()
    assert stray_files(tmp_path) == [".podcast_mcp/share_identity.sqlite"]


def test_third_party_telemetry_is_not_reported(tmp_path: Path) -> None:
    for prefix in THIRD_PARTY_PREFIXES:
        target = tmp_path / prefix / "DeveloperTools"
        target.mkdir(parents=True)
        (target / "telemetry.json").write_bytes(b"{}")
    assert stray_files(tmp_path) == []


def test_toolchain_caches_keep_their_real_place(tmp_path: Path) -> None:
    env = passthrough_env(tmp_path, {"CARGO_HOME": "/elsewhere"})
    assert "CARGO_HOME" not in env
    assert env["UV_CACHE_DIR"] == str(tmp_path / ".cache" / "uv")
    assert set(env) == set(TOOLCHAIN_CACHES) - {"CARGO_HOME"}


def test_the_model_cache_keeps_its_real_place_only_where_it_exists(tmp_path: Path) -> None:
    assert "PODCAST_MCP_CACHE" not in passthrough_env(tmp_path, {})
    (tmp_path / ".cache" / "podcast_mcp").mkdir(parents=True)
    assert passthrough_env(tmp_path, {})["PODCAST_MCP_CACHE"] == str(
        tmp_path / ".cache" / "podcast_mcp"
    )


def test_a_revoke_window_does_not_arm_a_real_timer() -> None:
    from podcast_mcp.services.collaboration import share_pending

    assert share_pending.start_sweep_timer(60.0, lambda: None) is None
