"""``preview_kit_bundle`` says what ``import_kit_bundle`` does, in member order, and writes nothing."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from kit_helpers import hand_made_kit
from podcast_mcp.segments import kit_bundle
from podcast_mcp.segments.kit import KitEntry, KitStore, kit_id_for
from podcast_mcp.segments.kit_bundle import (
    KitImportIncomplete,
    export_kit,
    import_kit_bundle,
    preview_kit_bundle,
)
from podcast_mcp.segments.kit_summary import save_kit
from podcast_mcp.segments.store import AddResult, SegmentStore
from podcast_mcp.util.coded_error import CodedValueError
from segment_helpers import make_segment_dir


def _libraries(tmp_path: Path, name: str = "lib") -> tuple[KitStore, SegmentStore]:
    return KitStore(tmp_path / name / "kits"), SegmentStore(tmp_path / name / "segments")


def _tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def _outcomes(result: object) -> tuple[list[tuple[str, int]], tuple[str, int]]:
    segments = [(s.status, s.version) for s in result.segments]  # type: ignore[attr-defined]
    return segments, (result.kit.status, result.kit.version)  # type: ignore[attr-defined]


def _preview_outcomes(preview: object) -> tuple[list[tuple[str, int]], tuple[str, int]]:
    segments = [(s.plan.status, s.plan.version) for s in preview.segments]  # type: ignore[attr-defined]
    return segments, (preview.plan.status, preview.plan.version)  # type: ignore[attr-defined]


def test_preview_of_a_new_kit_writes_nothing_and_matches_the_import(tmp_path: Path) -> None:
    bundle = hand_made_kit(tmp_path)
    kits, segments = _libraries(tmp_path)

    preview = preview_kit_bundle(kits, segments, bundle)

    assert not (tmp_path / "lib").exists()
    assert preview.kit.name == "Show Kit"
    assert [(e.position, e.planned.segment.name) for e in preview.entries] == [
        (1, "Warm Intro"),
        (2, "Sign Off"),
    ]
    assert _preview_outcomes(preview) == (
        [("added", 1), ("added", 1)],
        ("added", 1),
    )
    assert _outcomes(import_kit_bundle(kits, segments, bundle)) == _preview_outcomes(preview)


def test_two_versions_of_one_segment_plan_consecutive_numbers(tmp_path: Path) -> None:
    bundle = hand_made_kit(
        tmp_path, members=(("Warm Intro", b"fLaC-one", 1), ("Warm Intro", b"fLaC-two", 2))
    )
    kits, segments = _libraries(tmp_path)

    preview = preview_kit_bundle(kits, segments, bundle)

    assert [(s.plan.status, s.plan.version) for s in preview.segments] == [
        ("added", 1),
        ("new_version", 2),
    ]
    assert [e.planned.plan.version for e in preview.entries] == [1, 2]
    imported = import_kit_bundle(kits, segments, bundle)
    assert _outcomes(imported) == _preview_outcomes(preview)
    assert [e.version for e in kits.get(kit_id_for("Show Kit")).entries] == [1, 2]


def test_a_second_version_numbers_after_the_ones_the_library_has(tmp_path: Path) -> None:
    kits, segments = _libraries(tmp_path)
    segments.add(make_segment_dir(tmp_path / "have", name="Warm Intro", audio=b"fLaC-old"))
    bundle = hand_made_kit(
        tmp_path, members=(("Warm Intro", b"fLaC-one", 1), ("Warm Intro", b"fLaC-two", 2))
    )

    preview = preview_kit_bundle(kits, segments, bundle)

    assert [(s.plan.status, s.plan.version) for s in preview.segments] == [
        ("new_version", 2),
        ("new_version", 3),
    ]
    assert _outcomes(import_kit_bundle(kits, segments, bundle)) == _preview_outcomes(preview)


def test_the_same_audio_under_two_names_is_planned_once(tmp_path: Path) -> None:
    bundle = hand_made_kit(
        tmp_path, members=(("Warm Intro", b"fLaC-one", 1), ("Cozy Open", b"fLaC-one", 1))
    )
    kits, segments = _libraries(tmp_path)

    preview = preview_kit_bundle(kits, segments, bundle)

    first, second = preview.segments
    assert first.plan.status == "added"
    assert (second.plan.status, second.plan.id) == ("unchanged", first.plan.id)
    assert _outcomes(import_kit_bundle(kits, segments, bundle)) == _preview_outcomes(preview)
    assert [e.segment_id for e in kits.get(kit_id_for("Show Kit")).entries] == [first.plan.id] * 2


def test_segments_already_in_the_library_are_unchanged_and_the_kit_is_repointed(
    tmp_path: Path,
) -> None:
    kits, segments = _libraries(tmp_path)
    have = segments.add(make_segment_dir(tmp_path / "have", name="Warm Intro", audio=b"fLaC-one"))
    segments.add(make_segment_dir(tmp_path / "have", name="Warm Intro", audio=b"fLaC-other"))
    bundle = hand_made_kit(tmp_path, members=(("Warm Intro", b"fLaC-one", 1),))

    preview = preview_kit_bundle(kits, segments, bundle)

    assert [(s.plan.status, s.plan.version) for s in preview.segments] == [("unchanged", 1)]
    assert preview.plan.status == "added"
    assert _outcomes(import_kit_bundle(kits, segments, bundle)) == _preview_outcomes(preview)
    assert kits.get(kit_id_for("Show Kit")).entries[0].segment_id == have.id


def test_a_second_import_of_the_same_file_previews_as_unchanged(tmp_path: Path) -> None:
    bundle = hand_made_kit(tmp_path)
    kits, segments = _libraries(tmp_path)
    import_kit_bundle(kits, segments, bundle)
    before = _tree(tmp_path / "lib")

    preview = preview_kit_bundle(kits, segments, bundle)

    assert _preview_outcomes(preview) == ([("unchanged", 1), ("unchanged", 1)], ("unchanged", 1))
    assert _tree(tmp_path / "lib") == before


@pytest.mark.parametrize("policy", ["skip", "new-version"])
def test_the_conflict_policy_is_planned_like_it_is_imported(tmp_path: Path, policy: str) -> None:
    kits, segments = _libraries(tmp_path)
    mine = segments.add(make_segment_dir(tmp_path / "have", name="Warm Intro", audio=b"fLaC-one"))
    save_kit(kits, segments, "Show Kit", [KitEntry(segment_id=mine.id, at="end")])
    bundle = hand_made_kit(tmp_path)

    preview = preview_kit_bundle(kits, segments, bundle, on_conflict=policy)  # type: ignore[arg-type]
    result = import_kit_bundle(kits, segments, bundle, on_conflict=policy)  # type: ignore[arg-type]

    assert (
        preview.plan.status
        == result.kit.status
        == ("skipped" if policy == "skip" else "new_version")
    )
    assert preview.plan.version == result.kit.version


def test_a_bad_conflict_policy_is_refused_by_the_preview(tmp_path: Path) -> None:
    kits, segments = _libraries(tmp_path)
    with pytest.raises(CodedValueError) as err:
        preview_kit_bundle(kits, segments, hand_made_kit(tmp_path), on_conflict="merge")  # type: ignore[arg-type]
    assert err.value.code == "kit_on_conflict_invalid"


def test_the_preview_refuses_what_the_import_refuses(tmp_path: Path) -> None:
    bundle = hand_made_kit(tmp_path)
    forged = tmp_path / "forged.sharecutkit"
    with zipfile.ZipFile(bundle) as source, zipfile.ZipFile(forged, "w") as target:
        for info in source.infolist():
            data = source.read(info)
            target.writestr(
                info.filename, b"fLaC-onX" if info.filename == "seg01__clip-01.flac" else data
            )
    kits, segments = _libraries(tmp_path)
    with pytest.raises(CodedValueError) as err:
        preview_kit_bundle(kits, segments, forged)
    assert err.value.code == "kit_hash_mismatch"
    with pytest.raises(CodedValueError) as again:
        import_kit_bundle(kits, segments, forged)
    assert again.value.code == "kit_hash_mismatch"
    assert not (tmp_path / "lib").exists()


def test_a_disk_without_room_to_unpack_is_refused_as_kit_no_room(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kit_bundle.bundle, "free_bytes", lambda _path: 1)
    kits, segments = _libraries(tmp_path)
    with pytest.raises(CodedValueError) as err:
        preview_kit_bundle(kits, segments, hand_made_kit(tmp_path))
    assert err.value.code == "kit_no_room"


def test_a_segment_that_fails_midway_reports_what_landed_and_a_retry_finishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle = hand_made_kit(tmp_path)
    kits, segments = _libraries(tmp_path)
    real = SegmentStore.add
    calls: list[int] = []

    def flaky(self: SegmentStore, folder: Path) -> AddResult:
        calls.append(1)
        if len(calls) == 2:
            raise CodedValueError("The library is busy.", code="segment_busy")
        return real(self, folder)

    monkeypatch.setattr(SegmentStore, "add", flaky)
    with pytest.raises(KitImportIncomplete) as err:
        import_kit_bundle(kits, segments, bundle)

    assert err.value.code == "kit_busy"
    assert [(a.status, a.version) for a in err.value.added] == [("added", 1)]
    assert err.value.total == 2
    assert "1 of 2 segments were added" in str(err.value)
    assert kits.list() == []

    monkeypatch.setattr(SegmentStore, "add", real)
    retry = import_kit_bundle(kits, segments, bundle)
    assert [s.status for s in retry.segments] == ["unchanged", "added"]
    assert retry.kit.status == "added"
    assert [k.name for k in kits.list()] == ["Show Kit"]


def test_a_kit_that_cannot_be_written_after_its_segments_landed_is_incomplete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle = hand_made_kit(tmp_path)
    kits, segments = _libraries(tmp_path)
    real = KitStore.add

    def failing(self: KitStore, kit: object, *, keep_existing: bool = False) -> object:
        raise CodedValueError("disk", code="kit_write_failed")

    monkeypatch.setattr(KitStore, "add", failing)
    with pytest.raises(KitImportIncomplete) as err:
        import_kit_bundle(kits, segments, bundle)
    assert err.value.code == "kit_write_failed"
    assert len(err.value.added) == 2

    monkeypatch.setattr(KitStore, "add", real)
    assert import_kit_bundle(kits, segments, bundle).kit.status == "added"


def test_a_failure_before_anything_landed_is_the_plain_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def busy(self: SegmentStore, folder: Path) -> AddResult:
        raise CodedValueError("busy", code="segment_busy")

    monkeypatch.setattr(SegmentStore, "add", busy)
    kits, segments = _libraries(tmp_path)
    with pytest.raises(CodedValueError) as err:
        import_kit_bundle(kits, segments, hand_made_kit(tmp_path))
    assert not isinstance(err.value, KitImportIncomplete)
    assert err.value.code == "kit_busy"


def _exportable(tmp_path: Path) -> tuple[KitStore, SegmentStore, str]:
    kits, segments = _libraries(tmp_path, "exp")
    ids = [
        segments.add(make_segment_dir(tmp_path / "in", name=n, audio=a)).id
        for n, a in (("Warm Intro", b"fLaC-one"), ("Sign Off", b"fLaC-two"))
    ]
    kit = save_kit(kits, segments, "Show Kit", [KitEntry(segment_id=i, at="start") for i in ids])
    return kits, segments, kit.id


def test_an_exported_kit_previews_as_what_it_imports(tmp_path: Path) -> None:
    kits, segments, kit_id = _exportable(tmp_path)
    out = export_kit(kits, segments, kit_id, tmp_path / "show.sharecutkit")
    other_kits, other_segments = _libraries(tmp_path, "other")

    preview = preview_kit_bundle(other_kits, other_segments, out)
    result = import_kit_bundle(other_kits, other_segments, out)

    assert _preview_outcomes(preview) == _outcomes(result)


def test_a_refused_export_keeps_the_file_it_would_have_replaced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kits, segments, kit_id = _exportable(tmp_path)
    target = tmp_path / "show.sharecutkit"
    target.write_bytes(b"my earlier export")
    monkeypatch.setattr(kit_bundle, "MAX_BUNDLE_BYTES", 10)

    with pytest.raises(CodedValueError) as err:
        export_kit(kits, segments, kit_id, target)

    assert err.value.code == "kit_bundle_too_large"
    assert target.read_bytes() == b"my earlier export"
    assert sorted(p.name for p in tmp_path.iterdir() if p.name.startswith(".")) == []


def test_an_export_with_more_files_than_an_import_takes_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kits, segments, kit_id = _exportable(tmp_path)
    target = tmp_path / "show.sharecutkit"
    monkeypatch.setattr(kit_bundle, "BUNDLE_MAX_FILES", 5)

    with pytest.raises(CodedValueError) as err:
        export_kit(kits, segments, kit_id, target)

    assert err.value.code == "kit_bundle_too_large"
    assert not target.exists()
    assert list(tmp_path.glob(".*.part")) == []


def test_a_segment_with_more_audio_than_a_kit_member_may_hold_is_refused_before_writing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kits, segments, kit_id = _exportable(tmp_path)
    monkeypatch.setattr(kit_bundle, "MEMBER_MAX_FILES", 1)
    target = tmp_path / "show.sharecutkit"

    with pytest.raises(CodedValueError) as err:
        export_kit(kits, segments, kit_id, target)

    assert err.value.code == "kit_bundle_too_large"
    assert not target.exists()
    assert list(tmp_path.glob(".*")) == []


def test_the_kit_staging_folder_is_not_a_kit(tmp_path: Path) -> None:
    kits = KitStore(tmp_path / "kits")
    (kits.directory / ".staging").mkdir(parents=True)
    (kits.directory / ".staging" / ("a" * 32 + ".sharecutkit")).write_bytes(b"x")
    assert kits.scan().kits == [] and kits.scan().damaged == []
