"""Show kits: the file, the library, the .sharecutkit bundle, apply, the CLI and the host tools."""

# ruff: noqa: F811  (the shared ``project`` fixture is imported, then used as a parameter)

from __future__ import annotations

import asyncio
import json
import zipfile
from pathlib import Path

import pytest
from pydantic import ValidationError
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import kits as kit_tools
from podcast_mcp.models import load_project
from podcast_mcp.project.io import RETIRED_PROJECT_FILENAME
from podcast_mcp.segments.kit import (
    MAX_KIT_ENTRIES,
    KitEntry,
    KitFile,
    KitStore,
    kit_id_for,
    parse_kit,
)
from podcast_mcp.segments.kit_bundle import export_kit, import_kit_bundle
from podcast_mcp.segments.kit_summary import resolve_kit, save_kit
from podcast_mcp.segments.model import SEGMENT_JSON, MediaEntry, segment_json
from podcast_mcp.segments.store import SegmentStore, sha256_file
from podcast_mcp.services.document import submit_kit_apply
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError
from test_segments_insert import _flac, _layout, _save, project  # noqa: F401

runner = CliRunner()


def _kit(name: str, *specs: tuple[str, object], **extra: object) -> KitFile:
    return KitFile(
        id=kit_id_for(name),
        name=name,
        entries=[KitEntry(segment_id=seg, at=at, **extra) for seg, at in specs],  # type: ignore[arg-type]
    )


def _code(result) -> str:
    assert result.exit_code != 0, result.output
    return result.output.split("(code ")[-1].split(")")[0]


@pytest.fixture
def library(tmp_path: Path) -> tuple[str, str]:
    intro = _save(tmp_path, "Warm Intro")
    outro = _save(tmp_path, "Sign Off", fader_db=-6.0)
    return intro.id, outro.id


def _show_kit(library: tuple[str, str]) -> KitFile:
    intro, outro = library
    kit = _kit("Show Kit", (intro, "start"), (outro, "end"))
    KitStore().add(kit)
    return kit


# ---- the file ---------------------------------------------------------------------------


def test_kit_id_is_derived_from_the_name_like_a_segment() -> None:
    assert kit_id_for("Show Kit").startswith("show-kit-")
    assert kit_id_for(" Show Kit ") == kit_id_for("Show Kit")
    with pytest.raises(CodedValueError) as err:
        kit_id_for("!!!")
    assert err.value.code == "kit_name_invalid"


def test_kit_json_refuses_unknown_fields_and_bad_values() -> None:
    good = {
        "schema_version": 1,
        "id": kit_id_for("K"),
        "name": "K",
        "version": 1,
        "entries": [{"segment_id": "a-12345678", "at": "END", "version": None}],
    }
    assert parse_kit(json.dumps(good)).entries[0].at == "end"
    for patch in (
        {"extra": 1},
        {"entries": []},
        {"entries": [{"segment_id": "a-12345678", "at": "soon"}]},
        {"entries": [{"segment_id": "a-12345678", "at": -1}]},
        {"entries": [{"segment_id": "a-12345678", "at": 1, "extra": 1}]},
        {"entries": [{"segment_id": "A B", "at": 1}]},
        {"entries": [{"segment_id": "a-12345678", "at": 1, "version": True}]},
        {"entries": [{"segment_id": "a-12345678", "at": 1, "version": 0}]},
        {"id": "Not An Id"},
        {"entries": [{"segment_id": "a-12345678", "at": 1}] * (MAX_KIT_ENTRIES + 1)},
    ):
        with pytest.raises(CodedValueError) as err:
            parse_kit(json.dumps({**good, **patch}))
        assert err.value.code == "kit_invalid", patch
    for version in (2, True, "1", 1.0):
        with pytest.raises(CodedValueError) as err:
            parse_kit(json.dumps({**good, "schema_version": version}))
        assert err.value.code == "kit_schema_unsupported"
    for raw in ("[]", "not json", b"\xff"):
        with pytest.raises(CodedValueError) as err:
            parse_kit(raw)
        assert err.value.code == "kit_invalid"
    with pytest.raises(ValidationError):
        KitFile(id="x", name="K", entries=[])


# ---- the library ------------------------------------------------------------------------


def test_store_versions_dedupes_and_removes(library: tuple[str, str]) -> None:
    intro, outro = library
    kits = KitStore()
    first = save_kit(kits, SegmentStore(), "Show Kit", [KitEntry(segment_id=intro, at="start")])
    again = save_kit(kits, SegmentStore(), "Show Kit", [KitEntry(segment_id=intro, at="start")])
    other = save_kit(
        kits,
        SegmentStore(),
        "Show Kit",
        [KitEntry(segment_id=intro, at="start"), KitEntry(segment_id=outro, at="end")],
    )
    assert (first.status, first.version) == ("added", 1)
    assert (again.status, again.version) == ("unchanged", 1)
    assert (other.status, other.version) == ("new_version", 2)
    assert kits.get(first.id).version == 2
    assert kits.get(first.id, 1).entries[0].segment_id == intro
    assert list(kits.versions(first.id)) == [1, 2]
    with pytest.raises(CodedValueError) as err:
        kits.get(first.id, 9)
    assert err.value.code == "kit_unknown"
    kits.remove(first.id)
    for call in (
        lambda: kits.get(first.id),
        lambda: kits.remove(first.id),
        lambda: kits.remove("../x"),
    ):
        with pytest.raises(CodedValueError) as err:
            call()
        assert err.value.code == "kit_unknown"


