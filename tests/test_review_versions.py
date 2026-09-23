"""Review mix version publish / play / comment stamp."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import pytest

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
