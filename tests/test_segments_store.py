"""The segment library."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.segments.store import SegmentStore, default_directory
from podcast_mcp.util.coded_error import CodedValueError
from segment_helpers import make_segment_dir


@pytest.fixture
def store(tmp_path: Path) -> SegmentStore:
    return SegmentStore(tmp_path / "segments")


def test_the_default_library_is_under_the_config_dir(tmp_path: Path) -> None:
    assert default_directory() == tmp_path / "config" / "segments"
    assert SegmentStore().directory == default_directory()


def test_an_empty_library_lists_nothing(store: SegmentStore) -> None:
    assert list(store.list()) == []
    with pytest.raises(CodedValueError) as raised:
        store.get("nope")
    assert raised.value.code == "segment_unknown"


def test_adding_copies_the_segment_into_a_versioned_folder(
    store: SegmentStore, tmp_path: Path
) -> None:
    source = make_segment_dir(tmp_path)
    result = store.add(source)

    assert (result.status, result.version) == ("added", 1)
    folder = store.directory / result.id / "v1"
    assert (folder / "clip-01.flac").read_bytes() == b"fLaC-one"
    assert (folder / "segment.json").is_file()
    assert [s.id for s in store.list()] == [result.id]
    assert store.get(result.id).version == 1

    (source / "clip-01.flac").write_bytes(b"changed")
    assert (folder / "clip-01.flac").read_bytes() == b"fLaC-one"


def test_adding_the_same_content_again_is_a_no_op(store: SegmentStore, tmp_path: Path) -> None:
    first = store.add(make_segment_dir(tmp_path))
    again = store.add(make_segment_dir(tmp_path / "again"))

    assert again.status == "unchanged"
    assert (again.id, again.version) == (first.id, 1)
    assert store.versions(first.id) == [1]


def test_the_same_name_with_other_audio_is_the_next_version(
    store: SegmentStore, tmp_path: Path
) -> None:
    first = store.add(make_segment_dir(tmp_path))
    second = store.add(make_segment_dir(tmp_path / "b", audio=b"fLaC-two"))

    assert second.status == "new_version"
    assert (second.id, second.version) == (first.id, 2)
    assert (
        store.get(first.id, 1).media["clip-01.flac"] != store.get(first.id, 2).media["clip-01.flac"]
    )
    assert store.get(first.id).version == 2
    assert (store.directory / first.id / "v1" / "clip-01.flac").read_bytes() == b"fLaC-one"
    assert len(store.list()) == 1


def test_the_same_content_under_another_name_is_not_stored_twice(
    store: SegmentStore, tmp_path: Path
) -> None:
    first = store.add(make_segment_dir(tmp_path, name="Warm Intro"))
    other = store.add(make_segment_dir(tmp_path / "b", name="Cold Open"))

    assert other.status == "unchanged"
    assert other.id == first.id
    assert len(store.list()) == 1


def test_a_different_name_with_other_audio_is_its_own_segment(
    store: SegmentStore, tmp_path: Path
) -> None:
    store.add(make_segment_dir(tmp_path, name="Warm Intro"))
    other = store.add(make_segment_dir(tmp_path / "b", name="Cold Open", audio=b"fLaC-two"))

    assert (other.status, other.version) == ("added", 1)
    assert len(store.list()) == 2


def test_a_changed_audio_file_in_the_source_is_refused(store: SegmentStore, tmp_path: Path) -> None:
    source = make_segment_dir(tmp_path)
    (source / "clip-01.flac").write_bytes(b"tampered")

    with pytest.raises(CodedValueError) as raised:
        store.add(source)

    assert raised.value.code == "segment_hash_mismatch"
    assert list(store.list()) == []


def test_a_folder_without_segment_json_is_refused(store: SegmentStore, tmp_path: Path) -> None:
    with pytest.raises(CodedValueError) as raised:
        store.add(tmp_path)
    assert raised.value.code == "segment_invalid"


def test_reading_verifies_the_audio_hash(store: SegmentStore, tmp_path: Path) -> None:
    result = store.add(make_segment_dir(tmp_path))
    audio = store.directory / result.id / "v1" / "clip-01.flac"
    audio.write_bytes(b"fLaC-onX")

    with pytest.raises(CodedValueError) as raised:
        store.get(result.id)

    assert raised.value.code == "segment_hash_mismatch"
    assert list(store.list()) == []


def test_a_missing_audio_file_is_a_hash_mismatch(store: SegmentStore, tmp_path: Path) -> None:
    result = store.add(make_segment_dir(tmp_path))
    (store.directory / result.id / "v1" / "clip-01.flac").unlink()

    with pytest.raises(CodedValueError) as raised:
        store.get(result.id)

    assert raised.value.code == "segment_hash_mismatch"


def test_an_unknown_version_is_refused(store: SegmentStore, tmp_path: Path) -> None:
    result = store.add(make_segment_dir(tmp_path))
    with pytest.raises(CodedValueError) as raised:
        store.get(result.id, 5)
    assert raised.value.code == "segment_unknown"


def test_a_damaged_segment_json_is_unreadable(store: SegmentStore, tmp_path: Path) -> None:
    result = store.add(make_segment_dir(tmp_path))
    (store.directory / result.id / "v1" / "segment.json").unlink()
    with pytest.raises(CodedValueError) as raised:
        store.get(result.id)
    assert raised.value.code == "segment_unreadable"


def test_removing_deletes_every_version(store: SegmentStore, tmp_path: Path) -> None:
    first = store.add(make_segment_dir(tmp_path))
    store.add(make_segment_dir(tmp_path / "b", audio=b"fLaC-two"))

    store.remove(first.id)

    assert list(store.list()) == []
    assert not (store.directory / first.id).exists()
    with pytest.raises(CodedValueError) as raised:
        store.remove(first.id)
    assert raised.value.code == "segment_unknown"


@pytest.mark.parametrize("bad", ["../escape", "A B", ""])
def test_an_id_that_is_not_an_id_is_unknown(store: SegmentStore, bad: str) -> None:
    with pytest.raises(CodedValueError) as raised:
        store.remove(bad)
    assert raised.value.code == "segment_unknown"