def test_a_damaged_kit_is_listed_not_hidden(library: tuple[str, str]) -> None:
    kit = _show_kit(library)
    kits = KitStore()
    (kits.directory / kit.id / "v1" / "kit.json").write_text("{", encoding="utf-8")
    listing = kits.scan()
    assert not listing.kits and listing.damaged[0].code == "kit_invalid"
    rows = json.loads(runner.invoke(app, ["kit", "list", "--json"]).output)
    assert rows[0]["damaged"] is True
    assert "DAMAGED" in runner.invoke(app, ["kit", "list"]).output


def test_save_names_every_missing_segment_and_writes_nothing(library: tuple[str, str]) -> None:
    intro, _ = library
    with pytest.raises(CodedValueError) as err:
        save_kit(
            KitStore(),
            SegmentStore(),
            "Show Kit",
            [
                KitEntry(segment_id=intro, at="start"),
                KitEntry(segment_id="ghost-12345678", at="end"),
                KitEntry(segment_id=intro, version=7, at=3),
            ],
        )
    assert err.value.code == "kit_segment_missing"
    assert "entry 2 (ghost-12345678)" in str(err.value)
    assert "entry 3" in str(err.value) and "version 7" in str(err.value)
    assert not KitStore().directory.exists() or not list(KitStore().directory.glob("show-*"))
    with pytest.raises(CodedValueError) as err:
        save_kit(KitStore(), SegmentStore(), "Show Kit", [])
    assert err.value.code == "kit_invalid"


# ---- the bundle -------------------------------------------------------------------------


def _export(tmp_path: Path, library: tuple[str, str]) -> tuple[KitFile, Path]:
    kit = _show_kit(library)
    return kit, export_kit(KitStore(), SegmentStore(), kit.id, tmp_path / "show.sharecutkit")


def _fresh(tmp_path: Path, name: str) -> tuple[KitStore, SegmentStore]:
    return KitStore(tmp_path / name / "kits"), SegmentStore(tmp_path / name / "segments")


def test_export_import_round_trip_and_reimport_is_a_no_op(
    tmp_path: Path, library: tuple[str, str]
) -> None:
    kit, bundle = _export(tmp_path, library)
    with zipfile.ZipFile(bundle) as archive:
        names = set(archive.namelist())
    assert {"kit.json", "MANIFEST.sha256", "seg01__segment.json", "seg02__clip-01.flac"} <= names
    kits, segments = _fresh(tmp_path, "other")

    first = import_kit_bundle(kits, segments, bundle)
    assert first.kit.status == "added"
    assert {s.status for s in first.segments} == {"added"}
    assert [s.id for s in segments.list()] == sorted(library)
    assert kits.get(kit.id).entries == KitStore().get(kit.id).entries

    before = {p: p.read_bytes() for p in (tmp_path / "other").rglob("*") if p.is_file()}
    again = import_kit_bundle(kits, segments, bundle)
    assert again.kit.status == "unchanged"
    assert {s.status for s in again.segments} == {"unchanged"}
    assert before == {p: p.read_bytes() for p in (tmp_path / "other").rglob("*") if p.is_file()}


def test_import_remaps_pinned_versions_to_this_library(tmp_path: Path) -> None:
    first = _save(tmp_path, "Warm Intro")
    # A second version of the same name with other audio, then a kit pinned to version 2.
    folder = tmp_path / "v2"
    folder.mkdir()
    audio = _flac(folder / "clip-01.flac", 2.5)
    newer = first.model_copy(
        update={
            "clips": [first.clips[0].model_copy(update={"duration_sec": 2.5})],
            "media": {
                "clip-01.flac": MediaEntry(sha256=sha256_file(audio), bytes=audio.stat().st_size)
            },
        }
    )
    (folder / SEGMENT_JSON).write_text(segment_json(newer), encoding="utf-8")
    assert SegmentStore().add(folder).version == 2
    save_kit(
        KitStore(), SegmentStore(), "Pinned", [KitEntry(segment_id=first.id, version=2, at="start")]
    )
    bundle = export_kit(
        KitStore(), SegmentStore(), kit_id_for("Pinned"), tmp_path / "p.sharecutkit"
    )
    kits, segments = _fresh(tmp_path, "other")
    result = import_kit_bundle(kits, segments, bundle)
    # Only the version the kit uses travels, and it is version 1 in the new library.
    assert [s.version for s in result.segments] == [1]
    assert kits.get(kit_id_for("Pinned")).entries[0].version == 1
    assert segments.get(first.id, 1).duration_sec == pytest.approx(2.5)


