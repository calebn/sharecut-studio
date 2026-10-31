"""``.sharecutseg`` export and import."""

from __future__ import annotations

import os
import stat
import zipfile
from pathlib import Path

import pytest

from podcast_mcp.segments import bundle
from podcast_mcp.segments.bundle import MANIFEST, export_segments, import_bundle
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.util.coded_error import CodedValueError
from segment_helpers import make_segment_dir, rewrite_zip


@pytest.fixture
def source_store(tmp_path: Path) -> SegmentStore:
    store = SegmentStore(tmp_path / "source-lib")
    store.add(make_segment_dir(tmp_path / "in"))
    return store


@pytest.fixture
def target(tmp_path: Path) -> SegmentStore:
    return SegmentStore(tmp_path / "target-lib")


@pytest.fixture
def bundle_path(source_store: SegmentStore, tmp_path: Path) -> Path:
    segment_id = source_store.list()[0].id
    return export_segments(source_store, [segment_id], tmp_path / "warm.sharecutseg")


def _expect(code: str, target: SegmentStore, path: Path) -> None:
    with pytest.raises(CodedValueError) as raised:
        import_bundle(target, path)
    assert raised.value.code == code
    assert list(target.list()) == []


def test_export_writes_the_segment_audio_and_a_manifest(bundle_path: Path) -> None:
    with zipfile.ZipFile(bundle_path) as archive:
        assert sorted(archive.namelist()) == [MANIFEST, "clip-01.flac", "segment.json"]
        lines = archive.read(MANIFEST).decode().splitlines()
    assert sorted(line.split("  ")[1] for line in lines) == ["clip-01.flac", "segment.json"]


def test_a_bundle_round_trips_into_another_library(
    bundle_path: Path, target: SegmentStore, source_store: SegmentStore
) -> None:
    result = import_bundle(target, bundle_path)

    assert result.status == "added"
    original = source_store.list()[0]
    copy = target.get(result.id)
    assert copy.content_sha256 == original.content_sha256
    assert (target.path(result.id) / "clip-01.flac").read_bytes() == b"fLaC-one"


def test_importing_the_same_bundle_again_changes_nothing(
    bundle_path: Path, target: SegmentStore
) -> None:
    first = import_bundle(target, bundle_path)
    again = import_bundle(target, bundle_path)

    assert again.status == "unchanged"
    assert again.version == first.version == 1
    assert target.versions(first.id) == [1]


