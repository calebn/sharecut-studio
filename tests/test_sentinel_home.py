from __future__ import annotations

import os
from pathlib import Path

import pytest

from podcast_mcp.services.share_auth.store import default_identity_db_path, get_identity_store
from podcast_mcp.util import host_platform
from sentinel_home import (
    REAL_MODEL_CACHE_FLAG,
    THIRD_PARTY_PREFIXES,
    TOOLCHAIN_CACHES,
    passthrough_env,
    stray_files,
)


def test_the_session_home_is_not_the_developers_home(_sentinel_home: Path) -> None:
    assert Path.home() == _sentinel_home
    assert Path(os.environ["HOME"]) == _sentinel_home
    assert Path(os.environ["USERPROFILE"]) == _sentinel_home
    assert host_platform.data_roots().state.is_relative_to(_sentinel_home)


def test_the_identity_store_opens_inside_the_test_folder(tmp_path: Path) -> None:
    from conftest import _JOB_IDENTITY

    chosen = Path(os.environ["PODCAST_SHARE_IDENTITY"])
    assert default_identity_db_path() == chosen
    assert get_identity_store().path == chosen
    assert _JOB_IDENTITY or chosen == tmp_path / "share_identity.sqlite"


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


def test_the_model_cache_keeps_its_real_place_only_when_asked_for_and_present(
    tmp_path: Path,
) -> None:
    flag = {REAL_MODEL_CACHE_FLAG: "1"}
    assert "PODCAST_MCP_CACHE" not in passthrough_env(tmp_path, flag)
    (tmp_path / ".cache" / "podcast_mcp").mkdir(parents=True)
    assert "PODCAST_MCP_CACHE" not in passthrough_env(tmp_path, {})
    assert passthrough_env(tmp_path, flag)["PODCAST_MCP_CACHE"] == str(
        tmp_path / ".cache" / "podcast_mcp"
    )


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


def test_a_job_value_counts_only_when_it_points_outside_the_real_home(tmp_path: Path) -> None:
    from conftest import REAL_HOME, _outside_real_home

    assert not _outside_real_home(None)
    assert not _outside_real_home("")
    assert not _outside_real_home(str(REAL_HOME / ".podcast_mcp" / "i.sqlite"))
    assert _outside_real_home(str(tmp_path / "i.sqlite"))


def test_a_file_outside_the_telemetry_folders_under_cache_is_reported(tmp_path: Path) -> None:
    (tmp_path / ".cache" / "Microsoft").mkdir(parents=True)
    (tmp_path / ".cache" / "Microsoft" / "t").write_bytes(b"x")
    (tmp_path / ".cache" / "other").mkdir()
    (tmp_path / ".cache" / "other" / "f").write_bytes(b"x")
    assert stray_files(tmp_path) == [".cache/other/f"]


def _run_session(tmp_path: Path, body: str, extra_env: dict[str, str] | None = None):
    import subprocess
    import sys

    import conftest as real_conftest

    project = tmp_path / "proj"
    project.mkdir(exist_ok=True)
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
        if k not in {"SHARECUT_TEST_ORIGINAL_ENV", *real_conftest._MANAGED_ENV}
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