def test_on_conflict_skip_keeps_my_kit_and_new_version_stores_it(
    tmp_path: Path, library: tuple[str, str]
) -> None:
    intro, _outro = library
    kit, bundle = _export(tmp_path, library)
    kits, segments = _fresh(tmp_path, "other")
    mine = save_kit(
        kits, segments_for(library, segments), "Show Kit", [KitEntry(segment_id=intro, at="end")]
    )
    assert mine.status == "added"

    skipped = import_kit_bundle(kits, segments, bundle, on_conflict="skip")
    assert skipped.kit.status == "skipped" and skipped.kit.version == 1
    assert kits.get(kit.id).entries[0].at == "end" and len(kits.get(kit.id).entries) == 1

    added = import_kit_bundle(kits, segments, bundle, on_conflict="new-version")
    assert (added.kit.status, added.kit.version) == ("new_version", 2)
    assert len(kits.get(kit.id).entries) == 2
    assert len(kits.get(kit.id, 1).entries) == 1
    with pytest.raises(CodedValueError) as err:
        import_kit_bundle(kits, segments, bundle, on_conflict="merge")  # type: ignore[arg-type]
    assert err.value.code == "kit_on_conflict_invalid"


def segments_for(library: tuple[str, str], target: SegmentStore) -> SegmentStore:
    """Copy the library's segments into ``target`` so a kit can be saved against it."""
    for segment_id in library:
        source = SegmentStore().path(segment_id)
        target.add(source)
    return target


def _tampered(src: Path, dest: Path, edit) -> Path:
    with zipfile.ZipFile(src) as source, zipfile.ZipFile(dest, "w") as target:
        members = {i.filename: source.read(i) for i in source.infolist()}
        members = edit(members)
        for name, data in members.items():
            target.writestr(name, data)
    return dest


def _import_code(tmp_path: Path, bundle: Path) -> str:
    kits, segments = _fresh(tmp_path, "victim")
    with pytest.raises(CodedValueError) as err:
        import_kit_bundle(kits, segments, bundle)
    assert not (tmp_path / "victim" / "segments").exists() or not segments.list()
    assert not kits.list()
    return err.value.code


def test_import_refuses_hostile_or_broken_bundles(tmp_path: Path, library: tuple[str, str]) -> None:
    _, bundle = _export(tmp_path, library)

    def rewrite(edit, name: str = "t.sharecutkit") -> str:
        return _import_code(tmp_path, _tampered(bundle, tmp_path / name, edit))

    def manifest_for(members: dict[str, bytes]) -> bytes:
        import hashlib

        return "".join(
            f"{hashlib.sha256(d).hexdigest()}  {n}\n"
            for n, d in members.items()
            if n != "MANIFEST.sha256"
        ).encode()

    def regen(members: dict[str, bytes]) -> dict[str, bytes]:
        members["MANIFEST.sha256"] = manifest_for(members)
        return members

    not_zip = tmp_path / "plain.sharecutkit"
    not_zip.write_text("nope")
    assert _import_code(tmp_path, not_zip) == "kit_bundle_invalid"
    assert _import_code(tmp_path, tmp_path / "missing.sharecutkit") == "kit_bundle_invalid"

    assert rewrite(lambda m: {**m, "../evil": b"x"}) == "kit_bundle_invalid"
    assert rewrite(lambda m: {**m, "sub/dir.txt": b"x"}) == "kit_bundle_invalid"
    assert rewrite(lambda m: {**m, "other.flac": b"x"}) == "kit_bundle_invalid"
    assert rewrite(lambda m: {**m, "seg01__CLIP-01.FLAC": b"x"}) == "kit_bundle_invalid"
    assert (
        rewrite(lambda m: {k: v for k, v in m.items() if k != "MANIFEST.sha256"})
        == "kit_bundle_invalid"
    )
    assert (
        rewrite(lambda m: {k: v for k, v in m.items() if k != "kit.json"}) == "kit_bundle_invalid"
    )
    assert rewrite(lambda m: {**m, "MANIFEST.sha256": b"garbage\n"}) == "kit_bundle_invalid"
    assert rewrite(lambda m: {**m, "seg01__extra.flac": b"x"}) == "kit_bundle_invalid"
    assert rewrite(lambda m: {**m, "seg01__clip-01.flac": b"changed"}) == "kit_hash_mismatch"
    assert rewrite(lambda m: regen({**m, "seg01__stray.flac": b"x"})) == "kit_bundle_invalid"
    assert rewrite(lambda m: regen({**m, "seg01__segment.json": b"{"})) == "kit_bundle_invalid"
    assert (
        rewrite(
            lambda m: regen(
                {**m, "seg01__segment.json": json.dumps({"schema_version": 2}).encode()}
            )
        )
        == "kit_schema_unsupported"
    )
    assert rewrite(lambda m: regen({**m, "kit.json": b"{"})) == "kit_invalid"
    assert (
        rewrite(lambda m: regen({**m, "kit.json": json.dumps({"schema_version": 3}).encode()}))
        == "kit_schema_unsupported"
    )

    def names_a_ghost(m: dict[str, bytes]) -> dict[str, bytes]:
        data = json.loads(m["kit.json"])
        data["entries"][0]["segment_id"] = "ghost-12345678"
        return regen({**m, "kit.json": json.dumps(data).encode()})

    assert rewrite(names_a_ghost) == "kit_bundle_invalid"

    def wrong_id(m: dict[str, bytes]) -> dict[str, bytes]:
        data = json.loads(m["kit.json"])
        data["id"] = "other-12345678"
        return regen({**m, "kit.json": json.dumps(data).encode()})

    assert rewrite(wrong_id) == "kit_invalid"


