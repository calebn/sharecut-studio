#!/usr/bin/env python3
"""Lock persisted shapes, replay complete fixtures, and enforce the release boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, get_args

from pydantic import BaseModel, ConfigDict, Field, create_model

from podcast_mcp.models import EpisodeProject, load_project, save_project
from podcast_mcp.models.episode import ProjectMeta, RenderSection
from podcast_mcp.models.history import ProjectHistory, ProjectStateSnapshot
from podcast_mcp.models.project_format import SUPPORTED_PROJECT_VERSION, snapshot_editable_state
from podcast_mcp.project.history.manager import HistoryManager, apply_snapshot_to_project
from podcast_mcp.project.store import read_history_snapshot, snapshot_from_project
from podcast_mcp.util.atomic_json import write_text_atomic

ROOT = Path(__file__).resolve().parents[1]
LOCK = Path("schemas/episode.project.shape.lock.json")
CORPUS = Path("tests/fixtures/project_compat")
LEDGER = CORPUS / "releases.json"
PROJECT = "episode.project.json"


class ReleaseProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]*$")
    project_version: str
    build: str = Field(min_length=1)
    source_commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    captured_at: str = Field(min_length=1)

    def directory(self, root: Path) -> Path:
        return root / CORPUS / "released" / self.id


class CapturedRelease(ReleaseProvenance):
    files: dict[str, str] = Field(min_length=1)


class ReleaseLedger(BaseModel):
    model_config = ConfigDict(extra="forbid")

    releases: list[CapturedRelease] = Field(default_factory=list)


def dumps(data: Any) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def snapshot_model() -> type[BaseModel]:
    fields = {}
    for name in ProjectStateSnapshot.model_fields:
        if name == "meta":
            meta = create_model(
                "SnapshotMeta",
                name=(ProjectMeta.model_fields["name"].annotation, None),
                ingest_alignment=(ProjectMeta.model_fields["ingest_alignment"].annotation, None),
            )
            fields[name] = (meta | None, None)
        elif name == "render_last_completed_step":
            fields[name] = (RenderSection.model_fields["last_completed_step"].annotation, None)
        else:
            attr = "transcript_data" if name == "transcripts" else name
            field = EpisodeProject.model_fields[attr]
            fields[name] = (field.annotation, field)
    model = create_model("ConcreteEditableSnapshot", **fields)
    actual = snapshot_editable_state(EpisodeProject.create("shape-check", "."))
    require(set(actual) == set(model.model_fields), "Snapshot extractor and model fields differ")
    return model


def structural_schema(schema: dict[str, Any]) -> dict[str, Any]:
    result = {}
    for key, value in schema.items():
        if key in {"title", "description", "examples", "$comment"}:
            continue
        if key in {"properties", "$defs", "patternProperties", "dependentSchemas"}:
            value = {name: structural_schema(child) for name, child in value.items()}
        elif key in {"allOf", "anyOf", "oneOf", "prefixItems"}:
            value = [structural_schema(child) for child in value]
        elif key in {
            "items",
            "additionalProperties",
            "contains",
            "not",
            "if",
            "then",
            "else",
            "propertyNames",
        } and isinstance(value, dict):
            value = structural_schema(value)
        result[key] = value
    return result


def shape_lock() -> dict[str, Any]:
    require(
        EpisodeProject.model_fields["version"].default == SUPPORTED_PROJECT_VERSION,
        "EpisodeProject.version default differs from SUPPORTED_PROJECT_VERSION",
    )
    require(
        read_json(ROOT / "schemas/episode.project.schema.json")["properties"]["version"]["const"]
        == SUPPORTED_PROJECT_VERSION,
        "Public project schema version differs from SUPPORTED_PROJECT_VERSION",
    )
    models = {
        "project": EpisodeProject,
        "history": ProjectHistory,
        "snapshot": ProjectStateSnapshot,
        "snapshot_sections": snapshot_model(),
    }
    unknown_fields: dict[str, str] = {}

    def visit(annotation: Any) -> None:
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            if annotation.__name__ in unknown_fields:
                return
            unknown_fields[annotation.__name__] = annotation.model_config.get("extra") or "ignore"
            for field in annotation.model_fields.values():
                visit(field.annotation)
        for arg in get_args(annotation):
            visit(arg)

    for model in models.values():
        visit(model)
    bundle = create_model(
        "PersistedShapes", **{name: (model, ...) for name, model in models.items()}
    )
    return {
        "project_version": SUPPORTED_PROJECT_VERSION,
        "schemas": {
            mode: structural_schema(bundle.model_json_schema(mode=mode, by_alias=True))
            for mode in ("validation", "serialization")
        },
        "unknown_fields": unknown_fields,
    }


def assert_preserved(before: Any, after: Any, location: str = "project") -> None:
    """Compare raw fields before a model can discard or normalize input."""
    if before is None or before == {} or before == []:
        require(before == after, f"{location}: empty or null value changed")
        return
    if isinstance(before, dict):
        require(isinstance(after, dict), f"{location}: object lost")
        for key, value in before.items():
            require(key in after, f"{location}.{key}: field lost")
            assert_preserved(value, after[key], f"{location}.{key}")
    elif isinstance(before, list):
        require(isinstance(after, list) and len(before) == len(after), f"{location}: list changed")
        for index, value in enumerate(before):
            assert_preserved(value, after[index], f"{location}[{index}]")
    else:
        require(before == after, f"{location}: value changed ({before!r} != {after!r})")


def assert_project_roundtrip(path: Path, *, project_only: bool = False) -> None:
    raw = read_json(path)
    project = load_project(path)
    raw["meta"]["workspace_dir"] = "."
    if project_only and raw.get("history") is None:
        raw["history"] = project.history.model_dump(mode="json")
    with TemporaryDirectory() as temporary:
        saved = Path(temporary) / PROJECT
        save_project(project, saved)
        assert_preserved(raw, read_json(saved), str(path))
        require(
            load_project(saved).model_dump(exclude={"meta"})
            == project.model_dump(exclude={"meta"}),
            f"{path}: save/load changed project state",
        )


def assert_workspace(path: Path) -> None:
    """Validate original bytes before history adoption can repair their disagreement."""
    require(not path.is_symlink(), f"Corpus project is a symlink: {path}")
    inventory(path.parent / "history")
    require((path.parent / "raw").is_dir(), f"{path}: complete corpus requires raw/")
    inventory(path.parent / "raw")
    assert_project_roundtrip(path)
    project = load_project(path)
    media = [source.path for source in project.sources]
    media.extend(track.media.path for track in project.timeline.tracks if track.media is not None)
    for name in media:
        resolved = (path.parent / name).resolve()
        require(
            resolved.is_relative_to(path.parent.resolve()) and resolved.is_file(),
            f"Missing or external corpus media: {name}",
        )
    index = path.parent / "history/index.json"
    require(index.is_file(), f"{path}: complete corpus requires history/index.json")
    raw_index = read_json(index)
    history = ProjectHistory.model_validate(raw_index)
    assert_preserved(raw_index, history.model_dump(mode="json"), str(index))
    require(history == project.history, f"{path}: canonical history and index disagree")
    require(bool(history.entries), f"{path}: complete corpus requires nonempty history")
    require(0 <= history.cursor < len(history.entries), f"{path}: invalid history cursor")
    require(
        len({entry.id for entry in history.entries}) == len(history.entries),
        "Duplicate history ids",
    )
    snapshots = {
        p.relative_to(path.parent).as_posix(): p
        for p in (path.parent / "history/snapshots").rglob("*.json")
    }
    for entry in history.entries:
        require(entry.snapshot_file in snapshots, f"Missing indexed snapshot {entry.snapshot_file}")
    concrete = snapshot_model()
    for name, file in snapshots.items():
        raw = read_json(file)
        require(
            isinstance(raw, dict) and "timeline" in raw, f"{name}: snapshot is missing its timeline"
        )
        concrete.model_validate(raw)
        snapshot = ProjectStateSnapshot.model_validate(raw)
        assert_preserved(raw, snapshot.model_dump(mode="json"), name)
        fresh = project.model_copy(deep=True)
        apply_snapshot_to_project(fresh, snapshot)
        assert_preserved(raw, snapshot_from_project(fresh).model_dump(mode="json"), name)
        with TemporaryDirectory() as temporary:
            saved = Path(temporary) / PROJECT
            save_project(fresh, saved)
            assert_preserved(
                raw, snapshot_from_project(load_project(saved)).model_dump(mode="json"), name
            )
    current = read_history_snapshot(project, history.entries[history.cursor])
    require(
        current.model_dump(mode="json") == snapshot_from_project(project).model_dump(mode="json"),
        f"{path}: current snapshot and canonical state disagree, including render marker",
    )
    with TemporaryDirectory() as temporary:
        workspace = Path(temporary) / "workspace"
        shutil.copytree(path.parent, workspace)
        copied = workspace / PROJECT
        manager = HistoryManager(copied)
        replay = load_project(copied)

        def assert_cursor() -> None:
            expected = read_history_snapshot(replay, replay.history.entries[replay.history.cursor])
            require(
                snapshot_from_project(replay).model_dump(mode="json")
                == expected.model_dump(mode="json"),
                f"{path}: replay changed state at cursor {replay.history.cursor}",
            )
            require(
                load_project(copied).history == replay.history,
                f"{path}: replay did not save its history cursor",
            )
            assert_preserved(
                expected.model_dump(mode="json"),
                snapshot_from_project(load_project(copied)).model_dump(mode="json"),
                "saved replay",
            )

        for position in range(len(history.entries)):
            manager.goto(replay, position)
            assert_cursor()
        while replay.history.can_undo():
            manager.undo(replay)
            assert_cursor()
        while replay.history.can_redo():
            manager.redo(replay)
            assert_cursor()


def inventory(directory: Path) -> dict[str, str]:
    require(not directory.is_symlink(), f"Corpus directory is a symlink: {directory}")
    files = {}
    for path in sorted(directory.rglob("*")):
        require(not path.is_symlink(), f"Corpus path is a symlink: {path}")
        if path.is_file():
            files[path.relative_to(directory).as_posix()] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
    return files


def git(root: Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=False)
    require(
        result.returncode == 0, f"Cannot read trusted Git base: {result.stderr.decode().strip()}"
    )
    return result.stdout


def base_file(root: Path, base: str, path: Path) -> bytes | None:
    listing = git(root, "ls-tree", "--name-only", base, "--", path.as_posix())
    return git(root, "show", f"{base}:{path.as_posix()}") if listing.strip() else None


def read_ledger(root: Path) -> ReleaseLedger:
    ledger = ReleaseLedger.model_validate(read_json(root / LEDGER))
    ids = [release.id for release in ledger.releases]
    require(len(ids) == len(set(ids)), "Duplicate release ids")
    for release in ledger.releases:
        require(
            inventory(release.directory(root)) == release.files,
            f"Frozen inventory changed: {release.id}",
        )
        frozen = read_json(release.directory(root) / "shape.lock.json")
        require(
            frozen["project_version"] == release.project_version,
            f"Wrong frozen version: {release.id}",
        )
        if release.project_version == SUPPORTED_PROJECT_VERSION:
            require(
                frozen == shape_lock(),
                f"Released shape changed without a version bump: {release.id}",
            )
    directories = root / CORPUS / "released"
    require(
        {p.name for p in directories.iterdir()} == set(ids) if directories.exists() else not ids,
        "Released corpus differs from ledger",
    )
    return ledger


def check_policy(root: Path, base: str, candidate: dict[str, Any]) -> ReleaseLedger:
    base = git(root, "rev-parse", "--verify", f"{base}^{{commit}}").decode().strip()
    old_lock = base_file(root, base, LOCK)
    old_ledger = base_file(root, base, LEDGER)
    require(
        (old_lock is None) == (old_ledger is None),
        "Trusted base has incomplete compatibility policy",
    )
    ledger = read_ledger(root)
    if old_ledger is None:
        return ledger
    previous = ReleaseLedger.model_validate_json(old_ledger)
    require(
        ledger.releases[: len(previous.releases)] == previous.releases,
        "Released ledger entries were deleted or rewritten",
    )
    old = json.loads(old_lock)
    if previous.releases:
        changed = candidate != old
        if changed:
            require(
                version_key(candidate["project_version"]) > version_key(old["project_version"]),
                "Persisted shape changed after release; bump the project version and test a CLI upgrade",
            )
    for release in previous.releases:
        prefix = CORPUS / "released" / release.id
        listed = (
            git(root, "ls-tree", "-r", "--name-only", base, "--", prefix.as_posix())
            .decode()
            .splitlines()
        )
        require(
            {Path(name).relative_to(prefix).as_posix() for name in listed} == set(release.files),
            f"Trusted frozen inventory disagrees with ledger: {release.id}",
        )
        for name, digest in release.files.items():
            blob = git(root, "show", f"{base}:{prefix / name}")
            require(
                hashlib.sha256(blob).hexdigest() == digest,
                f"Trusted frozen bytes changed: {release.id}/{name}",
            )
    return ledger


def version_key(version: str) -> tuple[int, ...]:
    require(
        re.fullmatch(r"\d+(?:\.\d+)+", version) is not None, f"Invalid project version {version!r}"
    )
    return tuple(int(part) for part in version.split("."))


def assert_upgrade(directory: Path) -> None:
    """Require a real production CLI result whenever a released format is unsupported."""
    with TemporaryDirectory() as temporary:
        source = Path(temporary) / "source"
        shutil.copytree(directory, source)
        before = inventory(source)
        try:
            load_project(source / PROJECT)
        except ValueError as exc:
            require(
                "Unsupported episode.project.json version" in str(exc),
                "Old format failed for the wrong reason",
            )
        else:
            raise ValueError("Old released version is still accepted by ordinary runtime loading")
        output = Path(temporary) / "upgraded" / PROJECT
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "podcast_mcp.cli.main",
                "--no-progress",
                "episode",
                "upgrade",
                "--project",
                str(source / PROJECT),
                "--output",
                str(output.parent),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        require(
            result.returncode == 0,
            f"Released fixture requires executable episode upgrade CLI: {result.stderr}",
        )
        require(inventory(source) == before, "Upgrade modified the source fixture")
        require(output.is_file(), "Upgrade CLI produced no output project")
        assert_workspace(output)
        old_history = read_json(source / "history/index.json")
        new_history = read_json(output.parent / "history/index.json")
        assert_preserved(old_history, new_history, "upgraded history index")
        require(
            inventory(source / "raw") == inventory(output.parent / "raw"),
            "Upgrade changed source media bytes",
        )
        require(
            set(inventory(source / "history/snapshots"))
            == set(inventory(output.parent / "history/snapshots")),
            "Upgrade lost retained snapshots",
        )


def check(root: Path, base: str, *, write_lock: bool = False) -> str:
    candidate = shape_lock()
    ledger = check_policy(root, base, candidate)
    for release in ledger.releases:
        directory = release.directory(root)
        if release.project_version == SUPPORTED_PROJECT_VERSION:
            assert_workspace(directory / PROJECT)
        else:
            assert_upgrade(directory)
    development = root / CORPUS / "development" / PROJECT
    assert_workspace(development)
    if write_lock:
        (root / LOCK).write_text(dumps(candidate), encoding="utf-8")
    else:
        require(
            (root / LOCK).read_text(encoding="utf-8") == dumps(candidate),
            "Persisted shape lock is stale; run project_compat.py lock --base <ref>",
        )
    return (
        f"Compatibility guard passed. {len(ledger.releases)} released fixtures; development history replayed."
        + (" No released-format compatibility was tested." if not ledger.releases else "")
    )


def freeze(root: Path, source: Path, release: ReleaseProvenance) -> None:
    require(
        git(root, "rev-parse", "HEAD").decode().strip() == release.source_commit,
        "Capture must run in the checkout that produced the shipped build",
    )
    require(
        release.project_version == SUPPORTED_PROJECT_VERSION,
        "Capture version differs from producer runtime",
    )
    require(
        read_json(root / LOCK) == shape_lock(), "Refresh the producer shape lock before capture"
    )
    require(
        base_file(root, release.source_commit, LOCK) == (root / LOCK).read_bytes(),
        "Capture shape lock must be committed in the producer checkout",
    )
    require(
        not git(
            root,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            "src",
            "pyproject.toml",
            "uv.lock",
            "schemas/episode.project.schema.json",
        ).strip(),
        "Capture requires an unchanged producer runtime checkout",
    )
    assert_workspace(source / PROJECT)
    ledger = read_ledger(root)
    destination = release.directory(root)
    require(not destination.exists(), f"Capture already exists: {release.id}")
    require(
        not any(item.id == release.id for item in ledger.releases), "Capture id already in ledger"
    )
    for name in ("history", "raw"):
        require((source / name).is_dir(), f"Capture requires {name}/")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=destination.parent.parent) as temporary:
        staged = Path(temporary) / release.id
        staged.mkdir()
        shutil.copyfile(source / PROJECT, staged / PROJECT)
        for name in ("history", "raw"):
            shutil.copytree(source / name, staged / name)
        shutil.copyfile(root / LOCK, staged / "shape.lock.json")
        assert_workspace(staged / PROJECT)
        ledger.releases.append(CapturedRelease(**release.model_dump(), files=inventory(staged)))
        ledger_text = dumps(ledger.model_dump(mode="json"))
        staged.rename(destination)
        try:
            write_text_atomic(root / LEDGER, ledger_text)
        except OSError:
            if (root / LEDGER).read_text(encoding="utf-8") != ledger_text:
                shutil.rmtree(destination)
            raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "lock"):
        sub = commands.add_parser(command)
        sub.add_argument("--base", required=True, help="Trusted target-branch commit or ref")
    capture = commands.add_parser("freeze")
    capture.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Saved miniature workspace from the shipped build",
    )
    for name in ("id", "build", "source-commit", "captured-at"):
        capture.add_argument(f"--{name}", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "freeze":
            release = ReleaseProvenance(
                id=args.id,
                build=args.build,
                source_commit=args.source_commit,
                captured_at=args.captured_at,
                project_version=SUPPORTED_PROJECT_VERSION,
            )
            freeze(ROOT, args.source.resolve(), release)
            print(
                f"Captured {release.id}. Review the bytes and ledger before delivering the build."
            )
        else:
            print(check(ROOT, args.base, write_lock=args.command == "lock"))
    except (ValueError, OSError, KeyError) as exc:
        print(f"Project compatibility guard failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
