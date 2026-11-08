import errno
import os
from contextlib import contextmanager
from dataclasses import dataclass

import pytest

from podcast_mcp.util import owned_stage

pytestmark = pytest.mark.skipif(
    not owned_stage.owned_stage_supported(),
    reason="owned staging requires supported directory descriptor operations",
)


@dataclass(eq=False)
class _Acquisition:
    path: str
    descriptor: int
    closed: bool = False


class _DescriptorLedger:
    def __init__(self, monkeypatch):
        self.acquisitions: list[_Acquisition] = []
        self.live: dict[int, _Acquisition] = {}
        self.root_returns: list[_Acquisition] = []
        self._open = owned_stage.open_nofollow_dir
        self._open_root = owned_stage._open_root
        self._close = os.close
        monkeypatch.setattr(owned_stage, "open_nofollow_dir", self.open)
        monkeypatch.setattr(owned_stage, "_open_root", self.open_root)
        monkeypatch.setattr(os, "close", self.close)

    def open(self, path, **kwargs):
        descriptor = self._open(path, **kwargs)
        acquisition = _Acquisition(str(path), descriptor)
        self.acquisitions.append(acquisition)
        self.live[descriptor] = acquisition
        return descriptor

    def open_root(self, path):
        descriptor = self._open_root(path)
        self.root_returns.append(self.live[descriptor])
        return descriptor

    def close(self, descriptor):
        acquisition = self.live.pop(descriptor, None)
        self._close(descriptor)
        if acquisition is not None:
            acquisition.closed = True

    def matching(self, prefix):
        return [
            acquisition for acquisition in self.acquisitions if acquisition.path.startswith(prefix)
        ]


def _assert_closed(acquisitions):
    assert acquisitions, "expected at least one owned acquisition"
    unclosed = [acquisition for acquisition in acquisitions if not acquisition.closed]
    assert not unclosed, f"owned acquisitions without a successful close: {unclosed}"


def test_constructor_fstat_failure_closes_acquired_stage(tmp_path, monkeypatch):
    real_fstat = os.fstat
    ledger = _DescriptorLedger(monkeypatch)

    def failing_fstat(descriptor):
        acquisition = ledger.live.get(descriptor)
        if acquisition is not None and acquisition.path.startswith(".partial-"):
            raise OSError(errno.EIO, "injected stage fstat error")
        return real_fstat(descriptor)

    monkeypatch.setattr(os, "fstat", failing_fstat)
    with pytest.raises(OSError, match="injected stage fstat error") as caught:
        owned_stage.OwnedStage(tmp_path)

    assert caught.value.errno == errno.EIO
    assert len(ledger.matching(".partial-")) == 1
    assert len(ledger.root_returns) == 1
    _assert_closed(ledger.acquisitions)


def test_open_root_child_is_released_when_parent_close_raises(tmp_path, monkeypatch):
    root = tmp_path / "parent" / "child"
    root.mkdir(parents=True)
    real_fstat = os.fstat
    ledger = _DescriptorLedger(monkeypatch)
    close_errors = []

    def failing_close(descriptor):
        ledger.close(descriptor)
        if not close_errors:
            close_errors.append(descriptor)
            raise OSError(errno.EIO, "injected parent close error")

    monkeypatch.setattr(os, "close", failing_close)
    try:
        descriptor = owned_stage._open_root(root)
    except OSError as error:
        try:
            _assert_closed(ledger.acquisitions)
        except AssertionError as leak:
            error.add_note(str(leak))
        raise

    try:
        assert len(close_errors) == 1
        assert ledger.root_returns == [ledger.acquisitions[-1]]
        assert ledger.root_returns[0].descriptor == descriptor
        _assert_closed(ledger.acquisitions[:-1])
        assert real_fstat(descriptor).st_ino == root.stat().st_ino
    finally:
        owned_stage._close_descriptor(descriptor)
    _assert_closed(ledger.root_returns)


def test_cleanup_fstat_failure_closes_acquired_quarantine(tmp_path, monkeypatch):
    real_fstat = os.fstat
    ledger = _DescriptorLedger(monkeypatch)
    stage = owned_stage.OwnedStage(tmp_path)
    (stage.path / "owned").write_bytes(b"keep if uncertain")
    fstat_errors = []

    def failing_fstat(descriptor):
        acquisition = ledger.live.get(descriptor)
        if acquisition is not None and acquisition.path.startswith(".cleanup-"):
            fstat_errors.append(acquisition)
            raise OSError(errno.EIO, "injected quarantine fstat error")
        return real_fstat(descriptor)

    monkeypatch.setattr(os, "fstat", failing_fstat)
    stage.close()

    assert (stage.path / "owned").read_bytes() == b"keep if uncertain"
    assert len(fstat_errors) == 1
    assert fstat_errors == ledger.matching(".cleanup-")
    _assert_closed(ledger.acquisitions)
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

    ledger = _DescriptorLedger(monkeypatch)
    close_errors = []

    def failing_close(descriptor):
        acquisition = ledger.live.get(descriptor)
        ledger.close(descriptor)
        if acquisition is not None and acquisition.path.startswith(".partial-"):
            close_errors.append(acquisition)
            raise OSError(errno.EIO, "injected stage close error")

    monkeypatch.setattr(os, "close", failing_close)
    with pytest.raises(CodedValueError) as caught:
        PipelineService(workspace).export_variant(ExportTarget.PODCAST)

    assert caught.value.code == "export_variant_qc_failed"
    assert ledger.root_returns
    assert len(close_errors) == 1
    assert close_errors == ledger.matching(".partial-")
    _assert_closed(ledger.acquisitions)


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