def test_import_caps_entries_zip_bombs_and_sizes(tmp_path: Path, library: tuple[str, str]) -> None:
    _, bundle = _export(tmp_path, library)
    many = _tampered(
        bundle,
        tmp_path / "many.sharecutkit",
        lambda m: {**m, **{f"seg01__f{i}.flac": b"x" for i in range(520)}},
    )
    assert _import_code(tmp_path, many) == "kit_bundle_invalid"

    bomb = tmp_path / "bomb.sharecutkit"
    with (
        zipfile.ZipFile(bundle) as source,
        zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as target,
    ):
        for info in source.infolist():
            target.writestr(info.filename, source.read(info))
        target.writestr("seg01__bomb.flac", bytes(64 * 1024 * 1024))
    assert _import_code(tmp_path, bomb) == "kit_bundle_invalid"

    big_json = _tampered(
        bundle,
        tmp_path / "bigjson.sharecutkit",
        lambda m: {**m, "kit.json": b" " * (1024 * 1024 + 1)},
    )
    assert _import_code(tmp_path, big_json) == "kit_bundle_invalid"


def test_import_refuses_a_non_regular_entry(tmp_path: Path, library: tuple[str, str]) -> None:
    _, bundle = _export(tmp_path, library)
    link = tmp_path / "link.sharecutkit"
    with zipfile.ZipFile(bundle) as source, zipfile.ZipFile(link, "w") as target:
        for info in source.infolist():
            target.writestr(info, source.read(info))
        symlink = zipfile.ZipInfo("seg01__link.flac")
        symlink.external_attr = 0o120777 << 16
        target.writestr(symlink, "kit.json")
    assert _import_code(tmp_path, link) == "kit_bundle_invalid"


def test_export_refuses_a_kit_with_missing_segments(
    tmp_path: Path, library: tuple[str, str]
) -> None:
    kit = _show_kit(library)
    SegmentStore().remove(library[1])
    with pytest.raises(CodedValueError) as err:
        export_kit(KitStore(), SegmentStore(), kit.id, tmp_path / "x.sharecutkit")
    assert err.value.code == "kit_segment_missing"
    assert not (tmp_path / "x.sharecutkit").exists()


# ---- apply ------------------------------------------------------------------------------


def _spans(path: str) -> list[tuple[str, float, float]]:
    return sorted(
        (c.segment_ref.segment_id if c.segment_ref else c.id, c.timeline_start, c.timeline_end)
        for c in load_project(Path(path)).clips
    )


def test_apply_resolves_end_after_earlier_entries_ripple(
    project: str,
    library: tuple[str, str],
) -> None:
    intro, outro = library
    kit = _show_kit(library)

    result = submit_kit_apply(project, kit.id)

    assert result["dry_run"] is False and result["undo_steps"] == 2
    assert result["timeline_duration_before_sec"] == pytest.approx(8.0)
    assert result["timeline_duration_after_sec"] == pytest.approx(12.0)
    spans = {s[0]: s for s in _spans(project)}
    assert (spans[intro][1], spans[intro][2]) == (0.0, 2.0)
    # c1/c2 moved by the intro, then the outro landed at the end of the rippled timeline.
    assert (spans["c1"][1], spans["c1"][2]) == (2.0, 6.0)
    assert (spans["c2"][1], spans["c2"][2]) == (6.0, 10.0)
    assert (spans[outro][1], spans[outro][2]) == (10.0, 12.0)
    assert [e["at"] for e in result["entries"]] == [0.0, 10.0]
    rows = DocumentSyncService.open(project).store.commands_after(0)
    assert [r["type"] for r in rows] == ["InsertSegment", "InsertSegment"]
    assert [r["payload"]["segment_id"] for r in rows] == [intro, outro]
    assert rows[1]["payload"]["version"] == 1


def test_apply_is_one_undo_step_per_entry(project: str, library: tuple[str, str]) -> None:
    before = _layout(project)
    kit = _show_kit(library)
    submit_kit_apply(project, kit.id)
    applied = _layout(project)
    assert runner.invoke(app, ["undo", "--project", project]).exit_code == 0
    assert _layout(project) not in (before, applied)
    assert runner.invoke(app, ["undo", "--project", project]).exit_code == 0
    assert _layout(project) == before


def test_apply_uses_a_pinned_version_and_numeric_positions(
    project: str,
    library: tuple[str, str],
) -> None:
    intro, outro = library
    save_kit(
        KitStore(),
        SegmentStore(),
        "Numbers",
        [
            KitEntry(segment_id=intro, version=1, at=4),
            KitEntry(segment_id=outro, at="start", note="hi"),
        ],
    )
    result = submit_kit_apply(project, kit_id_for("Numbers"))
    assert [e["at"] for e in result["entries"]] == [4.0, 0.0]
    assert result["entries"][1]["note"] == "hi"
    spans = {s[0]: s for s in _spans(project)}
    assert spans[outro][1] == 0.0 and spans[intro][1] == 6.0  # the second entry moved the first


