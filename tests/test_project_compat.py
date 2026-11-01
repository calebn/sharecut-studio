from __future__ import annotations

import copy
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
compat = load_script("project_compat", register=True)
DEVELOPMENT = ROOT / compat.CORPUS / "development"


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(compat.dumps(value), encoding="utf-8")


def commit(root: Path) -> str:
    compat.git(root, "add", "-A", "--force")
    compat.git(
        root,
        "-c",
        "user.name=Guard test",
        "-c",
        "user.email=guard@example.test",
        "commit",
        "--quiet",
        "-m",
        "Synthetic guard input",
    )
    return compat.git(root, "rev-parse", "HEAD").decode().strip()


@pytest.fixture
def synthetic_repo(tmp_path: Path):
    root = tmp_path / "synthetic-policy-input"
    root.mkdir()
    compat.git(root, "init", "--quiet")
    write_json(root / compat.LOCK, compat.shape_lock())
    write_json(root / compat.LEDGER, {"releases": []})
    shutil.copytree(DEVELOPMENT, root / compat.CORPUS / "development")
    base = commit(root)
    return root, base


def capture_synthetic(root: Path, base: str):
    provenance = compat.ReleaseProvenance(
        id="synthetic-guard-input",
        project_version="2.0",
        build="SYNTHETIC guard test, never a product release",
        source_commit=base,
        captured_at="2026-10-18T00:00:00Z",
    )
    compat.freeze(root, root / compat.CORPUS / "development", provenance)
    return provenance.directory(root)


def unsupported_synthetic(directory: Path) -> None:
    project = compat.read_json(directory / compat.PROJECT)
    project["version"] = "1.0"
    write_json(directory / compat.PROJECT, project)


def test_committed_lock_and_complete_development_corpus() -> None:
    assert (ROOT / compat.LOCK).read_text(encoding="utf-8") == compat.dumps(compat.shape_lock())
    compat.read_ledger(ROOT)
    compat.assert_workspace(DEVELOPMENT / compat.PROJECT)


PROJECT_ONLY_FIXTURES = sorted(
    p
    for p in (ROOT / "tests/fixtures").rglob("episode.sharecut")
    if compat.CORPUS not in p.relative_to(ROOT).parents
)


@pytest.mark.parametrize(
    "path", PROJECT_ONLY_FIXTURES, ids=lambda p: str(p.parent.relative_to(ROOT))
)
def test_existing_development_project_only_roundtrip(path: Path) -> None:
    compat.assert_project_roundtrip(path, project_only=True)


def test_prerelease_lock_refresh_and_missing_base(synthetic_repo, monkeypatch) -> None:
    root, base = synthetic_repo
    changed = copy.deepcopy(compat.shape_lock())
    changed["schemas"]["validation"]["$defs"]["Track"]["properties"]["development_field"] = {
        "type": "boolean"
    }
    monkeypatch.setattr(compat, "shape_lock", lambda: changed)
    with pytest.raises(ValueError, match="stale"):
        compat.check(root, base)
    assert "0 released fixtures" in compat.check(root, base, write_lock=True)
    with pytest.raises(ValueError, match="trusted Git base"):
        compat.check(root, "missing-base")


def test_initial_adoption_and_incomplete_base_fail_closed(synthetic_repo) -> None:
    root, _ = synthetic_repo
    (root / compat.LOCK).unlink()
    (root / compat.LEDGER).unlink()
    base = commit(root)
    write_json(root / compat.LOCK, compat.shape_lock())
    write_json(root / compat.LEDGER, {"releases": []})
    compat.check(root, base)
    (root / compat.LEDGER).unlink()
    incomplete = commit(root)
    write_json(root / compat.LEDGER, {"releases": []})
    with pytest.raises(ValueError, match="incomplete"):
        compat.check(root, incomplete)


