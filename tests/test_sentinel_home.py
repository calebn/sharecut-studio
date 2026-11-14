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
    chosen = Path(os.environ["PODCAST_SHARE_IDENTITY"])
    assert default_identity_db_path() == chosen
    assert get_identity_store().path == chosen
    assert chosen.parent == tmp_path or chosen.parent != Path.home()


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
    for relative in TOOLCHAIN_CACHES.values():
        (tmp_path / relative).mkdir(parents=True)
    env = passthrough_env(tmp_path, {"CARGO_HOME": "/elsewhere"})
    assert "CARGO_HOME" not in env
    assert env["UV_CACHE_DIR"] == str(tmp_path / ".cache" / "uv")
    assert set(env) == set(TOOLCHAIN_CACHES) - {"CARGO_HOME"}
    assert "PIP_CACHE_DIR" not in passthrough_env(tmp_path, {"pip_cache_dir": "/elsewhere"})
    assert passthrough_env(tmp_path / "empty", {}) == {}


def test_the_model_cache_keeps_its_real_place_only_where_it_exists(tmp_path: Path) -> None:
    assert "PODCAST_MCP_CACHE" not in passthrough_env(tmp_path, {})
    (tmp_path / ".cache" / "podcast_mcp").mkdir(parents=True)
    assert passthrough_env(tmp_path, {})["PODCAST_MCP_CACHE"] == str(
        tmp_path / ".cache" / "podcast_mcp"
    )


def test_a_revoke_window_does_not_arm_a_real_timer() -> None:
    from podcast_mcp.services.collaboration import share_pending

    assert share_pending.start_sweep_timer(60.0, lambda: None) is None


def test_the_sweep_timer_arms_no_thread() -> None:
    import threading

    from podcast_mcp.services.collaboration import share_pending

    before = {t for t in threading.enumerate() if isinstance(t, threading.Timer)}
    share_pending.start_sweep_timer(60.0, lambda: None)
    assert {t for t in threading.enumerate() if isinstance(t, threading.Timer)} == before


def test_an_identity_store_made_in_one_test_is_gone_in_the_next_part_one() -> None:
    assert get_identity_store() is not None


def test_an_identity_store_made_in_one_test_is_gone_in_the_next_part_two() -> None:
    from podcast_mcp.services.share_auth import store

    assert store._STORE is None


def test_the_identity_pin_follows_the_job_only_when_it_chose_outside_the_home(
    monkeypatch, tmp_path: Path
) -> None:
    from conftest import _job_chose_identity

    monkeypatch.delenv("PODCAST_SHARE_IDENTITY", raising=False)
    assert not _job_chose_identity()
    monkeypatch.setenv("PODCAST_SHARE_IDENTITY", str(Path.home() / ".podcast_mcp" / "i.sqlite"))
    assert not _job_chose_identity()
    monkeypatch.setenv("PODCAST_SHARE_IDENTITY", str(tmp_path / "i.sqlite"))
    assert _job_chose_identity()


def test_a_file_outside_the_telemetry_folders_under_cache_is_reported(tmp_path: Path) -> None:
    (tmp_path / ".cache" / "Microsoft").mkdir(parents=True)
    (tmp_path / ".cache" / "Microsoft" / "t").write_bytes(b"x")
    (tmp_path / ".cache" / "other").mkdir()
    (tmp_path / ".cache" / "other" / "f").write_bytes(b"x")
    assert stray_files(tmp_path) == [".cache/other/f"]


def _run_session(tmp_path: Path, body: str, extra_env: dict[str, str] | None = None):
    import subprocess
    import sys

    project = tmp_path / "proj"
    project.mkdir()
    here = Path(__file__).parent
    (project / "conftest.py").write_text(
        "import importlib.util\nimport sys\n"
        f"sys.path.insert(0, {str(here)!r})\n"
        f"spec = importlib.util.spec_from_file_location('real_conftest', {str(here / 'conftest.py')!r})\n"
        "real = importlib.util.module_from_spec(spec)\n"
        "sys.modules['real_conftest'] = real\n"
        "spec.loader.exec_module(real)\n"
        "_sentinel_home = real._sentinel_home\n"
        "_isolate_share_identity = real._isolate_share_identity\n"
    )
    (project / "test_probe.py").write_text("import os\nfrom pathlib import Path\n\n" + body)
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"PODCAST_SHARE_IDENTITY", "CARGO_HOME", "PODCAST_MCP_CACHE"}
    }
    env.update(extra_env or {})
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-p",
            "no:cacheprovider",
            "--no-cov",
            "-c",
            "/dev/null",
        ],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_the_session_fails_when_a_test_writes_into_the_home(tmp_path: Path) -> None:
    result = _run_session(
        tmp_path,
        "def test_writes():\n"
        "    target = Path.home() / '.podcast_mcp'\n"
        "    target.mkdir()\n"
        "    (target / 'x.sqlite').write_bytes(b'x')\n",
    )
    assert result.returncode != 0
    assert "tests wrote outside their temp roots" in result.stdout + result.stderr


def test_the_session_defaults_and_cache_passthrough_apply(tmp_path: Path) -> None:
    real = tmp_path / "realhome"
    (real / ".cargo").mkdir(parents=True)
    result = _run_session(
        tmp_path,
        "def test_env():\n"
        "    home = Path(os.environ['HOME'])\n"
        "    for name in ('PODCAST_SHARE_IDENTITY', 'PODCAST_MCP_CACHE'):\n"
        "        assert not Path(os.environ[name]).is_relative_to(home)\n"
        f"    assert os.environ['CARGO_HOME'] == {str(real / '.cargo')!r}\n"
        f"    assert os.environ['PODCAST_SHARE_REGISTRY'] == {str(tmp_path / 'job.sqlite')!r}\n",
        {
            "HOME": str(real),
            "USERPROFILE": str(real),
            "PODCAST_SHARE_REGISTRY": str(tmp_path / "job.sqlite"),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