def test_refusal_before_write_names_every_missing_entry(
    project: str,
    library: tuple[str, str],
) -> None:
    intro, outro = library
    kit = _show_kit(library)
    SegmentStore().remove(outro)
    SegmentStore().remove(intro)
    before = Path(project).read_bytes()

    for dry in (False, True):
        with pytest.raises(CodedValueError) as err:
            submit_kit_apply(project, kit.id, dry_run=dry)
        assert err.value.code == "kit_segment_missing"
        assert f"entry 1 ({intro})" in str(err.value) and f"entry 2 ({outro})" in str(err.value)
    assert Path(project).read_bytes() == before
    assert DocumentSyncService.open(project).store.commands_after(0) == []


def test_a_tampered_segment_or_bad_position_refuses_before_any_write(
    project: str,
    library: tuple[str, str],
) -> None:
    intro, outro = library
    kit = _kit("Show Kit", (intro, "start"), (outro, 99))
    KitStore().add(kit)
    before = Path(project).read_bytes()
    with pytest.raises(CodedValueError) as err:
        submit_kit_apply(project, kit.id)
    # Entry 2 is past the end once entry 1 has rippled (12 s)... 99 is still out of range.
    assert err.value.code == "segment_position_out_of_range"
    assert "Kit entry 2 of 2" in str(err.value) and "Nothing was changed" in str(err.value)
    assert Path(project).read_bytes() == before
    assert DocumentSyncService.open(project).store.commands_after(0) == []

    good = _show_kit(library)
    audio = SegmentStore().path(outro, 1) / "clip-01.flac"
    audio.write_bytes(audio.read_bytes() + b"x")
    with pytest.raises(CodedValueError) as err:
        submit_kit_apply(project, good.id)
    assert err.value.code == "segment_hash_mismatch"
    assert Path(project).read_bytes() == before


def test_dry_run_is_read_only_and_reports_chained_effects(
    project: str,
    library: tuple[str, str],
) -> None:
    kit = _show_kit(library)
    entry = Path(project)
    retired = entry.with_name(RETIRED_PROJECT_FILENAME)
    entry.rename(retired)
    snapshot = {p: p.read_bytes() for p in retired.parent.rglob("*") if p.is_file()}

    dry = submit_kit_apply(str(retired), kit.id, dry_run=True)

    assert retired.exists() and not entry.exists()
    assert snapshot == {p: p.read_bytes() for p in retired.parent.rglob("*") if p.is_file()}
    assert dry["dry_run"] is True
    assert [e["at"] for e in dry["entries"]] == [0.0, 10.0]
    assert dry["entries"][0]["clips_moved"] == 2
    assert dry["timeline_duration_before_sec"] == pytest.approx(8.0)
    assert dry["timeline_duration_after_sec"] == pytest.approx(12.0)
    assert not list((retired.parent / "raw").glob("segment-*"))


# ---- CLI --------------------------------------------------------------------------------


def test_cli_save_list_show_remove(library: tuple[str, str]) -> None:
    intro, outro = library
    saved = runner.invoke(
        app, ["kit", "save", "Show Kit", "-s", intro, "-s", f"{outro}@1:end", "--json"]
    )
    assert saved.exit_code == 0, saved.output
    kit_id = json.loads(saved.output)["id"]
    again = runner.invoke(app, ["kit", "save", "Show Kit", "-s", intro, "-s", f"{outro}@1:end"])
    assert "Already in the library" in again.output

    listed = runner.invoke(app, ["kit", "list"])
    assert kit_id in listed.output and "2 segments" in listed.output
    rows = json.loads(runner.invoke(app, ["kit", "list", "--json"]).output)
    assert rows[0]["missing"] == 0 and rows[0]["entries"] == 2

    shown = runner.invoke(app, ["kit", "show", kit_id])
    assert f"1. {intro} at start" in shown.output and f"2. {outro} v1 at end" in shown.output
    detail = json.loads(runner.invoke(app, ["kit", "show", kit_id, "--json"]).output)
    assert detail["entries"][1]["present"] is True and detail["versions"] == [1]

    SegmentStore().remove(outro)
    assert "MISSING" in runner.invoke(app, ["kit", "show", kit_id]).output
    assert "1 segments missing" in runner.invoke(app, ["kit", "list"]).output

    assert runner.invoke(app, ["kit", "remove", kit_id]).exit_code == 0
    assert _code(runner.invoke(app, ["kit", "show", kit_id])) == "kit_unknown"
    assert _code(runner.invoke(app, ["kit", "remove", kit_id])) == "kit_unknown"
    assert "No kits yet" in runner.invoke(app, ["kit", "list"]).output
    # Removing a kit never removes its segments.
    assert [s.id for s in SegmentStore().list()] == [intro]