def test_a_name_with_changed_audio_imports_as_version_two(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    import_bundle(target, bundle_path)
    other = SegmentStore(tmp_path / "other-lib")
    other.add(make_segment_dir(tmp_path / "in2", audio=b"fLaC-two"))
    second = export_segments(other, [other.list()[0].id], tmp_path / "v2.sharecutseg")

    result = import_bundle(target, second)

    assert (result.status, result.version) == ("new_version", 2)
    assert (target.path(result.id, 1) / "clip-01.flac").read_bytes() == b"fLaC-one"
    assert (target.path(result.id, 2) / "clip-01.flac").read_bytes() == b"fLaC-two"


def test_the_same_audio_under_another_name_is_not_added_again(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    first = import_bundle(target, bundle_path)
    other = SegmentStore(tmp_path / "other-lib")
    other.add(make_segment_dir(tmp_path / "in2", name="Cold Open"))
    renamed = export_segments(other, [other.list()[0].id], tmp_path / "cold.sharecutseg")

    result = import_bundle(target, renamed)

    assert result.status == "unchanged"
    assert result.id == first.id


def test_a_tampered_audio_byte_is_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    tampered = rewrite_zip(
        bundle_path, tmp_path / "t.sharecutseg", replace={"clip-01.flac": b"fLaC-onX"}
    )
    _expect("segment_hash_mismatch", target, tampered)


def test_a_manifest_that_disagrees_with_segment_json_is_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    with zipfile.ZipFile(bundle_path) as archive:
        text = archive.read(MANIFEST).decode()
    manifest = (("0" if text[0] != "0" else "1") + text[1:]).encode()
    bad = rewrite_zip(bundle_path, tmp_path / "m.sharecutseg", replace={MANIFEST: manifest})
    _expect("segment_hash_mismatch", target, bad)


def _zip_with(path: Path, source: Path, extra: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(path, "w") as out:
        for info in src.infolist():
            out.writestr(info.filename, src.read(info))
        for name, data in extra.items():
            out.writestr(name, data)
    return path


@pytest.mark.parametrize("name", ["../evil.flac", "/etc/passwd", "sub/dir.flac", "..", "a\\b.flac"])
def test_unsafe_entry_names_are_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path, name: str
) -> None:
    bad = _zip_with(tmp_path / "slip.sharecutseg", bundle_path, {name: b"x"})
    _expect("segment_bundle_invalid", target, bad)
    assert not (tmp_path / "evil.flac").exists()


def test_a_file_the_manifest_does_not_list_is_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    bad = _zip_with(tmp_path / "extra.sharecutseg", bundle_path, {"extra.flac": b"x"})
    _expect("segment_bundle_invalid", target, bad)


def test_a_symlink_entry_is_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    bad = tmp_path / "link.sharecutseg"
    with zipfile.ZipFile(bundle_path) as src, zipfile.ZipFile(bad, "w") as out:
        for info in src.infolist():
            out.writestr(info.filename, src.read(info))
        link = zipfile.ZipInfo("link.flac")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        out.writestr(link, "/etc/passwd")
    _expect("segment_bundle_invalid", target, bad)


def test_too_many_entries_are_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    extra = {f"f{i}.flac": b"x" for i in range(bundle.MAX_ENTRIES)}
    bad = _zip_with(tmp_path / "many.sharecutseg", bundle_path, extra)
    _expect("segment_bundle_invalid", target, bad)


def test_an_oversize_bundle_is_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bundle, "MAX_TOTAL_BYTES", 4)
    _expect("segment_bundle_invalid", target, bundle_path)


def test_a_bundle_whose_entry_is_bigger_than_its_header_says_is_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = zipfile.ZipFile.infolist

    def lying(self: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
        infos = real(self)
        for info in infos:
            if info.filename == "clip-01.flac":
                info.file_size = 1
        return infos

    monkeypatch.setattr(zipfile.ZipFile, "infolist", lying)
    _expect("segment_bundle_invalid", target, bundle_path)


def test_a_bundle_with_a_newer_schema_is_unsupported(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    with zipfile.ZipFile(bundle_path) as archive:
        data = archive.read("segment.json").replace(b'"schema_version": 1', b'"schema_version": 2')
    bad = rewrite_zip(bundle_path, tmp_path / "v2.sharecutseg", replace={"segment.json": data})
    with pytest.raises(CodedValueError) as raised:
        import_bundle(target, bad)
    assert raised.value.code == "segment_schema_unsupported"


def test_a_missing_manifest_is_refused(target: SegmentStore, tmp_path: Path) -> None:
    path = tmp_path / "bare.sharecutseg"
    with zipfile.ZipFile(path, "w") as out:
        out.writestr("segment.json", "{}")
    _expect("segment_bundle_invalid", target, path)


def test_a_file_that_is_not_a_zip_is_refused(target: SegmentStore, tmp_path: Path) -> None:
    path = tmp_path / "plain.sharecutseg"
    path.write_text("hello")
    _expect("segment_bundle_invalid", target, path)


def test_export_takes_one_segment_only(source_store: SegmentStore, tmp_path: Path) -> None:
    with pytest.raises(CodedValueError) as raised:
        export_segments(source_store, [], tmp_path / "x.sharecutseg")
    assert raised.value.code == "segment_bundle_unsupported"


def test_export_of_an_unknown_segment_is_refused(
    source_store: SegmentStore, tmp_path: Path
) -> None:
    with pytest.raises(CodedValueError) as raised:
        export_segments(source_store, ["nope"], tmp_path / "x.sharecutseg")
    assert raised.value.code == "segment_unknown"
    assert not os.path.exists(tmp_path / "x.sharecutseg")


def test_entry_names_that_differ_only_in_case_are_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    path = _zip_with(tmp_path / "case.sharecutseg", bundle_path, {"CLIP-01.flac": b"x"})
    _expect("segment_bundle_invalid", target, path)


def test_an_oversize_segment_json_or_manifest_is_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bundle, "MAX_MANIFEST_BYTES", 8)
    _expect("segment_bundle_invalid", target, bundle_path)


def test_a_highly_compressed_entry_is_refused(
    bundle_path: Path, target: SegmentStore, tmp_path: Path
) -> None:
    path = tmp_path / "bomb.sharecutseg"
    with (
        zipfile.ZipFile(bundle_path) as src,
        zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as out,
    ):
        for info in src.infolist():
            out.writestr(info.filename, src.read(info))
        out.writestr("zeros.flac", b"\0" * (8 * 1024 * 1024))
    _expect("segment_bundle_invalid", target, path)


def test_a_full_disk_while_unpacking_is_a_coded_error(
    bundle_path: Path, target: SegmentStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    def full(*_args: object, **_kwargs: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(zipfile.ZipFile, "open", full)
    _expect("segment_write_failed", target, bundle_path)


def test_an_unwritable_temp_dir_is_a_coded_error(
    bundle_path: Path, target: SegmentStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refused(*_args: object, **_kwargs: object) -> None:
        raise OSError(13, "Permission denied")

    monkeypatch.setattr(bundle.tempfile, "TemporaryDirectory", refused)
    _expect("segment_write_failed", target, bundle_path)


def test_a_write_error_while_exporting_is_a_coded_error(
    source_store: SegmentStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*_args: object, **_kwargs: object) -> Path:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(bundle, "atomic_write", broken)
    with pytest.raises(CodedValueError) as raised:
        export_segments(source_store, [source_store.list()[0].id], tmp_path / "x.sharecutseg")
    assert raised.value.code == "segment_write_failed"
