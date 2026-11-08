import errno
import os

import pytest

from podcast_mcp.util import owned_stage

pytestmark = pytest.mark.skipif(
    not owned_stage.owned_stage_supported(),
    reason="owned staging requires supported directory descriptor operations",
)


def _assert_closed(descriptors, real_fstat):
    for descriptor in descriptors:
        try:
            real_fstat(descriptor)
        except OSError as error:
            assert error.errno == errno.EBADF
        else:
            os.close(descriptor)
            pytest.fail(f"owned descriptor {descriptor} remained open")


def test_constructor_fstat_failure_closes_acquired_stage(tmp_path, monkeypatch):
    real_open = owned_stage.open_nofollow_dir
    real_open_root = owned_stage._open_root
    real_fstat = os.fstat
    acquired = []
    root_descriptors = []

    def tracked_root(path):
        descriptor = real_open_root(path)
        root_descriptors.append(descriptor)
        return descriptor

    def tracked_open(path, **kwargs):
        descriptor = real_open(path, **kwargs)
        if str(path).startswith(".partial-"):
            acquired.append(descriptor)
        return descriptor

    def failing_fstat(descriptor):
        if descriptor in acquired:
            raise OSError(errno.EIO, "injected stage fstat error")
        return real_fstat(descriptor)

    monkeypatch.setattr(owned_stage, "open_nofollow_dir", tracked_open)
    monkeypatch.setattr(owned_stage, "_open_root", tracked_root)
    monkeypatch.setattr(os, "fstat", failing_fstat)
    with pytest.raises(OSError, match="injected stage fstat error"):
        owned_stage.OwnedStage(tmp_path)

    assert len(acquired) == 1
    _assert_closed(acquired, real_fstat)
    assert len(root_descriptors) == 1
    _assert_closed(root_descriptors, real_fstat)


def test_open_root_child_is_released_when_parent_close_raises(tmp_path, monkeypatch):
    root = tmp_path / "parent" / "child"
    root.mkdir(parents=True)
    real_open = owned_stage.open_nofollow_dir
    real_close = os.close
    real_fstat = os.fstat
    acquired = []
    close_errors = []
    result = []
    injected = False

    def tracked_open(path, **kwargs):
        descriptor = real_open(path, **kwargs)
        acquired.append(descriptor)
        return descriptor

    def failing_close(descriptor):
        nonlocal injected
        real_close(descriptor)
        if not injected:
            injected = True
            close_errors.append(descriptor)
            raise OSError(errno.EIO, "injected parent close error")

    monkeypatch.setattr(owned_stage, "open_nofollow_dir", tracked_open)
    monkeypatch.setattr(os, "close", failing_close)
    try:
        try:
            result.append(owned_stage._open_root(root))
        except OSError:
            leaked = []
            for descriptor in set(acquired):
                try:
                    real_fstat(descriptor)
                except OSError:
                    continue
                leaked.append(descriptor)
            for descriptor in leaked:
                real_close(descriptor)
            assert not leaked, "_open_root leaked a child after parent close failed"
            raise
        assert len(close_errors) == 1
        assert acquired[-1] == result[0]
        _assert_closed(set(acquired) - {result[0]}, real_fstat)
        assert real_fstat(result[0]).st_ino == root.stat().st_ino
    finally:
        for descriptor in acquired:
            try:
                real_fstat(descriptor)
            except OSError:
                continue
            else:
                real_close(descriptor)


def test_cleanup_fstat_failure_closes_acquired_quarantine(tmp_path, monkeypatch):
    stage = owned_stage.OwnedStage(tmp_path)
    (stage.path / "owned").write_bytes(b"keep if uncertain")
    real_open = owned_stage.open_nofollow_dir
    real_fstat = os.fstat
    acquired = []

    def tracked_open(path, **kwargs):
        descriptor = real_open(path, **kwargs)
        if str(path).startswith(".cleanup-"):
            acquired.append(descriptor)
        return descriptor

    def failing_fstat(descriptor):
        if descriptor in acquired:
            raise OSError(errno.EIO, "injected quarantine fstat error")
        return real_fstat(descriptor)

    monkeypatch.setattr(owned_stage, "open_nofollow_dir", tracked_open)
    monkeypatch.setattr(os, "fstat", failing_fstat)
    stage.close()

    assert (stage.path / "owned").read_bytes() == b"keep if uncertain"
    assert len(acquired) == 1
    _assert_closed(acquired, real_fstat)
    stage.close()


def test_stage_close_error_preserves_qc_refusal_and_closes_root(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.engines.play_audit import premix_path
    from podcast_mcp.services.pipeline import ExportTarget, PipelineService
    from podcast_mcp.services.pipeline import service as service_module
    from podcast_mcp.util.coded_error import CodedValueError
    from test_export_variant import _current_mix, _FakeEngine

    workspace = _current_mix(minimal_project, sample_wav)
    engine = _FakeEngine(
        premix_path(workspace.project),
        qc={"integrated_lufs": -40.0, "true_peak_db": -2.0},
    )
    monkeypatch.setattr(service_module.pipeline_steps, "ffmpeg", lambda: engine)

    real_open_root = owned_stage._open_root
    real_open = owned_stage.open_nofollow_dir
    real_close = os.close
    real_fstat = os.fstat
    descriptors = {"root": None, "stage": None}

    def tracked_root(path):
        descriptor = real_open_root(path)
        descriptors["root"] = descriptor
        return descriptor

    def tracked_open(path, **kwargs):
        descriptor = real_open(path, **kwargs)
        if str(path).startswith(".partial-"):
            descriptors["stage"] = descriptor
        return descriptor

    def failing_close(descriptor):
        real_close(descriptor)
        if descriptor == descriptors["stage"]:
            raise OSError(errno.EIO, "injected stage close error")

    monkeypatch.setattr(owned_stage, "_open_root", tracked_root)
    monkeypatch.setattr(owned_stage, "open_nofollow_dir", tracked_open)
    monkeypatch.setattr(os, "close", failing_close)
    with pytest.raises(CodedValueError) as caught:
        PipelineService(workspace).export_variant(ExportTarget.PODCAST)

    assert caught.value.code == "export_variant_qc_failed"
    assert set(descriptors) == {"root", "stage"}
    assert all(descriptor is not None for descriptor in descriptors.values())
    _assert_closed(
        [descriptor for descriptor in descriptors.values() if descriptor is not None],
        real_fstat,
    )


def test_close_is_idempotent_and_removes_unpublished_stage(tmp_path):
    stage = owned_stage.OwnedStage(tmp_path)
    (stage.path / "owned").write_bytes(b"temporary")

    stage.close()
    stage.close()

    assert not stage.path.exists()


def test_publish_collision_preserves_existing_destination(tmp_path):
    stage = owned_stage.OwnedStage(tmp_path)
    (stage.path / "owned").write_bytes(b"staged")
    destination = tmp_path / "published"
    destination.mkdir()
    (destination / "foreign").write_bytes(b"keep")

    with pytest.raises(FileExistsError):
        stage.publish(destination.name)
    stage.close()

    assert (destination / "foreign").read_bytes() == b"keep"