@contextmanager
def _reuse_on_close(tmp_path, monkeypatch, path_prefix, *, same_inode):
    import fcntl

    real_open = owned_stage.open_nofollow_dir
    real_close = os.close
    real_fstat = os.fstat
    marker = tmp_path / "replacement-marker"
    marker.write_bytes(b"separately owned")
    target = None
    replacement = None
    original_identity = None
    foreign_close_attempts = []

    def opened(path, **kwargs):
        nonlocal target
        descriptor = real_open(path, **kwargs)
        if target is None and str(path).startswith(path_prefix):
            target = descriptor
        return descriptor

    def fstat(descriptor):
        assert descriptor != replacement, "observer inspected the replacement descriptor"
        return real_fstat(descriptor)

    def close(descriptor):
        nonlocal replacement, original_identity
        if descriptor == replacement:
            foreign_close_attempts.append(descriptor)
            return
        if descriptor != target or replacement is not None:
            real_close(descriptor)
            return

        original = real_fstat(descriptor)
        original_identity = (original.st_dev, original.st_ino)
        if same_inode:
            donor = os.open(".", os.O_RDONLY | os.O_DIRECTORY, dir_fd=descriptor)
        else:
            donor = os.open(marker, os.O_RDONLY)
        try:
            real_close(descriptor)
            replacement = fcntl.fcntl(donor, fcntl.F_DUPFD, descriptor)
            assert replacement == descriptor, "the control must reuse the released number"
        finally:
            real_close(donor)

    try:
        with monkeypatch.context() as scope:
            scope.setattr(owned_stage, "open_nofollow_dir", opened)
            scope.setattr(os, "close", close)
            scope.setattr(os, "fstat", fstat)
            yield scope

        assert replacement is not None
        current = real_fstat(replacement)
        assert ((current.st_dev, current.st_ino) == original_identity) is same_inode
        if not same_inode:
            assert os.read(replacement, 16) == b"separately owned"
        assert foreign_close_attempts == []
    finally:
        if replacement is not None:
            real_close(replacement)


@pytest.mark.parametrize("same_inode", [False, True], ids=["different-file", "same-inode"])
def test_constructor_observer_leaves_replacement_owned_by_control(
    tmp_path, monkeypatch, same_inode
):
    with _reuse_on_close(tmp_path, monkeypatch, ".partial-", same_inode=same_inode) as scope:
        test_constructor_fstat_failure_closes_acquired_stage(tmp_path, scope)


@pytest.mark.parametrize("child_open_fails", [False, True], ids=["return", "exception"])
def test_root_walk_observer_leaves_replacement_owned_by_control(
    tmp_path, monkeypatch, child_open_fails
):
    real_open = owned_stage.open_nofollow_dir

    def failing_open(path, **kwargs):
        if path == "child":
            raise OSError(errno.EIO, "injected child open error")
        return real_open(path, **kwargs)

    if child_open_fails:
        monkeypatch.setattr(owned_stage, "open_nofollow_dir", failing_open)
    with _reuse_on_close(tmp_path, monkeypatch, tmp_path.anchor, same_inode=True) as scope:
        if child_open_fails:
            with pytest.raises(OSError, match="injected child open error") as caught:
                test_open_root_child_is_released_when_parent_close_raises(tmp_path, scope)
            assert caught.value.errno == errno.EIO
            assert not getattr(caught.value, "__notes__", ())
        else:
            test_open_root_child_is_released_when_parent_close_raises(tmp_path, scope)


@pytest.mark.parametrize("attempt_close", [False, True], ids=["unclosed", "swallowed-close-error"])
def test_descriptor_ledger_rejects_unclosed_acquisition(tmp_path, monkeypatch, attempt_close):
    real_close = os.close
    close_attempts = []
    retained = None

    def failing_close(descriptor):
        if descriptor != retained:
            return real_close(descriptor)
        close_attempts.append(descriptor)
        raise OSError(errno.EIO, "injected error before close")

    if attempt_close:
        monkeypatch.setattr(os, "close", failing_close)
    ledger = _DescriptorLedger(monkeypatch)
    retained = owned_stage.open_nofollow_dir(tmp_path)
    try:
        if attempt_close:
            owned_stage._close_descriptor(retained)
        with pytest.raises(AssertionError, match="owned acquisitions without a successful close"):
            _assert_closed(ledger.acquisitions)
        assert close_attempts == ([retained] if attempt_close else [])
        assert os.fstat(retained).st_ino == tmp_path.stat().st_ino
    finally:
        real_close(retained)
