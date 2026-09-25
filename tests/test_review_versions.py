"""Review mix version publish / play / comment stamp."""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from podcast_mcp.edits import review_versions
from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.review_versions import (
    REVIEW_ARTIFACTS_RELDIR,
    attach_version,
    discard_created_version,
    encode_version_mp3,
    get_version,
    publish_version,
    resolve_source_mix,
    review_artifacts_dir,
    stage_version,
    version_audio_path,
    version_mp3_path,
)
from podcast_mcp.engines.play_audit import (
    master_source_hash,
    mastered_is_fresh,
    write_mastered_hash,
)
from podcast_mcp.history import HistoryManager
from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.services import PlayService, ProjectWorkspace, ReviewService
from podcast_mcp.services.review_media import review_guest_audio_path
from podcast_mcp.util.atomic_json import load_json_object
from podcast_mcp.util.binaries import resolve_ffmpeg

requires_safe_cleanup = pytest.mark.skipif(
    not review_versions._SAFE_STALE_CLEANUP_SUPPORTED,
    reason="descriptor-relative directory operations are unavailable",
)


@pytest.mark.parametrize("source", ["premix", "mastered"])
def test_publish_version_and_stamp_comment(minimal_project, sample_wav, tmp_workspace, source):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / f"{source}.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)

    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="v1 for guests", prefer=source)
    assert ver["label"] == "v1 for guests"
    assert ver["source"] == source
    persisted = load_project(minimal_project)
    assert [version.model_dump() for version in persisted.review.versions] == [ver]
    assert persisted.review.active_version_id == ver["id"]

    audio = Path(persisted.workspace_dir) / ver["audio_relpath"]
    assert audio.is_file()
    wav_bytes = audio.read_bytes()
    assert wav_bytes == sample_wav.read_bytes()
    assert hashlib.sha256(wav_bytes).hexdigest() == ver["sha256"]

    assert ver.get("mp3_relpath")
    mp3 = Path(persisted.workspace_dir) / ver["mp3_relpath"]
    assert mp3.is_file()
    assert mp3.stat().st_size > 0
    subprocess.run(
        [resolve_ffmpeg(), "-nostdin", "-v", "error", "-xerror", "-i", str(mp3), "-f", "null", "-"],
        check=True,
        capture_output=True,
        timeout=15,
    )

    c = add_comment(ws.project, body="On this mix", author="guest", timeline_start=1.0)
    assert c.review_version_id == ver["id"]

    transport = PlayService(ws).resolve_transport_path("review", track_id=ver["id"])
    assert transport.path == audio.resolve()
    assert transport.tier == "review"

    transport2 = PlayService(ws).resolve_transport_path(f"review:{ver['id']}")
    assert transport2.path == audio.resolve()


def test_publish_requires_mix(minimal_project):
    proj = load_project(minimal_project)
    with pytest.raises(FileNotFoundError):
        publish_version(proj, label="x")


def test_resolve_source_mix_ships_hashless_master_without_premix(minimal_project, sample_wav):
    """An episode with only mastered.wav (no premix to compare) publishes it as-is."""
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "mastered.wav").write_bytes(sample_wav.read_bytes())

    path, source = resolve_source_mix(proj, prefer="mastered")

    assert source == "mastered"
    assert path == (art / "mastered.wav").resolve()
    assert not (art / "mastered.hash").exists()


def test_failed_mp3_publish_removes_only_new_version(minimal_project, sample_wav, monkeypatch):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    source = art / "premix.wav"
    source.write_bytes(sample_wav.read_bytes())
    review_root = art / "review"
    previous = review_root / "previous"
    previous.mkdir(parents=True)
    sentinel = previous / "mix.wav"
    sentinel.write_bytes(b"existing review mix")
    monkeypatch.setattr(review_versions, "_new_id", lambda: "failed-pub")

    class FailingEngine:
        def export_mp3(self, wav, mp3, *, bitrate_kbps):
            assert wav == review_root / "failed-pub" / "mix.wav"
            assert wav.read_bytes() == source.read_bytes()
            mp3.write_bytes(b"partial mp3")
            raise RuntimeError("encode failed")

    with pytest.raises(RuntimeError, match="encode failed"):
        publish_version(proj, label="new", eng=FailingEngine())

    assert not (review_root / "failed-pub").exists()
    assert sentinel.read_bytes() == b"existing review mix"
    assert source.read_bytes() == sample_wav.read_bytes()
    assert proj.review.versions == []
    assert proj.review.active_version_id is None


def test_interrupted_publish_removes_new_version(minimal_project, sample_wav, monkeypatch):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(review_versions, "_new_id", lambda: "interrupted")

    class InterruptedEngine:
        def export_mp3(self, wav, mp3, *, bitrate_kbps):
            mp3.write_bytes(b"partial mp3")
            raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        publish_version(proj, label="new", eng=InterruptedEngine())

    assert not (art / "review" / "interrupted").exists()
    assert proj.review.versions == []