def test_cli_save_errors_carry_their_codes(library: tuple[str, str]) -> None:
    intro, _ = library
    assert (
        _code(runner.invoke(app, ["kit", "save", "K", "-s", "ghost-12345678"]))
        == "kit_segment_missing"
    )
    assert _code(runner.invoke(app, ["kit", "save", "!!!", "-s", intro])) == "kit_name_invalid"
    assert _code(runner.invoke(app, ["kit", "save", "K", "-s", f"{intro}:soon"])) == "kit_invalid"
    assert _code(runner.invoke(app, ["kit", "save", "K", "-s", f"{intro}:-2"])) == "kit_invalid"
    assert (
        _code(runner.invoke(app, ["kit", "save", "K", "-s", f"{intro}@x"]))
        == "segment_version_invalid"
    )
    assert runner.invoke(app, ["kit", "save", "K"]).exit_code == 2


def test_cli_export_import_and_apply(
    tmp_path: Path,
    project: str,
    library: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kit = _show_kit(library)
    out = tmp_path / "show.sharecutkit"
    assert runner.invoke(app, ["kit", "export", kit.id, "-o", str(out)]).exit_code == 0
    assert out.is_file()

    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(tmp_path / "second"))
    first = runner.invoke(app, ["kit", "import", str(out)])
    assert first.exit_code == 0 and "Saved kit" in first.output
    assert (
        json.loads(runner.invoke(app, ["kit", "import", str(out), "--json"]).output)["kit"][
            "status"
        ]
        == "unchanged"
    )
    skip = runner.invoke(app, ["kit", "import", str(out), "--on-conflict", "skip"])
    assert skip.exit_code == 0
    assert (
        _code(runner.invoke(app, ["kit", "import", str(out), "--on-conflict", "merge"]))
        == "kit_on_conflict_invalid"
    )
    bad = tmp_path / "bad.sharecutkit"
    bad.write_text("x")
    assert _code(runner.invoke(app, ["kit", "import", str(bad)])) == "kit_bundle_invalid"
    assert (
        _code(runner.invoke(app, ["kit", "export", "ghost-12345678", "-o", str(out)]))
        == "kit_unknown"
    )

    dry = runner.invoke(app, ["kit", "apply", kit.id, project, "--dry-run"])
    assert dry.exit_code == 0, dry.output
    assert "Would insert" in dry.output and "Nothing was changed" in dry.output
    assert _spans(project)[0][0] == "c1"
    real = runner.invoke(app, ["kit", "apply", kit.id, project])
    assert real.exit_code == 0, real.output
    assert "2 undo steps" in real.output and "8 s to 12 s" in real.output
    as_json = runner.invoke(app, ["kit", "apply", kit.id, project, "--json", "--dry-run"])
    assert json.loads(as_json.output)["dry_run"] is True


def test_cli_apply_errors(project: str, library: tuple[str, str]) -> None:
    assert _code(runner.invoke(app, ["kit", "apply", "ghost-12345678", project])) == "kit_unknown"
    kit = _show_kit(library)
    SegmentStore().remove(library[0])
    refused = runner.invoke(app, ["kit", "apply", kit.id, project])
    assert _code(refused) == "kit_segment_missing"


# ---- host tools -------------------------------------------------------------------------


def test_host_tools_match_the_cli_and_are_absent_for_guests(
    project: str,
    library: tuple[str, str],
) -> None:
    from podcast_mcp.services.remote_mcp.allowlist import ALL_GUEST_TOOLS
    from podcast_mcp.services.remote_mcp.tools import TOOL_HANDLERS

    intro, outro = library
    names = {"kit_list_tool", "kit_show_tool", "kit_save_tool", "kit_apply_tool"}
    assert names <= {t.name for t in asyncio.run(mcp_server.mcp.list_tools())}
    assert names.isdisjoint(ALL_GUEST_TOOLS) and names.isdisjoint(TOOL_HANDLERS)
    assert not any("kit" in name for name in ALL_GUEST_TOOLS)

    saved = json.loads(
        kit_tools.kit_save_tool(
            "Show Kit",
            [
                {"segment_id": intro, "at": "start"},
                {"segment_id": outro, "at": "END", "note": "bye"},
            ],
        )
    )
    assert saved["status"] == "added"
    assert json.loads(kit_tools.kit_list_tool())[0]["entries"] == 2
    assert json.loads(kit_tools.kit_show_tool(saved["id"]))["entries"][1]["note"] == "bye"

    dry = json.loads(kit_tools.kit_apply_tool(project, saved["id"], dry_run=True))
    assert dry["dry_run"] is True and _spans(project)[0][0] == "c1"
    done = json.loads(kit_tools.kit_apply_tool(project, saved["id"]))
    assert done["undo_steps"] == 2 and done["timeline_duration_after_sec"] == pytest.approx(12.0)

    for call, code in (
        (lambda: kit_tools.kit_show_tool("ghost-12345678"), "kit_unknown"),
        (lambda: kit_tools.kit_apply_tool(project, "ghost-12345678"), "kit_unknown"),
        (
            lambda: kit_tools.kit_save_tool("K", [{"segment_id": "ghost-12345678", "at": 1}]),
            "kit_segment_missing",
        ),
        (
            lambda: kit_tools.kit_save_tool("K", [{"segment_id": intro, "at": "soon"}]),
            "kit_invalid",
        ),
        (lambda: kit_tools.kit_save_tool("K", [{"segment_id": intro}]), "kit_invalid"),
        (lambda: kit_tools.kit_save_tool("K", []), "kit_invalid"),
    ):
        with pytest.raises(CodedValueError) as err:
            call()
        assert err.value.code == code


