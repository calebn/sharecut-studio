from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

import conftest
from podcast_mcp.config import runtime
from podcast_mcp.services.media import review_media
from podcast_mcp.util import object_store

_CONFIG = """object_store:
  endpoint_url: https://storage.example.test
  region: test-region
  bucket: test-bucket
  access_key_id: test-key
  secret_access_key: test-secret
"""


@pytest.fixture
def loaded_paths(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    paths: list[Path] = []
    read = runtime._read_mapping

    def record(path: Path):
        paths.append(path)
        return read(path)

    monkeypatch.setattr(runtime, "_read_mapping", record)
    return paths


def test_autouse_config_uses_real_loaders_outside_tmp_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, loaded_paths: list[Path]
) -> None:
    host = tmp_path.parent / "host-config.yaml"
    host.write_text(_CONFIG, encoding="utf-8")
    monkeypatch.setenv("PODCAST_RELAY_CONFIG", str(host))
    assert runtime.load_object_store_config().bucket == "test-bucket"
    loaded_paths.clear()
    for load in (object_store.load_object_store_config, review_media.load_object_store_config):
        assert load() is None
        assert load(host).bucket == "test-bucket"
    private, explicit, second, second_explicit = loaded_paths
    assert private == second
    assert explicit == second_explicit == host
    assert private.name == "relay.yaml"
    assert private.read_text("utf-8") == "{}\n"
    assert not private.is_relative_to(tmp_path)
    assert list(tmp_path.iterdir()) == []
    private.write_text(_CONFIG, encoding="utf-8")
    assert object_store.load_object_store_config().bucket == "test-bucket"
    assert review_media.load_object_store_config().bucket == "test-bucket"
    monkeypatch.setenv("PODCAST_OBJECT_STORE_BUCKET", "live-override")
    assert object_store.load_object_store_config().bucket == "live-override"


def test_fresh_config_and_loader_restoration_with_reused_tmp_path(
    monkeypatch: pytest.MonkeyPatch,
    _object_store_config_parent: Path,
    loaded_paths: list[Path],
    tmp_path: Path,
) -> None:
    before = object_store.load_object_store_config
    configs = []
    for _ in range(2):
        with monkeypatch.context() as patch:
            for key in conftest._OBJECT_STORE_ENV_KEYS:
                patch.setenv(key, "host-value")
            conftest._isolate_host_object_store.__wrapped__(patch, _object_store_config_parent)
            assert not any(key in os.environ for key in conftest._OBJECT_STORE_ENV_KEYS)
            assert object_store.load_object_store_config() is None
            current = loaded_paths[-1]
            assert current.read_text("utf-8") == "{}\n"
            assert current not in configs
            configs.append(current)
            current.write_text(_CONFIG, encoding="utf-8")
            assert review_media.load_object_store_config().bucket == "test-bucket"
            patch.setattr(object_store, "load_object_store_config", lambda: "per-test-patch")
            assert object_store.load_object_store_config() == "per-test-patch"
        assert object_store.load_object_store_config is before
    assert configs[0].parent != configs[1].parent
    assert configs[0].parent.parent == configs[1].parent.parent == _object_store_config_parent
    assert list(tmp_path.iterdir()) == []


def test_config_allocation_failure_does_not_reuse_another_test(
    monkeypatch: pytest.MonkeyPatch,
    _object_store_config_parent: Path,
    loaded_paths: list[Path],
) -> None:
    assert object_store.load_object_store_config() is None
    original = loaded_paths[-1]
    before = set(_object_store_config_parent.iterdir())

    def fail(**kwargs):
        raise OSError("allocation failed")

    monkeypatch.setattr(conftest.tempfile, "mkdtemp", fail)
    with pytest.raises(OSError, match="allocation failed"):
        conftest._isolate_host_object_store.__wrapped__(monkeypatch, _object_store_config_parent)
    assert set(_object_store_config_parent.iterdir()) == before
    assert original.read_text("utf-8") == "{}\n"


def test_private_parent_failure_prevents_config_creation(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> None:
    created: list[Path] = []
    allocate = tmp_path_factory.mktemp

    def record(name: str) -> Path:
        path = allocate(name)
        created.append(path)
        return path

    monkeypatch.setattr(tmp_path_factory, "mktemp", record)
    if os.name == "nt":
        run = subprocess.run

        def fail_acl(arguments, **kwargs):
            if Path(arguments[0]).name.lower() == "icacls.exe":
                raise subprocess.CalledProcessError(1, arguments)
            return run(arguments, **kwargs)

        monkeypatch.setattr(subprocess, "run", fail_acl)
        error = subprocess.CalledProcessError
    else:

        def fail_acl(path: Path) -> None:
            raise PermissionError("private parent refused")

        monkeypatch.setattr(conftest, "_make_windows_test_directory_private", fail_acl)
        error = PermissionError
    with pytest.raises(error):
        conftest._object_store_config_parent.__wrapped__(tmp_path_factory)
    assert len(created) == 1
    assert list(created[0].iterdir()) == []


def test_config_parent_child_and_yaml_are_private(loaded_paths: list[Path]) -> None:
    assert object_store.load_object_store_config() is None
    path = loaded_paths[-1]
    if os.name == "nt":
        from podcast_mcp.util.registry_backup_windows import _WindowsAPI

        api = _WindowsAPI()
        for entry, directory in ((path.parent.parent, True), (path.parent, True), (path, False)):
            handle = api.open_directory(entry) if directory else api.open_file(entry)
            try:
                api.verify_handle(handle, private=True, directory=directory, path=entry)
            finally:
                api.close(handle)
    else:
        for directory in (path.parent.parent, path.parent):
            assert directory.stat().st_mode & 0o077 == 0
            assert directory.stat().st_mode & 0o700 == 0o700
