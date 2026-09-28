"""Review mix version publish / play / comment stamp."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from podcast_mcp.edits import review_versions
from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.review_versions import (
    REVIEW_ARTIFACTS_RELDIR,
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
from podcast_mcp.util.project_state import project_state_lock
from review_platform import requires_safe_cleanup, requires_safe_failed_cleanup


@requires_safe_failed_cleanup
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


def test_publish_reports_a_missing_mix_before_the_platform_refusal(minimal_project, monkeypatch):
    """The portable "no mix" check runs before the platform-support refusal."""
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", False)
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


@requires_safe_failed_cleanup
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
            assert wav.parent.name.startswith(review_versions._STAGING_PREFIX)
            assert wav.name == "mix.wav"
            assert wav.read_bytes() == source.read_bytes()
            mp3.write_bytes(b"partial mp3")
            raise RuntimeError("encode failed")

    created = []
    with pytest.raises(RuntimeError, match="encode failed"):
        publish_version(
            proj,
            label="new",
            eng=FailingEngine(),
            on_media_created=lambda path, identity: created.append(identity),
        )

    assert not (review_root / "failed-pub").exists()
    assert sentinel.read_bytes() == b"existing review mix"
    assert source.read_bytes() == sample_wav.read_bytes()
    assert proj.review.versions == []
    assert proj.review.active_version_id is None
    assert created[0] not in review_versions._active_stage_leases


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
def test_service_publish_keeps_media_when_history_was_not_rolled_back(
    minimal_project, sample_wav, monkeypatch, caplog
):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(review_versions, "_new_id", lambda: "new-version")

    def export_mp3(self, wav, mp3, *, bitrate_kbps):
        mp3.write_bytes(b"encoded")

    monkeypatch.setattr(review_versions.FFmpegEngine, "export_mp3", export_mp3)
    monkeypatch.setattr("podcast_mcp.history.rollback.rollback_own_history", lambda *a, **k: False)

    def fail_commit(self, project):
        raise RuntimeError("commit failed")

    monkeypatch.setattr(ProjectStore, "commit", fail_commit)
    ws = ProjectWorkspace.open(minimal_project)
    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError, match="commit failed"):
            ReviewService(ws).publish(label="new")

    assert (art / "review" / "new-version").exists()
    assert load_project(minimal_project).review.versions == []
    assert "Review history changed during failed publication" in caplog.text


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


def test_safe_failed_cleanup_requires_root_relative_mkdir():
    if os.mkdir not in os.supports_dir_fd:
        assert not review_versions._SAFE_FAILED_CLEANUP_SUPPORTED


def test_review_publication_support_matches_the_ci_platform():
    """Guard the CI split: publication support must be True on POSIX, False on Windows.

    ``desktop.yml``'s ``project-commit-lock-windows`` job skips the
    ``requires_safe_failed_cleanup`` / ``requires_safe_cleanup`` tests on the
    assumption that Windows never has safe, descriptor-relative directory
    operations. If a future Windows/Python change made these flags True there,
    CI would silently stop exercising publication anywhere. Conversely, POSIX CI
    must keep running them, or the publication paths go untested everywhere.
    """
    if sys.platform.startswith("win"):
        assert not review_versions._SAFE_STALE_CLEANUP_SUPPORTED
        assert not review_versions._SAFE_FAILED_CLEANUP_SUPPORTED
    else:
        assert review_versions._SAFE_STALE_CLEANUP_SUPPORTED
        assert review_versions._SAFE_FAILED_CLEANUP_SUPPORTED


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


@requires_safe_failed_cleanup
def test_failed_publish_keeps_replacement_during_quarantine(tmp_path, monkeypatch):
    version_dir, identity = _created_version_dir(tmp_path)
    original = version_dir.with_name("original")
    real_rename = os.rename

    def race(src, dst, *args, **kwargs):
        if src == version_dir.name and dst == review_versions._QUARANTINE_ENTRY:
            real_rename(version_dir, original)
            version_dir.mkdir()
            (version_dir / "mix.wav").write_bytes(b"replacement")
        return real_rename(src, dst, *args, **kwargs)

    monkeypatch.setattr(os, "rename", race)
    review_versions.clean_created_version(version_dir, identity)
    assert (original / "mix.wav").read_bytes() == b"partial"
    assert (version_dir / "mix.wav").read_bytes() == b"replacement"
    assert not list(version_dir.parent.glob(".failed-review-*/media"))
    assert not list(version_dir.parent.glob(".failed-review-*"))


def test_publication_fails_closed_without_safe_directory_operations(
    minimal_project, sample_wav, monkeypatch
):
    _, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", False)
    with pytest.raises(OSError, match="safe review publication"):
        ReviewService(ProjectWorkspace.open(minimal_project)).publish(label="new")
    assert not list((art / "review").glob("[!.]*"))
    assert not list((art / "review").glob(".staging-review-*"))
    assert load_project(minimal_project).review.versions == []


@requires_safe_failed_cleanup
def test_publication_rejects_writable_root_before_media_write(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    root = art / "review"
    root.mkdir()
    root.chmod(0o777)

    class UnexpectedEngine:
        def export_mp3(self, wav, mp3, *, bitrate_kbps):
            pytest.fail("encoding must not start in an untrusted review root")

    with pytest.raises(PermissionError, match="owned and private"):
        publish_version(project, label="new", eng=UnexpectedEngine())
    assert not list(root.glob(".staging-review-*"))


@requires_safe_failed_cleanup
@pytest.mark.parametrize("name", ["mix.wav", "mix.mp3"])
def test_staging_rejects_planted_output_symlink(minimal_project, sample_wav, monkeypatch, name):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    outside = art / "outside-media"
    outside.write_bytes(b"sentinel")

    def plant(path, identity):
        (path / name).symlink_to(outside)

    with pytest.raises(FileExistsError):
        publish_version(project, label="new", on_media_created=plant)
    assert outside.read_bytes() == b"sentinel"
    assert not project.review.versions


@requires_safe_failed_cleanup
def test_service_sweeps_before_taking_state_lock(minimal_project, sample_wav, monkeypatch):
    _premix_project(minimal_project, sample_wav, monkeypatch)
    acquired: list[bool] = []

    def probe(project):
        lock = project_state_lock(project)

        def worker():
            got = lock.acquire(timeout=0.5)
            acquired.append(got)
            if got:
                lock.release()

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(1)
        assert not thread.is_alive()

    monkeypatch.setattr("podcast_mcp.services.review.sweep_stale_quarantines", probe)
    monkeypatch.setattr(
        review_versions.FFmpegEngine,
        "export_mp3",
        lambda self, wav, mp3, *, bitrate_kbps: mp3.write_bytes(b"encoded"),
    )
    ReviewService(ProjectWorkspace.open(minimal_project)).publish(label="new")
    assert acquired == [True]


@requires_safe_failed_cleanup
def test_failed_publish_keeps_quarantine_when_rmtree_fails(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)

    def fail_rmtree(*args, **kwargs):
        raise OSError("rmtree failed")

    monkeypatch.setattr(review_versions.shutil, "rmtree", fail_rmtree)
    _fail_publication("generation", project, minimal_project, monkeypatch)
    kept = list((art / "review").glob(".failed-review-*/media/mix.wav"))
    assert len(kept) == 1
    assert load_project(minimal_project).review.versions == []


@requires_safe_failed_cleanup
def test_stale_quarantine_sweep_requires_marker_identity_and_age(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    review_root = art / "review"
    review_root.mkdir()
    created = review_root / "created"
    created.mkdir()
    (created / "mix.wav").write_bytes(b"partial")
    identity = review_versions._dir_identity(created.stat(follow_symlinks=False))
    real_rmtree = shutil.rmtree
    monkeypatch.setattr(
        review_versions.shutil, "rmtree", lambda *a, **kw: (_ for _ in ()).throw(OSError("busy"))
    )
    with pytest.raises(OSError, match="busy"):
        review_versions.clean_created_version(created, identity, project=project)
    monkeypatch.setattr(review_versions.shutil, "rmtree", real_rmtree)
    quarantine = next(review_root.glob(".failed-review-*"))
    marker = quarantine / review_versions._CLEANUP_MARKER
    old = time.time() - review_versions._STALE_QUARANTINE_AGE_SECONDS - 1
    os.utime(marker, (old, old))
    legacy = review_root / ".failed-review-legacy"
    (legacy / "media").mkdir(parents=True)
    review_versions.sweep_stale_quarantines(project)
    assert not quarantine.exists()
    assert legacy.is_dir()


def _marked_quarantine(review_root, name, *, stale):
    quarantine = review_root / name
    media = quarantine / "media"
    media.mkdir(parents=True)
    (media / "mix.wav").write_bytes(b"partial")
    identity = review_versions._dir_identity(media.stat(follow_symlinks=False))
    marker = quarantine / review_versions._CLEANUP_MARKER
    marker.write_text(json.dumps({"name": "created", "dev": identity[0], "ino": identity[1]}))
    marker.chmod(0o600)
    if stale:
        old = time.time() - review_versions._STALE_QUARANTINE_AGE_SECONDS - 1
        os.utime(marker, (old, old))
    return quarantine


@requires_safe_failed_cleanup
def test_quarantine_sweep_keeps_fresh_and_symlink_entries(minimal_project, sample_wav, monkeypatch):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    root = art / "review"
    root.mkdir()
    fresh = _marked_quarantine(root, ".failed-review-fresh", stale=False)
    outside = art / "outside"
    outside.mkdir()
    symlink = root / ".failed-review-link"
    symlink.symlink_to(outside, target_is_directory=True)
    review_versions.sweep_stale_quarantines(project)
    assert (fresh / "media" / "mix.wav").is_file()
    assert symlink.is_symlink()
    assert outside.is_dir()


@requires_safe_failed_cleanup
def test_quarantine_sweep_inspects_at_most_32_entries(minimal_project, sample_wav, monkeypatch):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    root = art / "review"
    root.mkdir()
    entries = [
        _marked_quarantine(root, f".failed-review-{i:02}", stale=True)
        for i in range(review_versions._STALE_QUARANTINE_LIMIT + 1)
    ]
    review_versions.sweep_stale_quarantines(project)
    assert sum(not entry.exists() for entry in entries) <= review_versions._STALE_QUARANTINE_LIMIT
    assert any(entry.exists() for entry in entries)


@requires_safe_failed_cleanup
def test_quarantine_creation_stays_in_pinned_root_after_symlink_retarget(tmp_path, monkeypatch):
    pinned = tmp_path / "pinned" / "review"
    other = tmp_path / "other" / "review"
    pinned.mkdir(parents=True)
    other.mkdir(parents=True)
    link = tmp_path / "workspace"
    link.symlink_to(pinned.parent, target_is_directory=True)
    version_dir = link / "review" / "created"
    version_dir.mkdir()
    (version_dir / "mix.wav").write_bytes(b"partial")
    identity = review_versions._dir_identity(version_dir.stat(follow_symlinks=False))
    real_mkdir = os.mkdir

    def retarget_before_mkdir(path, *args, **kwargs):
        if str(path).startswith(review_versions._QUARANTINE_PREFIX):
            link.unlink()
            link.symlink_to(other.parent, target_is_directory=True)
            result = real_mkdir(path, *args, **kwargs)
            assert (pinned / path).is_dir()
            assert not (other / path).exists()
            return result
        return real_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(os, "mkdir", retarget_before_mkdir)
    review_versions.clean_created_version(version_dir, identity)
    assert not (pinned / "created").exists()
    assert not list(other.glob(".failed-review-*"))
    assert not list(pinned.glob(".failed-review-*"))


@requires_safe_failed_cleanup
def test_public_directory_invisible_during_encode(minimal_project, sample_wav, monkeypatch):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    monkeypatch.setattr(review_versions, "_new_id", lambda: "invisible")

    class InspectingEngine:
        def export_mp3(self, wav, mp3, *, bitrate_kbps):
            assert wav.parent.name.startswith(review_versions._STAGING_PREFIX)
            assert wav.parent.stat().st_mode & 0o777 == 0o700
            assert not (art / "review" / "invisible").exists()
            mp3.write_bytes(b"encoded")

    created = []
    publish_version(
        project,
        label="ready",
        eng=InspectingEngine(),
        on_media_created=lambda path, identity: created.append(identity),
    )
    assert (art / "review" / "invisible" / "mix.mp3").read_bytes() == b"encoded"
    assert created[0] not in review_versions._active_stage_leases


@requires_safe_failed_cleanup
def test_other_process_claims_public_name_before_promotion(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    monkeypatch.setattr(review_versions, "_new_id", lambda: "claimed")
    real_promote = review_versions._rename_noreplace

    def claim_then_promote(src, dst, root_fd):
        subprocess.run(
            [
                sys.executable,
                "-c",
                "from pathlib import Path; import sys; p=Path(sys.argv[1]); "
                "p.mkdir(); (p/'mix.wav').write_bytes(b'other process')",
                str(art / "review" / dst),
            ],
            check=True,
        )
        real_promote(src, dst, root_fd)

    monkeypatch.setattr(review_versions, "_rename_noreplace", claim_then_promote)
    with pytest.raises(FileExistsError):
        publish_version(project, label="race")
    assert (art / "review" / "claimed" / "mix.wav").read_bytes() == b"other process"
    assert not list((art / "review").glob(".staging-review-*"))


@requires_safe_failed_cleanup
def test_other_process_replaces_name_during_quarantine(tmp_path, monkeypatch):
    version_dir, identity = _created_version_dir(tmp_path)
    original = version_dir.with_name("original")
    real_rename = os.rename

    def replace_then_quarantine(src, dst, *args, **kwargs):
        if src == version_dir.name and dst == review_versions._QUARANTINE_ENTRY:
            subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "from pathlib import Path; import sys; a=Path(sys.argv[1]); "
                    "a.rename(sys.argv[2]); a.mkdir(); "
                    "(a/'mix.wav').write_bytes(b'other process')",
                    str(version_dir),
                    str(original),
                ],
                check=True,
            )
        return real_rename(src, dst, *args, **kwargs)

    monkeypatch.setattr(os, "rename", replace_then_quarantine)
    review_versions.clean_created_version(version_dir, identity)
    assert (version_dir / "mix.wav").read_bytes() == b"other process"
    assert (original / "mix.wav").read_bytes() == b"partial"


@requires_safe_failed_cleanup
def test_staging_identity_failure_never_exposes_public_version(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    monkeypatch.setattr(review_versions, "_new_id", lambda: "identity-failed")
    monkeypatch.setattr(
        review_versions,
        "_created_dir_identity",
        lambda path: (_ for _ in ()).throw(OSError("identity read failed")),
    )
    with pytest.raises(OSError, match="identity read failed"):
        publish_version(project, label="new")
    assert not (art / "review" / "identity-failed").exists()
    assert not list((art / "review").glob(".staging-review-*"))


@requires_safe_failed_cleanup
def test_initial_stage_stat_failure_uses_pinned_identity_for_cleanup(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    real_stat = review_versions.os.stat
    failed = False

    def fail_once(path, *args, **kwargs):
        nonlocal failed
        if (
            not failed
            and str(path).startswith(review_versions._STAGING_PREFIX)
            and kwargs.get("dir_fd") is not None
        ):
            failed = True
            raise OSError("transient stat failure")
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(review_versions.os, "stat", fail_once)
    monkeypatch.setattr(
        review_versions,
        "_created_dir_identity",
        lambda path: (_ for _ in ()).throw(OSError("identity read failed")),
    )
    with pytest.raises(OSError, match="identity read failed"):
        publish_version(project, label="new")
    assert failed
    assert not list((art / "review").glob(".staging-review-*"))


@requires_safe_failed_cleanup
def test_staging_replacement_during_identity_read_is_rejected(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    real_identity = review_versions._created_dir_identity

    def replace_stage(path):
        path.rename(path.with_name("saved-stage"))
        path.mkdir()
        (path / "mix.wav").write_bytes(b"replacement")
        return real_identity(path)

    monkeypatch.setattr(review_versions, "_created_dir_identity", replace_stage)
    with pytest.raises(RuntimeError, match="changed during creation"):
        publish_version(project, label="new")
    assert (art / "review" / "saved-stage").exists()
    assert not project.review.versions


@requires_safe_failed_cleanup
def test_stale_staging_is_reclaimed_and_fresh_staging_is_kept(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    root = art / "review"
    root.mkdir()
    old = root / ".staging-review-old"
    fresh = root / ".staging-review-fresh"
    old.mkdir()
    fresh.mkdir()
    old.chmod(0o700)
    fresh.chmod(0o700)
    (old / "mix.wav").write_bytes(b"old")
    (fresh / "mix.wav").write_bytes(b"fresh")
    cutoff = time.time() - review_versions._STALE_QUARANTINE_AGE_SECONDS - 1
    os.utime(old, (cutoff, cutoff))
    review_versions.sweep_stale_quarantines(project)
    assert not old.exists()
    assert (fresh / "mix.wav").read_bytes() == b"fresh"


@requires_safe_failed_cleanup
def test_active_stage_lease_prevents_aged_sweep(minimal_project, sample_wav, monkeypatch):
    project, _ = _premix_project(minimal_project, sample_wav, monkeypatch)

    class SimpleEngine:
        def export_mp3(self, wav, mp3, *, bitrate_kbps):
            mp3.write_bytes(b"encoded")

    created = []
    stage_version(
        project,
        label="active",
        eng=SimpleEngine(),
        on_media_created=lambda path, identity: created.append((path, identity)),
    )
    stage, identity = created[0]
    assert (stage / "mix.mp3").read_bytes() == b"encoded"
    old = time.time() - review_versions._STALE_QUARANTINE_AGE_SECONDS - 1
    os.utime(stage, (old, old))
    review_versions.sweep_stale_quarantines(project)
    assert stage.is_dir()
    review_versions._release_stage_lease(identity)
    review_versions.sweep_stale_quarantines(project)
    assert not stage.exists()


@requires_safe_failed_cleanup
def test_quarantine_sweep_rotates_past_fresh_entries(minimal_project, sample_wav, monkeypatch):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    root = art / "review"
    root.mkdir()
    for index in range(review_versions._STALE_QUARANTINE_LIMIT):
        _marked_quarantine(root, f".failed-review-{index:02}", stale=False)
    old = _marked_quarantine(root, ".failed-review-zz", stale=True)
    review_versions.sweep_stale_quarantines(project)
    assert not old.exists()


@requires_safe_failed_cleanup
def test_quarantine_sweep_rejects_untrusted_marker(minimal_project, sample_wav, monkeypatch):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    root = art / "review"
    root.mkdir()
    quarantine = _marked_quarantine(root, ".failed-review-forged", stale=True)
    (quarantine / review_versions._CLEANUP_MARKER).chmod(0o666)
    review_versions.sweep_stale_quarantines(project)
    assert (quarantine / "media" / "mix.wav").exists()


@requires_safe_failed_cleanup
def test_quarantine_sweep_rejects_shared_writable_root(minimal_project, sample_wav, monkeypatch):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    root = art / "review"
    root.mkdir()
    quarantine = _marked_quarantine(root, ".failed-review-forged", stale=True)
    root.chmod(0o777)
    review_versions.sweep_stale_quarantines(project)
    assert (quarantine / "media" / "mix.wav").exists()


@requires_safe_failed_cleanup
def test_direct_publish_cleans_stage_when_commit_lock_fails(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    monkeypatch.setattr(
        review_versions,
        "project_commit_lock",
        lambda project: (_ for _ in ()).throw(OSError("lock failed")),
    )
    with pytest.raises(OSError, match="lock failed"):
        publish_version(project, label="new")
    assert not list((art / "review").glob(".staging-review-*"))


@requires_safe_failed_cleanup
def test_direct_publish_cleans_promoted_media_after_attach_failure(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    monkeypatch.setattr(
        review_versions,
        "attach_version",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError("attach failed")),
    )
    with pytest.raises(OSError, match="attach failed"):
        publish_version(project, label="new")
    assert not list((art / "review").glob("[!.]*"))


@requires_safe_failed_cleanup
def test_promotion_detects_replaced_staging_directory(minimal_project, sample_wav, monkeypatch):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    real_promote = review_versions._rename_noreplace

    def replace_source(src, dst, root_fd):
        review_root = art / "review"
        (review_root / src).rename(review_root / "saved")
        (review_root / src).mkdir()
        (review_root / src / "mix.wav").write_bytes(b"attacker")
        real_promote(src, dst, root_fd)

    monkeypatch.setattr(review_versions, "_rename_noreplace", replace_source)
    with pytest.raises(RuntimeError, match="changed during publication"):
        publish_version(project, label="new")
    assert not project.review.versions


@requires_safe_failed_cleanup
def test_promotion_rejects_changed_wav_bytes(minimal_project, sample_wav, monkeypatch):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    real_promote = review_versions._rename_noreplace

    def alter_after_rename(src, dst, root_fd):
        real_promote(src, dst, root_fd)
        (art / "review" / dst / "mix.wav").write_bytes(b"changed")

    monkeypatch.setattr(review_versions, "_rename_noreplace", alter_after_rename)
    with pytest.raises(RuntimeError, match="mix changed during publication"):
        publish_version(project, label="new")
    assert not project.review.versions
    assert not list((art / "review").glob("[!.]*"))


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


@requires_safe_failed_cleanup
def test_clean_created_version_mkdtemp_failure_keeps_directory(tmp_path, monkeypatch):
    version_dir, identity = _created_version_dir(tmp_path)

    real_mkdir = os.mkdir

    def fail_mkdir(path, *args, **kwargs):
        if str(path).startswith(review_versions._QUARANTINE_PREFIX):
            raise OSError("quarantine mkdir failed")
        return real_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(os, "mkdir", fail_mkdir)
    with pytest.raises(OSError, match="quarantine mkdir failed"):
        review_versions.clean_created_version(version_dir, identity)
    assert (version_dir / "mix.wav").read_bytes() == b"partial"


@requires_safe_failed_cleanup
def test_marker_write_failure_keeps_public_media_without_quarantine(tmp_path, monkeypatch):
    version_dir, identity = _created_version_dir(tmp_path)
    real_write = review_versions.os.write

    def fail_marker_write(fd, data):
        if data.startswith(b'{"name"'):
            raise OSError("marker write failed")
        return real_write(fd, data)

    monkeypatch.setattr(review_versions.os, "write", fail_marker_write)
    with pytest.raises(OSError, match="marker write failed"):
        review_versions.clean_created_version(version_dir, identity)
    assert (version_dir / "mix.wav").read_bytes() == b"partial"
    assert not list(version_dir.parent.glob(".failed-review-*"))


@requires_safe_failed_cleanup
def test_clean_created_version_quarantine_open_failure_keeps_directory(tmp_path, monkeypatch):
    version_dir, identity = _created_version_dir(tmp_path)
    real_open = review_versions.open_nofollow_dir

    def fail_quarantine_open(path, *args, **kwargs):
        if Path(path).name.startswith(".failed-review-"):
            raise OSError("quarantine open failed")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(review_versions, "open_nofollow_dir", fail_quarantine_open)
    with pytest.raises(OSError, match="quarantine open failed"):
        review_versions.clean_created_version(version_dir, identity)
    assert (version_dir / "mix.wav").read_bytes() == b"partial"
    assert not list(version_dir.parent.glob(".failed-review-*"))


@requires_safe_failed_cleanup
def test_clean_created_version_missing_directory_is_noop(tmp_path, caplog):
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
    real_open = review_versions.open_nofollow_dir
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

    monkeypatch.setattr(review_versions, "open_nofollow_dir", tracking_open)
    monkeypatch.setattr(review_versions.os, "close", flaky_close)
    review_versions.clean_created_version(version_dir, identity)

    assert len(pinned_fds) == 2
    assert sorted(closed) == sorted(pinned_fds)
    assert not os.path.lexists(version_dir)
    assert not list(version_dir.parent.glob(".failed-review-*"))


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
def test_version_paths_stay_under_review_root(minimal_project, sample_wav, tmp_workspace):
    p, vid = _publish(minimal_project, sample_wav)
    root = review_artifacts_dir(p).resolve()
    assert version_audio_path(p, vid).is_relative_to(root)
    mp3 = version_mp3_path(p, vid)
    assert mp3 is not None
    assert mp3.is_relative_to(root)


@requires_safe_failed_cleanup
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
            assert source != wav
            assert source.read_bytes() == wav_bytes
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


@requires_safe_failed_cleanup
@pytest.mark.parametrize("force_copy", [False, True])
def test_mp3_retry_snapshot_survives_in_place_source_write(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, force_copy
):
    project, version_id = _publish(minimal_project, sample_wav)
    wav = version_audio_path(project, version_id)
    original = wav.read_bytes()
    mp3 = version_mp3_path(project, version_id)
    assert mp3 is not None
    mp3.unlink()
    if force_copy:
        monkeypatch.setattr(review_versions, "_clone_pinned_wav", lambda _fd, _path: False)

    class MutatingEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            assert source.read_bytes() == original
            assert (source.stat().st_dev, source.stat().st_ino) != (
                wav.stat().st_dev,
                wav.stat().st_ino,
            )
            assert source.parent.stat().st_mode & 0o077 == 0
            with wav.open("r+b") as mutable:
                mutable.write(b"CHANGED")
            assert source.read_bytes() == original
            output.write_bytes(b"encoded original")

    assert encode_version_mp3(project, version_id, eng=MutatingEngine()) == mp3
    assert wav.read_bytes().startswith(b"CHANGED")
    assert mp3.read_bytes() == b"encoded original"


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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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
            assert source != wav
            assert source.read_bytes() == wav_bytes
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


@requires_safe_failed_cleanup
@pytest.mark.parametrize("fallback", [False, True], ids=["descriptor-walk", "path-fallback"])
def test_mp3_retry_uses_separate_inode(minimal_project, sample_wav, request, fallback):
    project, version_id = _publish(minimal_project, sample_wav)
    version_mp3_path(project, version_id).unlink()
    wav = version_audio_path(project, version_id)
    if fallback:
        request.getfixturevalue("pinned_media_fallback")

    class InspectingEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            assert (os.stat(source).st_dev, os.stat(source).st_ino) != (
                os.stat(wav).st_dev,
                os.stat(wav).st_ino,
            )
            assert source.read_bytes() == wav.read_bytes()
            output.write_bytes(b"mp3")

    encode_version_mp3(project, version_id, eng=InspectingEngine())


@requires_safe_failed_cleanup
def test_mp3_retry_native_clone_avoids_full_copy(minimal_project, sample_wav, monkeypatch):
    project, version_id = _publish(minimal_project, sample_wav)
    version_mp3_path(project, version_id).unlink()
    expected = version_audio_path(project, version_id).read_bytes()
    native_clone = review_versions._clone_pinned_wav

    def require_native_clone(source_fd, snapshot):
        if not native_clone(source_fd, snapshot):
            pytest.skip("filesystem does not support cloning this WAV")
        return True

    def unexpected_copy(*_args, **_kwargs):
        raise AssertionError("native clone must avoid a full WAV copy")

    monkeypatch.setattr(review_versions, "_clone_pinned_wav", require_native_clone)
    monkeypatch.setattr(review_versions.shutil, "copyfileobj", unexpected_copy)

    class InspectingEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            assert source.read_bytes() == expected
            output.write_bytes(b"mp3")

    encode_version_mp3(project, version_id, eng=InspectingEngine())


@requires_safe_failed_cleanup
def test_mp3_retry_copies_pinned_wav_when_clone_fails(minimal_project, sample_wav, monkeypatch):
    project, version_id = _publish(minimal_project, sample_wav)
    version_mp3_path(project, version_id).unlink()
    wav = version_audio_path(project, version_id)

    class InspectingEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            assert (os.stat(source).st_dev, os.stat(source).st_ino) != (
                os.stat(wav).st_dev,
                os.stat(wav).st_ino,
            )
            assert source.read_bytes() == wav.read_bytes()
            output.write_bytes(b"mp3")

    monkeypatch.setattr(review_versions, "_clone_pinned_wav", lambda _fd, _path: False)
    encode_version_mp3(project, version_id, eng=InspectingEngine())


@requires_safe_failed_cleanup
def test_mp3_retry_clones_pinned_source_after_path_swap(minimal_project, sample_wav, monkeypatch):
    project, version_id = _publish(minimal_project, sample_wav)
    version_mp3_path(project, version_id).unlink()
    wav = version_audio_path(project, version_id)
    expected = wav.read_bytes()
    real_clone = review_versions._clone_pinned_wav

    def swap_before_clone(source_fd, target):
        wav.rename(wav.with_suffix(".old"))
        wav.write_bytes(b"replacement")
        return real_clone(source_fd, target)

    class InspectingEngine:
        def export_mp3(self, source, output, *, bitrate_kbps):
            assert source.read_bytes() == expected
            assert (os.stat(source).st_dev, os.stat(source).st_ino) != (
                os.stat(wav).st_dev,
                os.stat(wav).st_ino,
            )
            output.write_bytes(b"mp3")

    monkeypatch.setattr(review_versions, "_clone_pinned_wav", swap_before_clone)
    encode_version_mp3(project, version_id, eng=InspectingEngine())


@requires_safe_failed_cleanup
def test_review_artifacts_dir_matches_writer_reldir(minimal_project, sample_wav, tmp_workspace):
    p, vid = _publish(minimal_project, sample_wav)
    assert review_artifacts_dir(p) == p.workspace_path() / REVIEW_ARTIFACTS_RELDIR
    assert get_version(p, vid).audio_relpath.startswith(f"{REVIEW_ARTIFACTS_RELDIR}/")


@requires_safe_failed_cleanup
def test_shares_sidecar_lives_under_review_artifacts_dir(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.edits.review_shares import shares_path

    p, _vid = _publish(minimal_project, sample_wav)
    assert shares_path(p) == review_artifacts_dir(p) / "shares.json"


@requires_safe_failed_cleanup
def test_version_paths_accept_legacy_spellings(minimal_project, sample_wav, tmp_workspace):
    p, vid = _publish(minimal_project, sample_wav)
    orig = get_version(p, vid).audio_relpath
    expected = version_audio_path(p, vid)

    get_version(p, vid).audio_relpath = "./" + orig
    assert version_audio_path(p, vid) == expected

    abs_path = str((Path(p.workspace_dir) / orig).resolve())
    get_version(p, vid).audio_relpath = abs_path
    assert version_audio_path(p, vid) == expected


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
def test_stage_version_creates_media_without_touching_project(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    created = []
    ver = stage_version(
        project, label="staged", on_media_created=lambda p, i: created.append((p, i))
    )
    assert created[0][0].name.startswith(review_versions._STAGING_PREFIX)
    assert (created[0][0] / "mix.wav").is_file()
    assert not (art / "review" / ver.id).exists()
    assert project.review.versions == []
    assert project.review.active_version_id is None
    assert created[0][1] in review_versions._active_stage_leases
    discard_created_version(*created[0])
    assert created[0][1] not in review_versions._active_stage_leases


def test_stage_version_requires_lease_owner_callback_before_creating_media(
    minimal_project, sample_wav, monkeypatch
):
    project, art = _premix_project(minimal_project, sample_wav, monkeypatch)
    leases_before = set(review_versions._active_stage_leases)
    with pytest.raises(TypeError, match="on_media_created"):
        stage_version(project, **{"label": "unowned"})
    assert not (art / "review").exists()
    assert set(review_versions._active_stage_leases) == leases_before


@requires_safe_failed_cleanup
def test_attach_version_appends_and_optionally_activates(minimal_project, sample_wav, monkeypatch):
    project, _ = _premix_project(minimal_project, sample_wav, monkeypatch)
    first = publish_version(project, label="a", set_active=False)
    assert [v.id for v in project.review.versions] == [first.id]
    assert project.review.active_version_id is None
    second = publish_version(project, label="b")
    assert project.review.active_version_id == second.id


@requires_safe_failed_cleanup
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


@requires_safe_failed_cleanup
def test_attach_version_leaves_audio_fingerprint_unchanged(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.engines.reconciliation_state import audio_state_fingerprint

    project, _ = _premix_project(minimal_project, sample_wav, monkeypatch)
    before = audio_state_fingerprint(project)
    publish_version(project, label="a")
    assert audio_state_fingerprint(project) == before


@requires_safe_failed_cleanup
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