def test_resolve_pins_the_newest_version(library: tuple[str, str]) -> None:
    kit = _show_kit(library)
    assert [r.version for r in resolve_kit(kit, SegmentStore())] == [1, 1]


# ---- doctor -----------------------------------------------------------------------------


def test_doctor_warns_about_a_kit_whose_segments_are_missing(library: tuple[str, str]) -> None:
    from podcast_mcp.services.support import doctor as doctor_module
    from podcast_mcp.services.support.doctor import run_doctor_checks

    assert doctor_module._kit_library_checks() == []
    kit = _show_kit(library)
    assert doctor_module._kit_library_checks() == []
    assert not any("kit" in c.message for c in run_doctor_checks().checks)

    SegmentStore().remove(library[1])
    checks = doctor_module._kit_library_checks()
    assert len(checks) == 1 and checks[0].status == "warn"
    assert kit.id in checks[0].message and library[1] in checks[0].message
    assert "Fix:" in (checks[0].extra or "") and kit.id in (checks[0].extra or "")
    report = run_doctor_checks()
    assert report.passed and any(kit.id in c.message for c in report.checks)

    (KitStore().directory / kit.id / "v1" / "kit.json").write_text("{", encoding="utf-8")
    assert any(
        "kit_invalid" in c.message or "kit.json" in c.message
        for c in doctor_module._kit_library_checks()
    )


# ---- review fixes -----------------------------------------------------------------------


def _regen(members: dict[str, bytes]) -> dict[str, bytes]:
    import hashlib

    members.pop("MANIFEST.sha256", None)
    members["MANIFEST.sha256"] = "".join(
        f"{hashlib.sha256(d).hexdigest()}  {n}\n" for n, d in members.items()
    ).encode()
    return members


def test_import_refuses_a_member_no_kit_entry_names_and_writes_nothing(
    tmp_path: Path, library: tuple[str, str]
) -> None:
    _, bundle = _export(tmp_path, library)

    def drop_second_entry(m: dict[str, bytes]) -> dict[str, bytes]:
        data = json.loads(m["kit.json"])
        data["entries"] = data["entries"][:1]
        return _regen({**m, "kit.json": json.dumps(data).encode()})

    assert (
        _import_code(tmp_path, _tampered(bundle, tmp_path / "s.sharecutkit", drop_second_entry))
        == "kit_bundle_invalid"
    )