@pytest.mark.parametrize("harmless_paths", [False, True])
def test_release_capture_preserves_bytes_and_producer(synthetic_repo, harmless_paths) -> None:
    root, base = synthetic_repo
    if harmless_paths:
        (root / ".git/info/exclude").write_text("__pycache__/\n", encoding="utf-8")
        bytecode = root / "src/__pycache__/producer.cpython-313.pyc"
        bytecode.parent.mkdir(parents=True)
        bytecode.write_bytes(b"synthetic ignored bytecode")
        (root / "capture-notes.txt").write_text("Synthetic capture notes\n", encoding="utf-8")
    source = root / compat.CORPUS / "development"
    before = compat.inventory(source)
    destination = capture_synthetic(root, base)
    frozen = compat.inventory(destination)
    expected = {
        name: digest
        for name, digest in before.items()
        if name == compat.PROJECT or name.startswith(("raw/", "history/"))
    }
    assert {
        name: digest for name, digest in frozen.items() if name != "shape.lock.json"
    } == expected
    assert compat.inventory(source) == before
    assert compat.check_policy(root, base, compat.shape_lock()).releases[0].source_commit == base
    release = compat.read_ledger(root).releases[0]
    wrong_producer = release.model_copy(update={"source_commit": "0" * 40, "id": "wrong-checkout"})
    with pytest.raises(ValueError, match="checkout that produced"):
        compat.freeze(root, source, wrong_producer)
    assert not wrong_producer.directory(root).exists()


@pytest.mark.parametrize(
    "sabotage",
    [
        "clear-ledger",
        "rewrite-metadata",
        "delete-byte",
        "extra-byte",
        "rewrite-byte",
        "refresh-lock",
        "first-freeze-race",
    ],
)
def test_release_policy_rejects_accidental_bypasses(synthetic_repo, sabotage, monkeypatch) -> None:
    root, base = synthetic_repo
    destination = capture_synthetic(root, base)
    released_base = commit(root)
    candidate = compat.shape_lock()
    if sabotage in {"clear-ledger", "rewrite-metadata"}:
        ledger = compat.read_json(root / compat.LEDGER)
        if sabotage == "clear-ledger":
            ledger["releases"] = []
            shutil.rmtree(destination)
        else:
            ledger["releases"][0]["build"] = "rewritten"
        write_json(root / compat.LEDGER, ledger)
    elif sabotage == "delete-byte":
        (destination / "raw/stub.wav").unlink()
    elif sabotage == "extra-byte":
        (destination / "unlisted.txt").write_text("extra", encoding="utf-8")
    elif sabotage == "rewrite-byte":
        (destination / "raw/stub.wav").write_bytes(b"replaced")
    else:
        candidate = copy.deepcopy(candidate)
        candidate["schemas"]["serialization"]["$defs"]["Track"]["properties"]["muted"][
            "default"
        ] = True
        monkeypatch.setattr(compat, "shape_lock", lambda: candidate)
        if sabotage == "first-freeze-race":
            released_base = base
        write_json(root / compat.LOCK, candidate)
    with pytest.raises(ValueError):
        compat.check_policy(root, released_base, candidate)
    if sabotage == "refresh-lock":
        with pytest.raises(ValueError):
            compat.check(root, released_base, write_lock=True)


def test_snapshot_nested_change_requires_version_bump(synthetic_repo) -> None:
    root, base = synthetic_repo
    capture_synthetic(root, base)
    released_base = commit(root)
    changed = copy.deepcopy(compat.shape_lock())
    changed["schemas"]["validation"]["$defs"]["SnapshotMeta"]["properties"]["new_field"] = {
        "type": "string"
    }
    with pytest.raises(ValueError, match="bump the project version"):
        compat.check_policy(root, released_base, changed)
    changed["project_version"] = "3.0"
    compat.check_policy(root, released_base, changed)


def test_version_only_bump_demands_real_upgrade_cli(synthetic_repo) -> None:
    root, base = synthetic_repo
    destination = capture_synthetic(root, base)
    unsupported_synthetic(destination)
    old_lock = compat.read_json(destination / "shape.lock.json")
    old_lock["project_version"] = "1.0"
    write_json(destination / "shape.lock.json", old_lock)
    write_json(root / compat.LOCK, old_lock)
    ledger = compat.read_json(root / compat.LEDGER)
    ledger["releases"][0]["project_version"] = "1.0"
    ledger["releases"][0]["files"] = compat.inventory(destination)
    write_json(root / compat.LEDGER, ledger)
    released_base = commit(root)
    write_json(root / compat.LOCK, compat.shape_lock())
    with pytest.raises(ValueError, match="executable episode upgrade CLI"):
        compat.check(root, released_base)


