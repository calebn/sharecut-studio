import wave
from pathlib import Path

import pytest

from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.models import EpisodeProject, SocialClipCandidate, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ExportFilesService
from podcast_mcp.util.coded_error import CodedFileNotFoundError
from podcast_mcp.util.host_platform import current


def _candidate(reference: str | None, *, clip_id: str = "c1") -> SocialClipCandidate:
    return SocialClipCandidate(
        id=clip_id,
        track_id="host",
        start=0,
        end=0.1,
        title_suggestion="A different title",
        approved=False,
        exported_path=reference,
    )


def _workspace(tmp_path: Path, candidates: list[SocialClipCandidate]) -> ProjectWorkspace:
    project = EpisodeProject.create("Clip listing", str(tmp_path))
    project.ensure_dirs()
    project.social_clip_candidates = candidates
    return ProjectWorkspace.open(save_project(project), adopt=False)


def _wav(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(bytes(3200))


def test_only_referenced_clip_is_current_and_both_files_remain_openable(tmp_path: Path) -> None:
    reference = str(Path("export") / "clips" / "new-title_c1.wav")
    ws = _workspace(tmp_path, [_candidate(reference)])
    names = ["old-title_c1.wav", "new-title_c1.wav"]
    for name in names:
        _wav(ws.project.export_dir() / "clips" / name)
    service = ExportFilesService(ws)

    assert {row.id: row.current for row in service.list()} == {
        "clips/new-title_c1.wav": True,
        "clips/old-title_c1.wav": False,
    }
    for name in names:
        served = service.open(f"clips/{name}")
        assert served.path.read_bytes() == (ws.project.export_dir() / "clips" / name).read_bytes()


def test_saved_reference_changes_and_removal_only_change_currentness(tmp_path: Path) -> None:
    ws = _workspace(tmp_path, [_candidate(str(Path("export") / "clips" / "first.wav"))])
    for name in ["first.wav", "second.wav"]:
        _wav(ws.project.export_dir() / "clips" / name)

    def repoint(project: EpisodeProject) -> None:
        project.social_clip_candidates[0].exported_path = str(
            Path("export") / "clips" / "second.wav"
        )

    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate("Before reference change", "After reference change", repoint)
    reopened = ProjectWorkspace.open(ws.path, adopt=False)
    assert {row.id: row.current for row in ExportFilesService(reopened).list()} == {
        "clips/first.wav": False,
        "clips/second.wav": True,
    }

    def remove(project: EpisodeProject) -> None:
        project.social_clip_candidates = []

    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate("Before candidate removal", "After candidate removal", remove)
    service = ExportFilesService(ProjectWorkspace.open(ws.path, adopt=False))
    assert {row.id: row.current for row in service.list()} == {
        "clips/first.wav": False,
        "clips/second.wav": False,
    }
    assert service.open("clips/first.wav").path.is_file()
    assert service.open("clips/second.wav").path.is_file()


@pytest.mark.parametrize(
    "reference",
    [
        None,
        "",
        "clip.wav",
        "clips/clip.wav",
        "other/clip.wav",
        "export/other/clip.wav",
        "../export/clips/clip.wav",
        "export/clips/missing.wav",
    ],
)
def test_unrelated_or_empty_reference_does_not_make_saved_clip_current(
    tmp_path: Path, reference: str | None
) -> None:
    ws = _workspace(tmp_path, [_candidate(reference)])
    _wav(ws.project.export_dir() / "clips" / "clip.wav")
    service = ExportFilesService(ws)

    assert [(row.id, row.current) for row in service.list()] == [("clips/clip.wav", False)]
    assert service.open("clips/clip.wav").path.is_file()
    with pytest.raises(CodedFileNotFoundError):
        service.open("clips/missing.wav")


def test_any_candidate_can_reference_a_saved_clip_without_approval_or_name_inference(
    tmp_path: Path,
) -> None:
    reference = str(Path("export") / "clips" / "saved.wav")
    ws = _workspace(
        tmp_path,
        [
            _candidate(None),
            _candidate(reference, clip_id="unrelated-id"),
            _candidate(reference, clip_id="duplicate-pointer"),
        ],
    )
    _wav(ws.project.export_dir() / "clips" / "saved.wav")

    assert [(row.id, row.current) for row in ExportFilesService(ws).list()] == [
        ("clips/saved.wav", True)
    ]


def test_canonical_audio_and_opt_in_bounce_remain_current_without_candidates(
    tmp_path: Path,
) -> None:
    ws = _workspace(tmp_path, [])
    canonical = f"{sanitize_export_stem(ws.project.name)}.wav"
    _wav(ws.project.export_dir() / canonical)
    _wav(ws.project.export_dir() / "bounces" / "range.wav")

    assert [(row.id, row.current) for row in ExportFilesService(ws).list()] == [(canonical, True)]
    service = ExportFilesService(ws, bounces=True)
    assert {row.id: row.current for row in service.list()} == {
        canonical: True,
        "bounces/range.wav": True,
    }
    assert service.open("bounces/range.wav").path.is_file()


def test_export_root_symlink_keeps_the_writers_lexical_reference(tmp_path: Path) -> None:
    reference = str(Path("export") / "clips" / "saved.wav")
    ws = _workspace(tmp_path / "workspace", [_candidate(reference)])
    export_root = ws.project.export_dir()
    target = tmp_path / "export-target"
    target.mkdir()
    export_root.rmdir()
    try:
        export_root.symlink_to(target, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Directory symlinks unavailable: {exc}")
    _wav(export_root / "clips" / "saved.wav")
    service = ExportFilesService(ws)

    assert [(row.id, row.current) for row in service.list()] == [("clips/saved.wav", True)]
    assert service.open("clips/saved.wav").path == target / "clips" / "saved.wav"


@pytest.mark.skipif(not current().is_posix, reason="Backslash is a POSIX filename character")
@pytest.mark.parametrize("literal_reference", [False, True])
def test_literal_backslash_filename_is_distinct_from_a_directory_reference(
    tmp_path: Path, literal_reference: bool
) -> None:
    name = "part\\clip.wav"
    reference = (
        str(Path("export") / "clips" / name) if literal_reference else "export/clips/part/clip.wav"
    )
    ws = _workspace(tmp_path, [_candidate(reference)])
    _wav(ws.project.export_dir() / "clips" / name)
    service = ExportFilesService(ws)

    assert [(row.id, row.current) for row in service.list()] == [
        (f"clips/{name}", literal_reference)
    ]
    assert service.open(f"clips/{name}").path.is_file()