def test_import_reads_kit_and_manifest_before_it_unpacks_any_audio(
    tmp_path: Path, library: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.segments import kit_bundle

    _, bundle = _export(tmp_path, library)

    def ghost(m: dict[str, bytes]) -> dict[str, bytes]:
        data = json.loads(m["kit.json"])
        data["entries"][0]["segment_id"] = "ghost-12345678"
        return _regen({**m, "kit.json": json.dumps(data).encode()})

    def no_unpack(*_args: object, **_kwargs: object) -> int:
        raise AssertionError("audio was unpacked before the kit was checked")

    monkeypatch.setattr(kit_bundle, "_unpack", no_unpack)
    assert (
        _import_code(tmp_path, _tampered(bundle, tmp_path / "g.sharecutkit", ghost))
        == "kit_bundle_invalid"
    )
    bad_hash = _tampered(
        bundle, tmp_path / "h.sharecutkit", lambda m: {**m, "kit.json": m["kit.json"] + b" "}
    )
    assert _import_code(tmp_path, bad_hash) == "kit_hash_mismatch"


def test_import_applies_the_ratio_check_from_64_kib_and_caps_files_per_segment(
    tmp_path: Path, library: tuple[str, str]
) -> None:
    _, bundle = _export(tmp_path, library)
    bomb = tmp_path / "small-bomb.sharecutkit"
    with (
        zipfile.ZipFile(bundle) as source,
        zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as target,
    ):
        for info in source.infolist():
            target.writestr(info.filename, source.read(info))
        target.writestr("seg01__zeros.flac", bytes(256 * 1024))
    assert _import_code(tmp_path, bomb) == "kit_bundle_invalid"

    crowded = _tampered(
        bundle,
        tmp_path / "crowded.sharecutkit",
        lambda m: _regen({**m, **{f"seg01__f{i}.flac": b"x" for i in range(9)}}),
    )
    assert _import_code(tmp_path, crowded) == "kit_bundle_invalid"


def test_a_later_bad_member_leaves_the_library_untouched(
    tmp_path: Path, library: tuple[str, str]
) -> None:
    _, bundle = _export(tmp_path, library)

    def wrong_member_id(m: dict[str, bytes]) -> dict[str, bytes]:
        data = json.loads(m["seg02__segment.json"])
        data["id"] = "other-1a2b3c4d"
        return _regen({**m, "seg02__segment.json": json.dumps(data).encode()})

    # _import_code asserts the victim library and kit store are empty afterwards.
    assert (
        _import_code(tmp_path, _tampered(bundle, tmp_path / "w.sharecutkit", wrong_member_id))
        == "kit_bundle_invalid"
    )


def test_import_says_lock_and_write_failures_in_kit_codes(
    tmp_path: Path, library: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, bundle = _export(tmp_path, library)
    kits, segments = _fresh(tmp_path, "busy")
    for segment_code, kit_code in (
        ("segment_busy", "kit_busy"),
        ("segment_write_failed", "kit_write_failed"),
    ):

        def refuse(*_a: object, _c: str = segment_code, **_k: object) -> None:
            raise CodedValueError("no", code=_c)

        monkeypatch.setattr(segments, "add", refuse)
        with pytest.raises(CodedValueError) as err:
            import_kit_bundle(kits, segments, bundle)
        assert err.value.code == kit_code


def test_apply_failure_after_the_first_write_names_the_entry_and_the_count(
    project: str, library: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.document import kit_apply
    from podcast_mcp.util.write_failure import ProjectWriteFailedError

    kit = _show_kit(library)
    real = kit_apply.submit_segment_insert
    calls: list[int] = []

    def flaky(*args: object, **kwargs: object) -> dict:
        calls.append(1)
        if len(calls) == 2:
            raise ProjectWriteFailedError("The disk is full.", status=507)
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(kit_apply, "submit_segment_insert", flaky)
    with pytest.raises(Exception) as err:
        submit_kit_apply(project, kit.id)
    assert err.value.code == "project_write_failed"  # type: ignore[attr-defined]
    text = str(err.value)
    assert "Kit entry 2 of 2" in text and "disk is full" in text
    assert "1 earlier entry was already applied" in text
    assert len(DocumentSyncService.open(project).store.commands_after(0)) == 1


def test_saving_an_older_list_again_is_a_new_version(library: tuple[str, str]) -> None:
    intro, outro = library
    kits, segments = KitStore(), SegmentStore()
    a = [KitEntry(segment_id=intro, at="start")]
    b = [KitEntry(segment_id=outro, at="end")]
    assert save_kit(kits, segments, "Flip", a).version == 1
    assert save_kit(kits, segments, "Flip", b).version == 2
    again = save_kit(kits, segments, "Flip", a)
    assert (again.status, again.version) == ("new_version", 3)
    assert save_kit(kits, segments, "Flip", a).status == "unchanged"


def test_kit_name_and_note_are_capped_and_a_name_clash_is_refused(library: tuple[str, str]) -> None:
    intro, _ = library
    with pytest.raises(CodedValueError) as err:
        save_kit(KitStore(), SegmentStore(), "x" * 201, [KitEntry(segment_id=intro, at=1)])
    assert err.value.code == "kit_invalid"
    with pytest.raises(CodedValueError) as err:
        kit_tools.kit_save_tool("K", [{"segment_id": intro, "at": 1, "note": "n" * 501}])
    assert err.value.code == "kit_invalid"
    KitStore().add(_kit("Same", (intro, 1)))
    clash = KitFile(id=kit_id_for("Same"), name=" Same", entries=[KitEntry(segment_id=intro, at=2)])
    with pytest.raises(CodedValueError) as err:
        KitStore().add(clash)
    assert err.value.code == "kit_invalid"


def test_member_names_take_ascii_digits_only(tmp_path: Path, library: tuple[str, str]) -> None:
    _, bundle = _export(tmp_path, library)
    odd = _tampered(
        bundle,
        tmp_path / "odd.sharecutkit",
        lambda m: _regen({**m, "seg\u0660\u0661__a.flac": b"x"}),
    )
    assert _import_code(tmp_path, odd) == "kit_bundle_invalid"


def test_cli_and_tool_refuse_the_same_entries_with_the_same_codes(library: tuple[str, str]) -> None:
    intro, _ = library
    cases = [
        (
            f"{intro}@x",
            {"segment_id": intro, "at": "start", "version": "x"},
            "segment_version_invalid",
        ),
        (
            f"{intro}@0",
            {"segment_id": intro, "at": "start", "version": 0},
            "segment_version_invalid",
        ),
        (
            f"{intro}@1.5",
            {"segment_id": intro, "at": "start", "version": 1.5},
            "segment_version_invalid",
        ),
        (f"{intro}:soon", {"segment_id": intro, "at": "soon"}, "kit_invalid"),
        (f"{intro}:-1", {"segment_id": intro, "at": -1}, "kit_invalid"),
        ("BAD ID", {"segment_id": "BAD ID", "at": "start"}, "kit_invalid"),
    ]
    for spec, entry, code in cases:
        cli = runner.invoke(app, ["kit", "save", "K", "-s", spec])
        assert _code(cli) == code, spec
        with pytest.raises(CodedValueError) as err:
            kit_tools.kit_save_tool("K", [entry])
        assert err.value.code == code, spec
    with pytest.raises(CodedValueError) as err:
        kit_tools.kit_save_tool("K", [{"segment_id": intro, "at": 1, "colour": "red"}])
    assert err.value.code == "kit_invalid"


def test_the_kit_tool_is_in_the_timebase_registry() -> None:
    from podcast_mcp.util.tool_timebase import TOOL_TIMEBASE

    assert TOOL_TIMEBASE["kit_save_tool"] == "timeline"