def test_a_default_preset_inside_the_real_home_is_replaced(tmp_path: Path) -> None:
    real = tmp_path / "realhome"
    real.mkdir()
    inside = real / "mine.sqlite"
    result = _run_session(
        tmp_path,
        "def test_env():\n"
        "    home = Path(os.environ['HOME'])\n"
        "    assert not Path(os.environ['PODCAST_SHARE_REGISTRY']).is_relative_to(home)\n"
        f"    assert os.environ['PODCAST_SHARE_REGISTRY'] != {str(inside)!r}\n",
        {"HOME": str(real), "USERPROFILE": str(real), "PODCAST_SHARE_REGISTRY": str(inside)},
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_module_that_loads_defaults_at_import_leaves_the_real_home_alone(tmp_path: Path) -> None:
    real = tmp_path / "realhome"
    real.mkdir()
    result = _run_session(
        tmp_path,
        "from podcast_mcp.config.defaults import load_defaults\n\n"
        "DEFAULTS = load_defaults()\n\n\n"
        "def test_collected():\n"
        "    assert DEFAULTS\n",
        {"HOME": str(real), "USERPROFILE": str(real)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert list(real.iterdir()) == []


def test_a_worker_reads_the_real_home_back_from_the_first_import(tmp_path: Path) -> None:
    import json

    real = tmp_path / "realhome"
    real.mkdir()
    controller_state = tmp_path / "controller_state"
    controller_state.mkdir()
    preset = controller_state / "identity.sqlite"
    result = _run_session(
        tmp_path,
        "def test_env():\n"
        f"    assert Path(os.environ['PODCAST_SHARE_IDENTITY']).parent != Path({str(controller_state)!r})\n"
        f"    assert not Path(os.environ['PODCAST_SHARE_REGISTRY']).is_relative_to(Path({str(controller_state)!r}))\n",
        {
            "HOME": str(tmp_path / "controller_home"),
            "USERPROFILE": str(tmp_path / "controller_home"),
            "PODCAST_SHARE_IDENTITY": str(preset),
            "PODCAST_SHARE_REGISTRY": str(controller_state / "registry.sqlite"),
            "SHARECUT_TEST_ORIGINAL_ENV": json.dumps(
                {
                    "HOME": str(real),
                    "USERPROFILE": str(real),
                    "PODCAST_SHARE_IDENTITY": None,
                    "PODCAST_SHARE_REGISTRY": None,
                }
            ),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_session_fails_when_a_test_creates_artifacts_in_the_working_directory(
    tmp_path: Path,
) -> None:
    result = _run_session(
        tmp_path,
        "def test_writes():\n    (Path.cwd() / 'artifacts').mkdir()\n",
    )
    assert result.returncode != 0
    assert "workspace is the working directory" in result.stdout + result.stderr


def test_an_artifacts_folder_that_was_already_there_is_not_blamed_on_the_tests(
    tmp_path: Path,
) -> None:
    project = tmp_path / "proj"
    (project / "artifacts").mkdir(parents=True)
    result = _run_session(tmp_path, "def test_ok():\n    assert True\n")
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_session_root_sits_outside_the_real_home_and_is_removed_at_exit(
    tmp_path: Path,
) -> None:
    real = tmp_path / "realhome"
    real.mkdir()
    record = tmp_path / "home.txt"
    result = _run_session(
        tmp_path,
        f"def test_record():\n    Path({str(record)!r}).write_text(os.environ['HOME'])\n",
        {"HOME": str(real), "USERPROFILE": str(real)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    home = Path(record.read_text())
    assert not home.resolve().is_relative_to(real)
    assert not home.parent.exists()


@pytest.mark.skipif(os.name == "nt", reason="creating a symlink needs a privilege on Windows")
def test_a_symlink_in_the_session_home_is_reported(tmp_path: Path) -> None:
    (tmp_path / "link").symlink_to(tmp_path / "missing")
    assert stray_files(tmp_path) == ["link"]


def test_huggingface_writes_go_to_the_session_state_when_no_cache_is_passed_through(
    tmp_path: Path,
) -> None:
    real = tmp_path / "realhome"
    real.mkdir()
    result = _run_session(
        tmp_path,
        "def test_hf():\n"
        "    home = Path(os.environ['HOME'])\n"
        "    assert not Path(os.environ['HF_HOME']).is_relative_to(home)\n",
        {"HOME": str(real), "USERPROFILE": str(real)},
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_checkout_and_the_working_directory_are_both_watched_for_artifacts() -> None:
    import conftest
    from podcast_mcp.config.defaults import repo_root

    assert {repo_root() / "artifacts", Path.cwd() / "artifacts"} <= set(
        conftest._ARTIFACTS_AT_IMPORT
    )


def test_a_cache_that_exists_keeps_its_real_place_and_a_missing_one_gets_a_session_folder(
    tmp_path: Path,
) -> None:
    real = tmp_path / "realhome"
    (real / ".cache" / "huggingface").mkdir(parents=True)
    kept = _run_session(
        tmp_path,
        f"def test_hf():\n    assert os.environ['HF_HOME'] == {str(real / '.cache' / 'huggingface')!r}\n",
        {
            "HOME": str(real),
            "USERPROFILE": str(real),
            "HF_HOME": str(real / ".cache" / "huggingface"),
        },
    )
    assert kept.returncode == 0, kept.stdout + kept.stderr


def test_a_worker_gets_the_real_home_back_and_its_own_cache_folder(tmp_path: Path) -> None:
    import json

    real = tmp_path / "realhome"
    real.mkdir()
    controller_hf = tmp_path / "controller_state" / "huggingface"
    result = _run_session(
        tmp_path,
        "import sys\n\n\n"
        "def test_env():\n"
        f"    assert sys.modules['real_conftest'].REAL_HOME == Path({str(real)!r}).resolve()\n"
        f"    assert os.environ['HF_HOME'] != {str(controller_hf)!r}\n"
        "    assert not Path(os.environ['HF_HOME']).is_relative_to(Path(os.environ['HOME']))\n",
        {
            "HOME": str(tmp_path / "controller_home"),
            "USERPROFILE": str(tmp_path / "controller_home"),
            "HF_HOME": str(controller_hf),
            "SHARECUT_TEST_ORIGINAL_ENV": json.dumps(
                {"HOME": str(real), "USERPROFILE": str(real), "HF_HOME": None}
            ),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_an_identity_store_chosen_by_the_job_outside_the_home_is_left_alone(tmp_path: Path) -> None:
    real = tmp_path / "realhome"
    real.mkdir()
    chosen = tmp_path / "job" / "identity.sqlite"
    result = _run_session(
        tmp_path,
        f"def test_identity():\n    assert os.environ['PODCAST_SHARE_IDENTITY'] == {str(chosen)!r}\n",
        {"HOME": str(real), "USERPROFILE": str(real), "PODCAST_SHARE_IDENTITY": str(chosen)},
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_folder_that_only_starts_like_a_telemetry_folder_is_reported(tmp_path: Path) -> None:
    (tmp_path / ".cache" / "MicrosoftX").mkdir(parents=True)
    (tmp_path / ".cache" / "MicrosoftX" / "f").write_bytes(b"x")
    assert stray_files(tmp_path) == [".cache/MicrosoftX/f"]


def test_a_new_file_in_an_artifacts_folder_that_was_already_there_fails_the_session(
    tmp_path: Path,
) -> None:
    (tmp_path / "proj" / "artifacts").mkdir(parents=True)
    result = _run_session(
        tmp_path,
        "def test_writes():\n    (Path.cwd() / 'artifacts' / 'episode.sharecut.lock').write_bytes(b'')\n",
    )
    assert result.returncode != 0
    assert "workspace is the working directory" in result.stdout + result.stderr


def test_the_first_import_records_the_original_value_of_every_managed_variable(
    tmp_path: Path,
) -> None:
    real = tmp_path / "realhome"
    real_hf = real / ".cache" / "huggingface"
    real_hf.mkdir(parents=True)
    result = _run_session(
        tmp_path,
        "import json\\nimport sys\\n\\n\\n"
        "def test_snapshot():\\n"
        "    real = sys.modules['real_conftest']\\n"
        "    saved = json.loads(os.environ[real._ORIGINAL_ENV_KEY])\\n"
        "    assert set(saved) == set(real._MANAGED_ENV)\\n"
        f"    assert saved['HF_HOME'] == {str(real_hf)!r}\\n"
        f"    assert saved['HOME'] == {str(real)!r}\\n",
        {"HOME": str(real), "USERPROFILE": str(real), "HF_HOME": str(real_hf)},
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_checkout_is_watched_even_when_the_working_directory_is_elsewhere(
    tmp_path: Path,
) -> None:
    from podcast_mcp.config.defaults import repo_root

    result = _run_session(
        tmp_path,
        "import sys\\n\\n\\n"
        "def test_watched():\\n"
        "    real = sys.modules['real_conftest']\\n"
        f"    assert Path({str(repo_root() / 'artifacts')!r}) in real._ARTIFACTS_AT_IMPORT\\n"
        "    assert Path.cwd() / 'artifacts' in real._ARTIFACTS_AT_IMPORT\\n",
    )
    assert result.returncode == 0, result.stdout + result.stderr