@pytest.mark.parametrize(
    "sabotage",
    [
        "redo-missing",
        "redo-corrupt",
        "retained-corrupt",
        "index-disagrees",
        "current-disagrees",
        "render-marker",
        "populated-field",
        "explicit-null",
        "snapshot-symlink",
    ],
)
def test_complete_workspace_refuses_data_loss(tmp_path: Path, sabotage) -> None:
    workspace = tmp_path / "development-copy"
    shutil.copytree(DEVELOPMENT, workspace)
    path = workspace / compat.PROJECT
    project = compat.read_json(path)
    entries = project["history"]["entries"]
    redo = workspace / entries[-1]["snapshot_file"]
    if sabotage == "redo-missing":
        redo.unlink()
    elif sabotage in {"redo-corrupt", "retained-corrupt"}:
        target = (
            redo
            if sabotage == "redo-corrupt"
            else workspace / "history/snapshots/retained-development.json"
        )
        payload = compat.read_json(target)
        payload["timeline"]["tracks"][0]["gain_db"] = "not-a-number"
        write_json(target, payload)
    elif sabotage == "index-disagrees":
        history = compat.read_json(workspace / "history/index.json")
        history["cursor"] = 0
        write_json(workspace / "history/index.json", history)
    elif sabotage in {"current-disagrees", "render-marker"}:
        if sabotage == "render-marker":
            project["render"]["last_completed_step"] = "wrong-marker"
        else:
            project["timeline"]["tracks"][0]["label"] = "wrong-label"
        write_json(path, project)
    elif sabotage in {"populated-field", "explicit-null"}:
        project["timeline"]["tracks"][0]["unknown_persisted_value"] = (
            "must survive" if sabotage == "populated-field" else None
        )
        write_json(path, project)
    else:
        redo.unlink()
        redo.symlink_to(DEVELOPMENT / entries[-1]["snapshot_file"])
    with pytest.raises(ValueError):
        compat.assert_workspace(path)


def test_snapshot_extractor_coverage(monkeypatch) -> None:
    original = compat.snapshot_editable_state
    monkeypatch.setattr(
        compat, "snapshot_editable_state", lambda project: {**original(project), "uncovered": {}}
    )
    with pytest.raises(ValueError, match="extractor and model fields differ"):
        compat.shape_lock()


@pytest.mark.parametrize(
    "failure",
    [
        "missing-output",
        "nonzero",
        "source-write",
        "dropped-history",
        "dropped-retained",
        "changed-media",
        "changed-metadata",
        "valid-output",
    ],
)
def test_upgrade_requires_complete_output_and_untouched_source(
    tmp_path: Path, monkeypatch, failure
) -> None:
    old = tmp_path / "synthetic-old-input"
    shutil.copytree(DEVELOPMENT, old)
    unsupported_synthetic(old)
    calls = []

    def fake_cli(command, **kwargs):
        calls.append(command)
        source = Path(command[command.index("--project") + 1])
        output = Path(command[command.index("--output") + 1])
        if failure == "nonzero":
            return SimpleNamespace(returncode=2, stderr="upgrade failed")
        if failure != "missing-output":
            shutil.copytree(DEVELOPMENT, output)
            project = compat.load_project(output / compat.PROJECT)
            if failure == "source-write":
                source.write_text("modified", encoding="utf-8")
            elif failure == "dropped-history":
                from podcast_mcp.project.history.manager import HistoryManager
                from podcast_mcp.project.store import ProjectStore

                HistoryManager(ProjectStore(output / compat.PROJECT)).goto(project, 0)
                project.history.entries = project.history.entries[:1]
                write_json(output / "history/index.json", project.history.model_dump(mode="json"))
                ProjectStore(output / compat.PROJECT).commit(project)
            elif failure == "dropped-retained":
                (output / "history/snapshots/retained-development.json").unlink()
            elif failure == "changed-media":
                (output / "raw/stub.wav").write_bytes(b"changed")
            elif failure == "changed-metadata":
                project.history.entries[0].label = "replaced label"
                compat.save_project(project, output / compat.PROJECT)
                write_json(output / "history/index.json", project.history.model_dump(mode="json"))
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(compat.subprocess, "run", fake_cli)
    if failure == "valid-output":
        compat.assert_upgrade(old)
    else:
        with pytest.raises(ValueError):
            compat.assert_upgrade(old)
    assert len(calls) == 1
    assert calls[0][:7] == [
        sys.executable,
        "-m",
        "podcast_mcp.cli.main",
        "--no-progress",
        "episode",
        "upgrade",
        "--project",
    ]
    assert compat.read_json(old / compat.PROJECT)["version"] == "1.0"