def test_failed_publish_after_review_root_retarget_preserves_new_target(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    old_target = tmp_workspace.parent / "review-old"
    new_target = tmp_workspace.parent / "review-new"
    old_target.mkdir()
    (new_target / "retargeted").mkdir(parents=True)
    sentinel = new_target / "retargeted" / "mix.wav"
    sentinel.write_bytes(b"unrelated review mix")
    review_root = art / "review"
    review_root.symlink_to(old_target, target_is_directory=True)
    monkeypatch.setattr(review_versions, "_new_id", lambda: "retargeted")

    class RetargetingEngine:
        def export_mp3(self, wav, mp3, *, bitrate_kbps):
            review_root.unlink()
            review_root.symlink_to(new_target, target_is_directory=True)
            mp3.write_bytes(b"partial mp3")
            raise RuntimeError("encode failed")

    with pytest.raises(RuntimeError, match="encode failed"):
        publish_version(proj, label="new", eng=RetargetingEngine())

    assert not (old_target / "retargeted").exists()
    assert sentinel.read_bytes() == b"unrelated review mix"
    assert proj.review.versions == []


def test_service_publish_failure_keeps_persisted_versions_unchanged(
    minimal_project, sample_wav, monkeypatch
):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(review_versions, "_new_id", lambda: "service-fail")

    def fail_export(self, wav, mp3, *, bitrate_kbps):
        mp3.write_bytes(b"partial mp3")
        raise RuntimeError("encode failed")

    monkeypatch.setattr(review_versions.FFmpegEngine, "export_mp3", fail_export)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(RuntimeError, match="encode failed"):
        ReviewService(ws).publish(label="new")

    assert not (art / "review" / "service-fail").exists()
    assert load_project(minimal_project).review.versions == []
    assert load_project(minimal_project).review.active_version_id is None


@pytest.mark.parametrize("failure", ["history", "commit"])
def test_service_publish_removes_media_after_persistence_failure(
    minimal_project, sample_wav, monkeypatch, failure
):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    existing = art / "review" / "existing"
    existing.mkdir(parents=True)
    sentinel = existing / "mix.wav"
    sentinel.write_bytes(b"existing review mix")
    monkeypatch.setattr(review_versions, "_new_id", lambda: "new-version")
    history_index = Path(project.workspace_dir) / "history" / "index.json"
    history_before = load_json_object(history_index)
    snapshots_dir = history_index.parent / "snapshots"
    snapshots_before = set(snapshots_dir.glob("*.json"))

    def export_mp3(self, wav, mp3, *, bitrate_kbps):
        mp3.write_bytes(b"encoded")

    monkeypatch.setattr(review_versions.FFmpegEngine, "export_mp3", export_mp3)
    if failure == "history":
        original_record = HistoryManager.record

        def fail_after_history(self, project, label, **kwargs):
            if label == "after publish review version":
                raise RuntimeError("history failed")
            return original_record(self, project, label, **kwargs)

        monkeypatch.setattr(HistoryManager, "record", fail_after_history)
    else:

        def fail_commit(self, project):
            raise RuntimeError("commit failed")

        monkeypatch.setattr(ProjectStore, "commit", fail_commit)

    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(RuntimeError, match=f"{failure} failed"):
        ReviewService(ws).publish(label="new")

    assert not (art / "review" / "new-version").exists()
    assert sentinel.read_bytes() == b"existing review mix"
    assert load_project(minimal_project).review.versions == []
    assert ws.project.review.versions == []
    assert load_json_object(history_index) == history_before
    assert set(snapshots_dir.glob("*.json")) == snapshots_before
    assert ProjectWorkspace.open(minimal_project).project.review.versions == []


def test_service_publish_preserves_media_if_commit_landed_before_error(
    minimal_project, sample_wav, monkeypatch
):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(review_versions, "_new_id", lambda: "committed")

    def export_mp3(self, wav, mp3, *, bitrate_kbps):
        mp3.write_bytes(b"encoded")

    monkeypatch.setattr(review_versions.FFmpegEngine, "export_mp3", export_mp3)
    original_commit = ProjectStore.commit

    def fail_after_commit(self, project):
        original_commit(self, project)
        raise RuntimeError("late commit error")

    monkeypatch.setattr(ProjectStore, "commit", fail_after_commit)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(RuntimeError, match="late commit error"):
        ReviewService(ws).publish(label="new")

    assert (art / "review" / "committed" / "mix.wav").is_file()
    assert (art / "review" / "committed" / "mix.mp3").is_file()
    assert [version.id for version in load_project(minimal_project).review.versions] == [
        "committed"
    ]
    assert [version.id for version in ws.project.review.versions] == ["committed"]


def test_service_publish_cleanup_failure_preserves_commit_error(
    minimal_project, sample_wav, monkeypatch
):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(review_versions, "_new_id", lambda: "cleanup-fail")
    monkeypatch.setattr(
        review_versions.FFmpegEngine,
        "export_mp3",
        lambda self, wav, mp3, *, bitrate_kbps: mp3.write_bytes(b"encoded"),
    )

    def fail_commit(self, project):
        raise RuntimeError("original commit error")

    def fail_cleanup(path, identity):
        raise OSError("cleanup error")

    monkeypatch.setattr(ProjectStore, "commit", fail_commit)
    monkeypatch.setattr("podcast_mcp.services.review.clean_created_version", fail_cleanup)
    ws = ProjectWorkspace.open(minimal_project)

    with pytest.raises(RuntimeError, match="original commit error"):
        ReviewService(ws).publish(label="new")

    assert (art / "review" / "cleanup-fail" / "mix.wav").is_file()
    assert load_project(minimal_project).review.versions == []
    assert ws.project.review.versions == []


requires_safe_failed_cleanup = pytest.mark.skipif(
    not review_versions._SAFE_FAILED_CLEANUP_SUPPORTED,
    reason="descriptor-relative directory operations are unavailable",
)


def _fail_publication(stage, project, project_path, monkeypatch):
    """Run a publication that fails at *stage* ("generation" or "persistence")."""
    if stage == "generation":

        class FailingEngine:
            def export_mp3(self, wav, mp3, *, bitrate_kbps):
                raise RuntimeError("encode failed")

        with pytest.raises(RuntimeError, match="encode failed"):
            publish_version(project, label="new", eng=FailingEngine())
        return
    monkeypatch.setattr(
        review_versions.FFmpegEngine,
        "export_mp3",
        lambda self, wav, mp3, *, bitrate_kbps: mp3.write_bytes(b"encoded"),
    )

    def fail_commit(self, project):
        raise RuntimeError("commit failed")

    monkeypatch.setattr(ProjectStore, "commit", fail_commit)
    with pytest.raises(RuntimeError, match="commit failed"):
        ReviewService(ProjectWorkspace.open(project_path)).publish(label="new")


@pytest.mark.parametrize("stage", ["generation", "persistence"])
@pytest.mark.parametrize("pinned", [pytest.param(True, marks=requires_safe_failed_cleanup), False])
def test_failed_publish_does_not_delete_replacement_directory(
    minimal_project, sample_wav, monkeypatch, stage, pinned
):
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", pinned)
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    review_root = art / "review"
    version_dir = review_root / "race"
    moved_original = review_root / "race-original"
    existing = review_root / "existing"
    existing.mkdir(parents=True)
    existing_mix = existing / "mix.wav"
    existing_mix.write_bytes(b"existing")
    monkeypatch.setattr(review_versions, "_new_id", lambda: "race")
    original_rename = os.rename
    raced = False

    def replace_before_quarantine(src, dst, *args, **kwargs):
        nonlocal raced
        is_target = (
            Path(os.fspath(src)).name == "race"
            and Path(os.fspath(dst)).name == review_versions._QUARANTINE_ENTRY
        )
        if is_target and not raced:
            raced = True
            original_rename(version_dir, moved_original)
            version_dir.mkdir()
            (version_dir / "mix.wav").write_bytes(b"replacement")
        return original_rename(src, dst, *args, **kwargs)

    monkeypatch.setattr(os, "rename", replace_before_quarantine)
    _fail_publication(stage, project, minimal_project, monkeypatch)

    assert raced, "quarantine rename was not intercepted; update the race hook"
    assert (moved_original / "mix.wav").read_bytes() == sample_wav.read_bytes()
    assert existing_mix.read_bytes() == b"existing"
    quarantine = list(
        review_root.glob(
            f"{review_versions._QUARANTINE_PREFIX}*/{review_versions._QUARANTINE_ENTRY}/mix.wav"
        )
    )
    assert len(quarantine) == 1
    assert quarantine[0].read_bytes() == b"replacement"
    assert load_project(minimal_project).review.versions == []


@pytest.mark.parametrize("stage", ["generation", "persistence"])
def test_failed_publish_cleans_up_without_descriptor_relative_ops(
    minimal_project, sample_wav, monkeypatch, stage
):
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", False)
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    review_root = art / "review"
    existing = review_root / "existing"
    existing.mkdir(parents=True)
    (existing / "mix.wav").write_bytes(b"existing")
    monkeypatch.setattr(review_versions, "_new_id", lambda: "fallback")
    _fail_publication(stage, project, minimal_project, monkeypatch)

    assert not (review_root / "fallback").exists()
    assert not list(review_root.glob(".failed-review-*"))
    assert (existing / "mix.wav").read_bytes() == b"existing"
    assert load_project(minimal_project).review.versions == []


def test_service_cleanup_uses_identity_recorded_at_creation(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.services import review as review_service

    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    review_root = art / "review"
    monkeypatch.setattr(review_versions, "_new_id", lambda: "swap")
    real_publish = review_service.stage_version

    def swapping_publish(p, *, on_media_created=None, **kwargs):
        def swap_then_notify(path, identity):
            path.rename(review_root / "swapped-original")
            path.mkdir()
            (path / "replacement.txt").write_bytes(b"replacement")
            if on_media_created is not None:
                on_media_created(path, identity)

        return real_publish(p, on_media_created=swap_then_notify, **kwargs)

    monkeypatch.setattr(review_service, "stage_version", swapping_publish)
    monkeypatch.setattr(
        review_versions.FFmpegEngine,
        "export_mp3",
        lambda self, wav, mp3, *, bitrate_kbps: mp3.write_bytes(b"encoded"),
    )

    def fail_commit(self, project):
        raise RuntimeError("commit failed")

    monkeypatch.setattr(ProjectStore, "commit", fail_commit)
    with pytest.raises(RuntimeError, match="commit failed"):
        ReviewService(ProjectWorkspace.open(minimal_project)).publish(label="new")

    assert (review_root / "swap" / "replacement.txt").read_bytes() == b"replacement"
    assert (review_root / "swapped-original").is_dir()
    assert not list(review_root.glob(".failed-review-*"))
    assert load_project(minimal_project).review.versions == []


def test_publish_identity_failure_removes_empty_version_dir(
    minimal_project, sample_wav, monkeypatch
):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(review_versions, "_new_id", lambda: "stat-fail")
    original_stat = Path.stat

    def failing_stat(self, *args, **kwargs):
        if self.name == "stat-fail":
            raise OSError("stat failed")
        return original_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", failing_stat)
    with pytest.raises(OSError, match="stat failed"):
        publish_version(project, label="new")
    assert not os.path.lexists(art / "review" / "stat-fail")
    assert load_project(minimal_project).review.versions == []


def test_failed_publish_cleanup_error_preserves_original_error(
    minimal_project, sample_wav, monkeypatch
):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(review_versions, "_new_id", lambda: "cleanup-bug")

    def broken_cleanup(version_dir, identity):
        raise ValueError("cleanup bug")

    monkeypatch.setattr(review_versions, "clean_created_version", broken_cleanup)
    _fail_publication("generation", project, minimal_project, monkeypatch)

    assert (art / "review" / "cleanup-bug").is_dir()
    assert load_project(minimal_project).review.versions == []


@pytest.mark.parametrize("pinned", [pytest.param(True, marks=requires_safe_failed_cleanup), False])
def test_failed_publish_keeps_quarantine_when_rmtree_fails(
    minimal_project, sample_wav, monkeypatch, pinned
):
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", pinned)
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(review_versions, "_new_id", lambda: "rmtree-fail")

    def fail_rmtree(*args, **kwargs):
        raise OSError("rmtree failed")

    monkeypatch.setattr(review_versions.shutil, "rmtree", fail_rmtree)
    _fail_publication("generation", project, minimal_project, monkeypatch)

    review_root = art / "review"
    assert not (review_root / "rmtree-fail").exists()
    kept = list(review_root.glob(".failed-review-*/media/mix.wav"))
    assert len(kept) == 1
    assert load_project(minimal_project).review.versions == []


def _created_version_dir(tmp_path):
    version_dir = tmp_path / "review" / "created"
    version_dir.mkdir(parents=True)
    (version_dir / "mix.wav").write_bytes(b"partial")
    return version_dir, review_versions._dir_identity(version_dir.stat(follow_symlinks=False))


@pytest.mark.parametrize("pinned", [pytest.param(True, marks=requires_safe_failed_cleanup), False])
def test_clean_created_version_keeps_directory_replaced_before_check(tmp_path, monkeypatch, pinned):
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", pinned)
    version_dir, identity = _created_version_dir(tmp_path)
    original = version_dir.with_name("original")
    version_dir.rename(original)
    version_dir.mkdir()
    (version_dir / "mix.wav").write_bytes(b"replacement")

    review_versions.clean_created_version(version_dir, identity)

    assert (version_dir / "mix.wav").read_bytes() == b"replacement"
    assert (original / "mix.wav").read_bytes() == b"partial"
    assert not list(version_dir.parent.glob(".failed-review-*"))


def test_clean_created_version_mkdtemp_failure_keeps_directory(tmp_path, monkeypatch):
    version_dir, identity = _created_version_dir(tmp_path)

    def fail_mkdtemp(*args, **kwargs):
        raise OSError("mkdtemp failed")

    monkeypatch.setattr(review_versions.tempfile, "mkdtemp", fail_mkdtemp)
    with pytest.raises(OSError, match="mkdtemp failed"):
        review_versions.clean_created_version(version_dir, identity)
    assert (version_dir / "mix.wav").read_bytes() == b"partial"


@requires_safe_failed_cleanup
def test_clean_created_version_quarantine_open_failure_keeps_directory(tmp_path, monkeypatch):
    version_dir, identity = _created_version_dir(tmp_path)
    real_open = review_versions._open_pinned_dir

    def fail_quarantine_open(path, *args, **kwargs):
        if Path(path).name.startswith(".failed-review-"):
            raise OSError("quarantine open failed")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(review_versions, "_open_pinned_dir", fail_quarantine_open)
    with pytest.raises(OSError, match="quarantine open failed"):
        review_versions.clean_created_version(version_dir, identity)
    assert (version_dir / "mix.wav").read_bytes() == b"partial"
    assert not list(version_dir.parent.glob(".failed-review-*"))


@pytest.mark.parametrize("pinned", [pytest.param(True, marks=requires_safe_failed_cleanup), False])
def test_clean_created_version_missing_directory_is_noop(tmp_path, monkeypatch, caplog, pinned):
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", pinned)
    version_dir, identity = _created_version_dir(tmp_path)
    shutil.rmtree(version_dir)

    with caplog.at_level(logging.DEBUG, logger="podcast_mcp.edits.review_versions"):
        review_versions.clean_created_version(version_dir, identity)

    assert not os.path.lexists(version_dir)
    assert not list(version_dir.parent.glob(".failed-review-*"))
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


@requires_safe_failed_cleanup
def test_clean_created_version_close_failure_still_releases_everything(tmp_path, monkeypatch):
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", True)
    version_dir, identity = _created_version_dir(tmp_path)
    real_open = review_versions._open_pinned_dir
    pinned_fds = []

    def tracking_open(path, *args, **kwargs):
        fd = real_open(path, *args, **kwargs)
        pinned_fds.append(fd)
        return fd

    real_close = os.close
    closed = []

    def flaky_close(fd):
        real_close(fd)
        if fd in pinned_fds:
            closed.append(fd)
            if len(closed) == 1:
                raise OSError("close failed")

    monkeypatch.setattr(review_versions, "_open_pinned_dir", tracking_open)
    monkeypatch.setattr(review_versions.os, "close", flaky_close)
    review_versions.clean_created_version(version_dir, identity)

    assert len(pinned_fds) == 2
    assert sorted(closed) == sorted(pinned_fds)
    assert not os.path.lexists(version_dir)
    assert not list(version_dir.parent.glob(".failed-review-*"))


def test_publish_id_collision_preserves_existing_directory(
    minimal_project, sample_wav, monkeypatch
):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    existing = art / "review" / "same-id"
    existing.mkdir(parents=True)
    sentinel = existing / "mix.wav"
    sentinel.write_bytes(b"existing review mix")
    monkeypatch.setattr(review_versions, "_new_id", lambda: "same-id")

    with pytest.raises(FileExistsError):
        publish_version(proj, label="new")

    assert sentinel.read_bytes() == b"existing review mix"
    assert proj.review.versions == []


def test_list_and_set_active(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = ReviewService(ws)
    a = svc.publish(label="A")
    b = svc.publish(label="B", set_active=False)
    persisted = load_project(minimal_project)
    assert [version.model_dump() for version in persisted.review.versions] == [a, b]
    assert persisted.review.active_version_id == a["id"]

    rows = svc.list_versions()
    assert len(rows) == 2
    assert any(r["id"] == a["id"] and r["active"] for r in rows)
    svc.set_active(b["id"])
    assert ws.project.review.active_version_id == b["id"]
    persisted = load_project(minimal_project)
    assert [version.model_dump() for version in persisted.review.versions] == [a, b]
    assert persisted.review.active_version_id == b["id"]
    path = version_audio_path(persisted, b["id"])
    assert path.is_file()


def _publish(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="v1")
    return load_project(minimal_project), ver["id"]


def test_version_paths_stay_under_review_root(minimal_project, sample_wav, tmp_workspace):
    p, vid = _publish(minimal_project, sample_wav)
    root = review_artifacts_dir(p).resolve()
    assert version_audio_path(p, vid).is_relative_to(root)
    mp3 = version_mp3_path(p, vid)
    assert mp3 is not None
    assert mp3.is_relative_to(root)


@pytest.mark.parametrize("failure", [RuntimeError("encode failed"), KeyboardInterrupt()])
def test_failed_mp3_retry_never_exposes_partial_file(
    minimal_project, sample_wav, tmp_workspace, failure
):
    project, version_id = _publish(minimal_project, sample_wav)
    version = get_version(project, version_id)
    original_metadata = version.model_dump()
    wav = version_audio_path(project, version_id)
    wav_bytes = wav.read_bytes()
    mp3 = version_mp3_path(project, version_id)
    assert mp3 is not None
    mp3.unlink()

    class FailingEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            assert source == wav
            assert output.suffix == ".mp3"
            assert output != mp3
            output.write_bytes(b"partial mp3")
            raise failure

    with pytest.raises(type(failure)) as caught:
        encode_version_mp3(project, version_id, eng=FailingEngine())

    assert caught.value is failure
    assert version_mp3_path(project, version_id) is None
    assert review_guest_audio_path(project, version_id) == wav
    assert not list(mp3.parent.glob(".mix-*.mp3"))
    assert wav.read_bytes() == wav_bytes
    assert version.model_dump() == original_metadata

    class SuccessfulEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            output.write_bytes(b"complete mp3")

    result = encode_version_mp3(project, version_id, eng=SuccessfulEngine())
    assert result == mp3
    assert version_mp3_path(project, version_id) == mp3
    assert mp3.read_bytes() == b"complete mp3"


@requires_safe_cleanup
def test_mp3_retry_cleans_only_bounded_stale_regular_files(
    minimal_project, sample_wav, tmp_workspace
):
    project, version_id = _publish(minimal_project, sample_wav)
    mp3 = version_mp3_path(project, version_id)
    assert mp3 is not None
    mp3.unlink()
    version_dir = mp3.parent
    old_time = time.time() - review_versions._STALE_MP3_TEMP_AGE_SECONDS - 60
    stale = [version_dir / f".mix-old-{index}.mp3" for index in range(33)]
    for path in stale:
        path.write_bytes(b"orphan")
        os.utime(path, (old_time, old_time))
    fresh = version_dir / ".mix-live.mp3"
    fresh.write_bytes(b"live retry")
    unrelated = version_dir / "unrelated.mp3"
    unrelated.write_bytes(b"keep")
    outside = tmp_workspace.parent / "outside-review-mp3"
    outside.write_bytes(b"outside")
    symlink = version_dir / ".mix-link.mp3"
    symlink.symlink_to(outside)

    class SuccessfulEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            assert fresh.read_bytes() == b"live retry"
            output.write_bytes(b"complete")

    assert encode_version_mp3(project, version_id, eng=SuccessfulEngine()) == mp3
    assert 1 <= sum(path.exists() for path in stale) <= 3
    assert fresh.read_bytes() == b"live retry"
    assert unrelated.read_bytes() == b"keep"
    assert symlink.is_symlink()
    assert outside.read_bytes() == b"outside"
    assert version_audio_path(project, version_id).is_file()
    assert mp3.read_bytes() == b"complete"


@requires_safe_cleanup
def test_mp3_retry_continues_when_stale_cleanup_fails(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    project, version_id = _publish(minimal_project, sample_wav)
    mp3 = version_mp3_path(project, version_id)
    assert mp3 is not None
    mp3.unlink()
    stale = mp3.parent / ".mix-orphan.mp3"
    stale.write_bytes(b"orphan")
    old_time = time.time() - review_versions._STALE_MP3_TEMP_AGE_SECONDS - 60
    os.utime(stale, (old_time, old_time))
    original_unlink = os.unlink
    attempts = 0

    def refuse_stale_unlink(path, *args, **kwargs):
        nonlocal attempts
        if path == stale.name and kwargs.get("dir_fd") is not None:
            attempts += 1
            raise PermissionError("cannot remove stale file")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(os, "unlink", refuse_stale_unlink)

    class SuccessfulEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            output.write_bytes(b"complete")

    assert encode_version_mp3(project, version_id, eng=SuccessfulEngine()) == mp3
    assert attempts == 1
    assert stale.read_bytes() == b"orphan"
    assert mp3.read_bytes() == b"complete"


@requires_safe_cleanup
def test_mp3_retry_caps_failed_stale_deletion_attempts(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    project, version_id = _publish(minimal_project, sample_wav)
    mp3 = version_mp3_path(project, version_id)
    assert mp3 is not None
    mp3.unlink()
    old_time = time.time() - review_versions._STALE_MP3_TEMP_AGE_SECONDS - 60
    stale = [mp3.parent / f".mix-unremovable-{index}.mp3" for index in range(33)]
    for path in stale:
        path.write_bytes(b"orphan")
        os.utime(path, (old_time, old_time))
    original_unlink = os.unlink
    attempted: list[str] = []

    def refuse_stale_unlink(path, *args, **kwargs):
        if isinstance(path, str) and path.startswith(".mix-unremovable-"):
            attempted.append(path)
            raise PermissionError("cannot remove stale file")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(os, "unlink", refuse_stale_unlink)

    class SuccessfulEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            output.write_bytes(b"complete")

    assert encode_version_mp3(project, version_id, eng=SuccessfulEngine()) == mp3
    assert len(attempted) == review_versions._STALE_MP3_TEMP_CLEANUP_LIMIT
    assert all(path.read_bytes() == b"orphan" for path in stale)
    assert mp3.read_bytes() == b"complete"


@requires_safe_cleanup
def test_stale_cleanup_pins_version_directory_during_retarget(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    project, version_id = _publish(minimal_project, sample_wav)
    version_dir = review_artifacts_dir(project) / version_id
    stale = version_dir / ".mix-orphan.mp3"
    stale.write_bytes(b"old orphan")
    old_time = time.time() - review_versions._STALE_MP3_TEMP_AGE_SECONDS - 60
    os.utime(stale, (old_time, old_time))
    other_dir = tmp_workspace.parent / "other-review-version"
    other_dir.mkdir()
    other_file = other_dir / stale.name
    other_file.write_bytes(b"other orphan")
    os.utime(other_file, (old_time, old_time))
    moved_dir = version_dir.with_name(f"{version_id}-moved")
    original_stat = os.stat
    retargeted = False

    def retarget_after_stat(path, *args, **kwargs):
        nonlocal retargeted
        metadata = original_stat(path, *args, **kwargs)
        if path == stale.name and kwargs.get("dir_fd") is not None and not retargeted:
            retargeted = True
            version_dir.rename(moved_dir)
            version_dir.symlink_to(other_dir, target_is_directory=True)
        return metadata

    monkeypatch.setattr(os, "stat", retarget_after_stat)
    review_versions._clean_stale_mp3_temps(version_dir)

    assert retargeted
    assert not (moved_dir / stale.name).exists()
    assert other_file.read_bytes() == b"other orphan"


@requires_safe_cleanup
def test_stale_cleanup_pins_parent_directory_during_retarget(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    project, version_id = _publish(minimal_project, sample_wav)
    review_root = review_artifacts_dir(project)
    version_dir = review_root / version_id
    stale = version_dir / ".mix-orphan.mp3"
    stale.write_bytes(b"old orphan")
    old_time = time.time() - review_versions._STALE_MP3_TEMP_AGE_SECONDS - 60
    os.utime(stale, (old_time, old_time))
    other_root = tmp_workspace.parent / "other-review-root"
    other_version = other_root / version_id
    other_version.mkdir(parents=True)
    other_file = other_version / stale.name
    other_file.write_bytes(b"other orphan")
    os.utime(other_file, (old_time, old_time))
    moved_root = review_root.with_name("review-moved")
    original_open = os.open
    retargeted = False

    def retarget_after_root_open(path, flags, *args, **kwargs):
        nonlocal retargeted
        if path == version_id and kwargs.get("dir_fd") is not None and not retargeted:
            retargeted = True
            review_root.rename(moved_root)
            review_root.symlink_to(other_root, target_is_directory=True)
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", retarget_after_root_open)
    review_versions._clean_stale_mp3_temps(version_dir)

    assert retargeted
    assert not (moved_root / version_id / stale.name).exists()
    assert other_file.read_bytes() == b"other orphan"


@requires_safe_cleanup
def test_mp3_retry_caps_failed_stale_stat_attempts(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    project, version_id = _publish(minimal_project, sample_wav)
    mp3 = version_mp3_path(project, version_id)
    assert mp3 is not None
    mp3.unlink()
    old_time = time.time() - review_versions._STALE_MP3_TEMP_AGE_SECONDS - 60
    stale = [mp3.parent / f".mix-stat-fail-{index}.mp3" for index in range(33)]
    for path in stale:
        path.write_bytes(b"orphan")
        os.utime(path, (old_time, old_time))
    original_stat = os.stat
    attempted: list[str] = []

    def refuse_stale_stat(path, *args, **kwargs):
        if isinstance(path, str) and path.startswith(".mix-stat-fail-"):
            attempted.append(path)
            raise FileNotFoundError("candidate disappeared")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(os, "stat", refuse_stale_stat)

    class SuccessfulEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            output.write_bytes(b"complete")

    assert encode_version_mp3(project, version_id, eng=SuccessfulEngine()) == mp3
    assert len(attempted) == review_versions._STALE_MP3_TEMP_CLEANUP_LIMIT
    assert mp3.read_bytes() == b"complete"


def test_mp3_retry_skips_cleanup_without_safe_directory_operations(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    project, version_id = _publish(minimal_project, sample_wav)
    mp3 = version_mp3_path(project, version_id)
    assert mp3 is not None
    mp3.unlink()
    stale = mp3.parent / ".mix-orphan.mp3"
    stale.write_bytes(b"orphan")
    monkeypatch.setattr(review_versions, "_SAFE_STALE_CLEANUP_SUPPORTED", False)

    class SuccessfulEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            output.write_bytes(b"complete")

    assert encode_version_mp3(project, version_id, eng=SuccessfulEngine()) == mp3
    assert stale.read_bytes() == b"orphan"
    assert mp3.read_bytes() == b"complete"


def test_mp3_retry_preserves_encode_error_if_temporary_cleanup_fails(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    project, version_id = _publish(minimal_project, sample_wav)
    mp3 = version_mp3_path(project, version_id)
    assert mp3 is not None
    mp3.unlink()
    failure = RuntimeError("encode failed")

    class FailingEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            output.write_bytes(b"partial mp3")
            raise failure

    original_unlink = Path.unlink

    def fail_temporary_unlink(path, *args, **kwargs):
        if path.name.startswith(".mix-"):
            raise PermissionError("cleanup failed")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_temporary_unlink)
    with pytest.raises(RuntimeError) as caught:
        encode_version_mp3(project, version_id, eng=FailingEngine())

    assert caught.value is failure
    assert version_mp3_path(project, version_id) is None
    assert review_guest_audio_path(project, version_id) == version_audio_path(project, version_id)


def test_mp3_retry_retargeted_review_root_preserves_other_media(
    minimal_project, sample_wav, tmp_workspace
):
    project = load_project(minimal_project)
    artifacts = Path(project.workspace_dir) / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "premix.wav").write_bytes(sample_wav.read_bytes())
    old_root = tmp_workspace.parent / "retry-review-old"
    new_root = tmp_workspace.parent / "retry-review-new"
    old_root.mkdir()
    new_root.mkdir()
    review_root = artifacts / "review"
    review_root.symlink_to(old_root, target_is_directory=True)
    version = publish_version(project, label="retry")
    mp3 = old_root / version.id / "mix.mp3"
    mp3.unlink()
    original_metadata = version.model_dump()
    wav = old_root / version.id / "mix.wav"
    wav_bytes = wav.read_bytes()
    (new_root / version.id).mkdir()
    other_mp3 = new_root / version.id / "mix.mp3"
    other_mp3.write_bytes(b"other valid mp3")

    class RetargetingEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            assert source == wav
            assert output.parent == old_root / version.id
            output.write_bytes(b"retry mp3")
            review_root.unlink()
            review_root.symlink_to(new_root, target_is_directory=True)

    with pytest.raises(RuntimeError, match="directory changed"):
        encode_version_mp3(project, version.id, eng=RetargetingEngine())

    assert not mp3.exists()
    assert not list(mp3.parent.glob(".mix-*.mp3"))
    assert other_mp3.read_bytes() == b"other valid mp3"
    assert wav.read_bytes() == wav_bytes
    assert version.model_dump() == original_metadata


def test_review_artifacts_dir_matches_writer_reldir(minimal_project, sample_wav, tmp_workspace):
    p, vid = _publish(minimal_project, sample_wav)
    assert review_artifacts_dir(p) == p.workspace_path() / REVIEW_ARTIFACTS_RELDIR
    assert get_version(p, vid).audio_relpath.startswith(f"{REVIEW_ARTIFACTS_RELDIR}/")


def test_shares_sidecar_lives_under_review_artifacts_dir(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.edits.review_shares import shares_path

    p, _vid = _publish(minimal_project, sample_wav)
    assert shares_path(p) == review_artifacts_dir(p) / "shares.json"


def test_version_paths_accept_legacy_spellings(minimal_project, sample_wav, tmp_workspace):
    p, vid = _publish(minimal_project, sample_wav)
    orig = get_version(p, vid).audio_relpath
    expected = version_audio_path(p, vid)

    get_version(p, vid).audio_relpath = "./" + orig
    assert version_audio_path(p, vid) == expected

    abs_path = str((Path(p.workspace_dir) / orig).resolve())
    get_version(p, vid).audio_relpath = abs_path
    assert version_audio_path(p, vid) == expected


@pytest.mark.parametrize(
    "make_relpath",
    [
        lambda p: "artifacts/review/../premix.wav",
        lambda p: "../outside.wav",
    ],
)
def test_version_audio_path_rejects_escape(
    minimal_project, sample_wav, tmp_workspace, make_relpath
):
    p, vid = _publish(minimal_project, sample_wav)
    (Path(p.workspace_dir) / "artifacts" / "premix.wav").write_bytes(sample_wav.read_bytes())
    outside = tmp_workspace.parent / "outside.wav"
    outside.write_bytes(sample_wav.read_bytes())

    get_version(p, vid).audio_relpath = make_relpath(p)
    with pytest.raises(ValueError, match="artifacts/review/"):
        version_audio_path(p, vid)

    abs_outside = str(outside)
    get_version(p, vid).audio_relpath = abs_outside
    with pytest.raises(ValueError, match="artifacts/review/") as excinfo:
        version_audio_path(p, vid)
    assert abs_outside not in str(excinfo.value)


def test_version_mp3_path_rejects_escape(minimal_project, sample_wav, tmp_workspace):
    p, vid = _publish(minimal_project, sample_wav)
    outside = tmp_workspace.parent / "outside.wav"
    outside.write_bytes(sample_wav.read_bytes())

    get_version(p, vid).mp3_relpath = "../outside.wav"
    with pytest.raises(ValueError, match="artifacts/review/"):
        version_mp3_path(p, vid)
    with pytest.raises(ValueError, match="artifacts/review/"):
        review_guest_audio_path(p, vid)

    original_mp3_relpath = get_version(p, vid).mp3_relpath
    with pytest.raises(ValueError, match="artifacts/review/"):
        encode_version_mp3(p, vid)
    assert get_version(p, vid).mp3_relpath == original_mp3_relpath


@pytest.mark.parametrize("field", ["audio_relpath", "mp3_relpath"])
def test_version_paths_reject_symlink_escape(minimal_project, sample_wav, tmp_workspace, field):
    p, vid = _publish(minimal_project, sample_wav)
    outside = tmp_workspace.parent / "outside.bin"
    outside.write_bytes(b"x")

    rel = getattr(get_version(p, vid), field)
    target = Path(p.workspace_dir) / rel
    target.unlink()
    try:
        target.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlinks unsupported: {exc}")

    with pytest.raises(ValueError, match="artifacts/review/"):
        if field == "audio_relpath":
            version_audio_path(p, vid)
        else:
            version_mp3_path(p, vid)


def test_publish_refuses_a_stale_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
            fader_db=-3.0,
        )
    ]
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)

    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="Refresh"):
        ReviewService(ws).publish(label="x")
    assert load_project(minimal_project).review.versions == []
    root = review_artifacts_dir(ws.project)
    assert not root.exists() or not any(root.iterdir())


def test_publish_mastered_refuses_a_master_without_a_hash(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    for name in ("premix", "mastered"):
        (art / f"{name}.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)

    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match=r"mastered\.wav has no record"):
        ReviewService(ws).publish(label="m", prefer="mastered")
    write_mastered_hash(ws.project, master_source_hash(ws.project))
    ver = ReviewService(ws).publish(label="m", prefer="mastered")
    assert ver["source"] == "mastered"


def test_publish_mastered_refuses_a_master_from_another_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    for name in ("premix", "mastered"):
        (art / f"{name}.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)

    ws = ProjectWorkspace.open(minimal_project)
    write_mastered_hash(ws.project, master_source_hash(ws.project))
    premix = art / "premix.wav"
    st = premix.stat()
    os.utime(premix, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))  # re-mixed or restored
    with pytest.raises(ValueError, match=r"wasn't mastered from the current premix"):
        ReviewService(ws).publish(label="m", prefer="mastered")


def test_publish_mastered_refuses_a_stale_premix_even_with_a_fresh_master(
    minimal_project, sample_wav
):
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
            fader_db=-3.0,
        )
    ]
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    for name in ("premix", "mastered"):
        (art / f"{name}.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)

    ws = ProjectWorkspace.open(minimal_project)
    write_mastered_hash(ws.project, master_source_hash(ws.project))
    assert mastered_is_fresh(ws.project)
    with pytest.raises(ValueError, match="any master built from it"):
        ReviewService(ws).publish(label="m", prefer="mastered")
    assert load_project(minimal_project).review.versions == []


def _premix_project(minimal_project, sample_wav, monkeypatch):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(
        review_versions.FFmpegEngine,
        "export_mp3",
        lambda self, wav, mp3, *, bitrate_kbps: mp3.write_bytes(b"encoded"),
    )
    return project, art


def test_stage_version_creates_media_without_touching_project(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    ver = stage_version(project, label="staged")
    assert (art / "review" / ver.id / "mix.wav").is_file()
    assert project.review.versions == []
    assert project.review.active_version_id is None


def test_attach_version_appends_and_optionally_activates(minimal_project, sample_wav, monkeypatch):
    project, _ = _premix_project(minimal_project, sample_wav, monkeypatch)
    first = stage_version(project, label="a")
    attach_version(project, first, set_active=False)
    assert [v.id for v in project.review.versions] == [first.id]
    assert project.review.active_version_id is None
    second = stage_version(project, label="b")
    attach_version(project, second)
    assert project.review.active_version_id == second.id


def test_publish_removes_staged_media_when_history_read_fails(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.services import review as review_service

    _, art = _premix_project(minimal_project, sample_wav, monkeypatch)

    def unreadable(path):
        raise ValueError(f"corrupt JSON sidecar: {path}")

    monkeypatch.setattr(review_service, "load_json_object", unreadable)
    with pytest.raises(ValueError, match="corrupt JSON sidecar"):
        ReviewService(ProjectWorkspace.open(minimal_project)).publish(label="x")
    review_root = art / "review"
    assert not review_root.exists() or not any(review_root.iterdir())
    assert load_project(minimal_project).review.versions == []


def test_discard_created_version_logs_and_never_raises(tmp_path, monkeypatch, caplog):
    def broken(version_dir, identity):
        raise OSError("cleanup error")

    monkeypatch.setattr(review_versions, "clean_created_version", broken)
    version_dir, identity = _created_version_dir(tmp_path)
    with caplog.at_level(logging.WARNING, logger=review_versions.__name__):
        discard_created_version(version_dir, identity)
    assert "Could not remove review version directory" in caplog.text


def test_attach_version_leaves_audio_fingerprint_unchanged(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.engines.reconciliation_state import audio_state_fingerprint

    project, _ = _premix_project(minimal_project, sample_wav, monkeypatch)
    before = audio_state_fingerprint(project)
    attach_version(project, stage_version(project, label="a"))
    assert audio_state_fingerprint(project) == before


def test_publish_keeps_committed_media_when_lock_release_fails(
    minimal_project, sample_wav, monkeypatch
):
    from contextlib import contextmanager

    from podcast_mcp.services import review as review_service

    _, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    monkeypatch.setattr(review_versions, "_new_id", lambda: "committed")
    real_lock = review_service.project_commit_lock

    @contextmanager
    def release_fails(project):
        with real_lock(project):
            yield
        raise OSError("lock release failed")

    monkeypatch.setattr(review_service, "project_commit_lock", release_fails)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(OSError, match="lock release failed"):
        ReviewService(ws).publish(label="new")
    assert (art / "review" / "committed" / "mix.wav").is_file()
    assert (art / "review" / "committed" / "mix.mp3").is_file()
    assert [v.id for v in load_project(minimal_project).review.versions] == ["committed"]
