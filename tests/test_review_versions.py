"""Review mix version publish / play / comment stamp."""

from __future__ import annotations

import hashlib
import os
import subprocess
import time
from pathlib import Path

import pytest

from podcast_mcp.edits import review_versions
from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.review_versions import (
    REVIEW_ARTIFACTS_RELDIR,
    encode_version_mp3,
    get_version,
    publish_version,
    review_artifacts_dir,
    version_audio_path,
    version_mp3_path,
)
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import PlayService, ProjectWorkspace, ReviewService
from podcast_mcp.services.review_media import review_guest_audio_path
from podcast_mcp.util.binaries import resolve_ffmpeg


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
    assert sum(path.exists() for path in stale) == 1
    assert fresh.read_bytes() == b"live retry"
    assert unrelated.read_bytes() == b"keep"
    assert symlink.is_symlink()
    assert outside.read_bytes() == b"outside"
    assert version_audio_path(project, version_id).is_file()
    assert mp3.read_bytes() == b"complete"


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
    original_unlink = Path.unlink

    def refuse_stale_unlink(path, *args, **kwargs):
        if path == stale:
            raise PermissionError("cannot remove stale file")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", refuse_stale_unlink)

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