@pytest.mark.parametrize("failure", ["copy", "ledger"])
def test_capture_failure_does_not_publish_partial_fixture(
    synthetic_repo, monkeypatch, failure
) -> None:
    root, base = synthetic_repo
    original = compat.shutil.copyfile

    def fail_on_lock(source, destination, **kwargs):
        if Path(source).name == compat.LOCK.name:
            raise OSError("synthetic copy failure")
        return original(source, destination, **kwargs)

    if failure == "copy":
        monkeypatch.setattr(compat.shutil, "copyfile", fail_on_lock)
    else:

        def fail_ledger(*args, **kwargs):
            raise OSError("synthetic ledger failure")

        monkeypatch.setattr(compat, "write_text_atomic", fail_ledger)
    with pytest.raises(OSError, match="failure"):
        capture_synthetic(root, base)
    assert compat.read_ledger(root).releases == []
    assert not (root / compat.CORPUS / "released/synthetic-guard-input").exists()


def test_every_pr_runs_compatibility_outside_pytest_scope() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
    assert "if" not in workflow["jobs"]["pytest"]
    steps = workflow["jobs"]["pytest"]["steps"]
    guard = next(step for step in steps if step.get("name") == "Project and history compatibility")
    assert "if" not in guard
    assert "scripts/project_compat.py check --base" in guard["run"]
    assert "tests/test_project_compat.py" in guard["run"]
    assert (
        guard["env"]["COMPAT_BASE"]
        == "${{ inputs.compatibility-base || github.event.pull_request.base.sha || github.event.before || github.sha }}"
    )
    identity = next(
        step for step in steps if step.get("name") == "Verify final release integration identity"
    )
    assert (
        identity["if"]
        == "github.event_name == 'workflow_dispatch' && inputs.compatibility-base != ''"
    )
    assert steps.index(identity) < steps.index(guard)
    scoped = [step for step in steps if "steps.plan.outputs.pytest" in step.get("if", "")]
    assert all(steps.index(guard) < steps.index(step) for step in scoped)


def test_schema_normalization_preserves_persisted_names_and_defaults() -> None:
    schema = {
        "description": "Presentation text",
        "properties": {
            "description": {"type": "string", "description": "Field help", "default": "saved text"},
            "config": {
                "type": "object",
                "default": {"title": "saved title", "description": "saved description"},
            },
        },
    }
    assert compat.structural_schema(schema) == {
        "properties": {
            "description": {"type": "string", "default": "saved text"},
            "config": {
                "type": "object",
                "default": {"title": "saved title", "description": "saved description"},
            },
        }
    }


def test_release_metadata_cannot_claim_an_upgrade(synthetic_repo) -> None:
    root, base = synthetic_repo
    capture_synthetic(root, base)
    ledger = compat.read_json(root / compat.LEDGER)
    ledger["releases"][0]["upgrade_tested"] = True
    write_json(root / compat.LEDGER, ledger)
    with pytest.raises(ValueError):
        compat.check(root, base)


@pytest.mark.parametrize("dirty_source", ["tracked", "untracked"])
def test_capture_rejects_a_dirty_producer(synthetic_repo, dirty_source) -> None:
    root, _ = synthetic_repo
    runtime = root / "src/producer.py"
    runtime.parent.mkdir()
    runtime.write_text("version = 'committed'\n", encoding="utf-8")
    producer = commit(root)
    if dirty_source == "untracked":
        runtime = root / "src/untracked_producer.py"
    runtime.write_text("version = 'dirty'\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unchanged producer runtime"):
        capture_synthetic(root, producer)
    assert compat.read_ledger(root).releases == []
