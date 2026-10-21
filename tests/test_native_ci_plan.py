from __future__ import annotations

import ast
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

cp = load_script("ci_plan", register=True)
native = sys.modules["ci_native"]
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    "paths,families",
    [
        (["docs/testing.md"], set()),
        (["gui/web/src/App.tsx"], {"web"}),
        (["gui/desktop/src-tauri/src/main.rs"], {"cargo"}),
        (["src/podcast_mcp/edits/tighten/propose.py"], {"pinned", "resolver", "lock", "registry"}),
        (
            ["src/podcast_mcp/config/distribution.py"],
            {"cargo", "pinned", "resolver", "lock", "registry"},
        ),
        (["scripts/build_sidecar.py"], {"cargo", "payload", "lock", "registry"}),
        (["contracts/ffmpeg-artifacts.json"], {"payload", "lock", "registry"}),
        (["contracts/test-wait-allowlist.json"], set()),
        (["contracts/test-wait-allowlist.json", "gui/web/src/App.tsx"], {"web"}),
        (["contracts/trim-edge-limits.json"], {"pinned", "resolver", "lock", "registry"}),
    ],
)
def test_pr_selection_unions_every_consumer(paths, families) -> None:
    result = cp.plan("pull_request", paths)
    assert {family.value for family in result.native.required} == families
    assert {
        key
        for key, value in result.outputs().items()
        if key.startswith("skip-native-") and value == "0"
    } == {f"skip-native-{family}" for family in families}


@pytest.mark.parametrize(
    "path",
    [
        "new/source.py",
        "contracts/new.json",
        "scripts/ci_native.py",
        "tests/test_native_ci_plan.py",
        "",
        "/docs/test.md",
        "./docs/test.md",
        "docs/../test.md",
        "docs//test.md",
        "docs/test\nsource.py",
        "docs/test\r.md",
        "docs/evil\x00.md",
        "docs\\test.md",
    ],
)
def test_unknown_or_malformed_paths_run_every_native_family(path) -> None:
    assert cp.plan("pull_request", [path]).native.required == native.ALL_NATIVE


@pytest.mark.parametrize("event", ["push", "schedule", "workflow_dispatch", "unknown"])
def test_full_events_override_every_pr_skip(event) -> None:
    proof = cp.ReleaseProof("base", "head", "0.1.2")
    assert cp.plan(event, ["docs/testing.md"], release=proof).native.required == native.ALL_NATIVE


def test_empty_or_failed_planning_runs_every_family_and_release_proof_skips() -> None:
    assert cp.plan("pull_request", []).native.required == native.ALL_NATIVE
    assert (
        cp.plan(
            "pull_request", ["docs/testing.md"], release=cp.FullRelease("unreadable")
        ).native.required
        == native.ALL_NATIVE
    )
    assert not cp.plan(
        "pull_request", ["docs/testing.md"], release=cp.ReleaseProof("base", "head", "0.1.2")
    ).native.required


def test_unreadable_diff_emits_full_native_outputs(monkeypatch, capsys) -> None:
    def fail(*args):
        raise OSError("unreadable diff")

    monkeypatch.setattr(cp, "changed_files", fail)
    assert cp.main(["plan", "--event", "pull_request", "--base", "base", "--head", "head"]) == 0
    outputs = dict(line.split("=", 1) for line in capsys.readouterr().out.splitlines())
    assert all(outputs[f"skip-native-{family.value}"] == "0" for family in native.NativeFamily)


def test_git_diff_preserves_newline_names_and_both_rename_directions(tmp_path) -> None:
    def git(*args):
        return subprocess.run(["git", "-C", str(tmp_path), *args], check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "ci@example.com")
    git("config", "user.name", "CI")
    (tmp_path / "contracts").mkdir()
    (tmp_path / "contracts/test-wait-allowlist.json").write_text("{}")
    (tmp_path / "deleted.py").write_text("old")
    git("add", "-A")
    git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD").stdout.decode().strip()
    (tmp_path / "contracts/test-wait-allowlist.json").rename(tmp_path / "contracts/new.json")
    (tmp_path / "deleted.py").unlink()
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs/line\nsource.py").write_text("new")
    git("add", "-A")
    git("commit", "-qm", "head")
    changed = cp.changed_files(base, "HEAD", tmp_path)
    assert set(changed) == {
        "contracts/test-wait-allowlist.json",
        "contracts/new.json",
        "deleted.py",
        "docs/line\nsource.py",
    }
    assert cp.plan("pull_request", changed).native.required == native.ALL_NATIVE


def test_workflow_inventory_forwarding_roots_and_predicates_match_policy() -> None:
    action = load_github_yaml(ROOT / ".github/actions/ci-plan/action.yml")
    assert set(action["outputs"]) == set(cp.plan("push", []).outputs())
    for name, output in action["outputs"].items():
        assert output["value"] == f"${{{{ steps.plan.outputs.{name} }}}}"
    for name in {workload.workflow for workload in native.NATIVE_WORKLOADS}:
        workflow = load_github_yaml(ROOT / ".github/workflows" / name)
        workloads = [workload for workload in native.NATIVE_WORKLOADS if workload.workflow == name]
        assert set(workflow["jobs"]) == {"changes", *(workload.job for workload in workloads)}
        changes = workflow["jobs"]["changes"]
        assert changes["if"] == "github.event_name == 'pull_request'"
        assert changes["steps"][0]["with"]["fetch-depth"] == 0
        assert changes["steps"][1]["uses"] == "./.github/actions/ci-plan"
        assert changes["outputs"] == {
            f"skip-native-{workload.family.value}": f"${{{{ steps.plan.outputs.skip-native-{workload.family.value} }}}}"
            for workload in workloads
        }
        for workload in workloads:
            job = workflow["jobs"][workload.job]
            expected_needs = ["changes", *workload.prerequisites]
            assert (
                job["needs"] if isinstance(job["needs"], list) else [job["needs"]]
            ) == expected_needs
            predicate = f"(needs.changes.result != 'success' || needs.changes.outputs.skip-native-{workload.family.value} != '1')"
            if workload.prerequisites:
                predicate = (
                    "("
                    + predicate
                    + "".join(
                        f" && needs.{dep}.result == 'success'" for dep in workload.prerequisites
                    )
                    + ")"
                )
            assert job["if"] == f"${{{{ !cancelled() && {predicate} }}}}"
            commands = "\n".join(step.get("run", "") for step in job["steps"])
            assert set(re.findall(r"tests/[\w/]+\.py", commands)) == set(workload.test_roots)
            assert all(command in commands for command in workload.command_roots)


def test_full_event_coverage_and_single_exact_desktop_exclusion() -> None:
    assert native.DESKTOP_PR_EXCLUSIONS == ("contracts/test-wait-allowlist.json",)
    assert native.DESKTOP_PR_PATHS == ("**", "!contracts/test-wait-allowlist.json")
    for path in native.DESKTOP_PR_EXCLUSIONS:
        assert not native.select_native([path]).required
    for name in ("desktop.yml", "registry-backup-windows.yml"):
        events = load_github_yaml(ROOT / ".github/workflows" / name)["on"]
        assert events["push"] == {"branches": ["main"]}
        assert events["schedule"] and "workflow_dispatch" in events
        if name == "desktop.yml":
            assert events["pull_request"] == {"paths": list(native.DESKTOP_PR_PATHS)}
        else:
            assert events["pull_request"] == {"branches": ["main"]}


def test_actual_predicates_case_fold_outputs_and_preserve_payload_producer_success() -> None:
    jobs = [
        load_github_yaml(ROOT / ".github/workflows" / workload.workflow)["jobs"][workload.job]
        for workload in native.NATIVE_WORKLOADS
    ]
    script = r"""
const jobs = JSON.parse(process.argv[1]);
for (const job of jobs) {
  const deps = Array.isArray(job.needs) ? job.needs : [job.needs];
  const expr = job.if.slice(3, -2).replace(/\.([\w]+(?:-[\w]+)+)/g, "['$1']");
  const evaluate = Function('needs', 'cancelled', `return (${expr});`);
  const key = job.if.match(/outputs\.(skip-native-[\w-]+)/)[1];
  for (const result of ['success', 'failure', 'skipped', 'cancelled']) {
    for (const flag of ['1', '0', '01', '1.0', ' 1 ', 'true', 'false', '', 'TRUE', 'garbled', undefined, null]) {
      for (const cancelled of [true, false]) {
        const needs = Object.fromEntries(deps.map(dep => [dep, {result: 'success'}]));
        needs.changes = {result, outputs: {[key]: typeof flag === 'string' ? flag.toLowerCase() : flag}};
        const expected = !cancelled && (result !== 'success' || flag !== '1');
        if (evaluate(needs, () => cancelled) !== expected) throw Error(JSON.stringify({job, result, flag, cancelled}));
        for (const dep of deps.filter(dep => dep !== 'changes')) {
          for (const state of ['failure', 'skipped', 'cancelled']) {
            needs[dep].result = state;
            if (evaluate(needs, () => cancelled)) throw Error('failed payload producer');
          }
        }
      }
    }
  }
}
"""
    subprocess.run(["node", "-e", script, json.dumps(jobs)], check=True, capture_output=True)


def test_contract_inventory_is_explicit_and_unknown_additions_run_full() -> None:
    assert set(native.NATIVE_CONTRACTS) == {
        path.name for path in (ROOT / "contracts").glob("*.json")
    }
    assert {name for name, consumers in native.NATIVE_CONTRACTS.items() if consumers} == {
        "bootstrap-assets.json",
        "ffmpeg-artifacts.json",
        "ffmpeg-build.json",
        "join-length-limits.json",
        "ripple-scope.json",
        "timeline-zoom.json",
        "trim-edge-limits.json",
    }
    assert not native.select_native(native.DESKTOP_PR_EXCLUSIONS).required
    for paths in (
        ["contracts/added.json"],
        ["contracts/test-wait-allowlist.json", "contracts/renamed.json"],
    ):
        assert native.select_native(paths).required == native.ALL_NATIVE


def test_native_contract_readers_and_dynamic_manifest_are_classified() -> None:
    found = set()
    for path in (ROOT / "src").rglob("*.py"):
        tree = ast.parse(path.read_text())
        constants = {
            node.targets[0].id: node.value.value
            for node in tree.body
            if isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Constant)
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            function = (
                node.func.id
                if isinstance(node.func, ast.Name)
                else node.func.attr
                if isinstance(node.func, ast.Attribute)
                else None
            )
            if function not in {"load_contract", "contract_constant"}:
                continue
            if path.name == "contracts.py":
                assert isinstance(node.args[0], ast.Name) and node.args[0].id == "name"
                continue
            arg = node.args[0]
            name = (
                arg.value
                if isinstance(arg, ast.Constant)
                else constants.get(arg.id)
                if isinstance(arg, ast.Name)
                else None
            )
            assert isinstance(name, str), f"classify unresolved contract reader in {path}"
            found.add(name)
            assert native.NATIVE_CONTRACTS[name] >= native.PYTHON_NATIVE
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and node.value in native.NATIVE_CONTRACTS:
                assert native.NATIVE_CONTRACTS[node.value] >= native.PYTHON_NATIVE, path
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value.startswith("contracts/")
                and node.value.endswith(".json")
            ):
                assert node.value.removeprefix("contracts/") in native.NATIVE_CONTRACTS
                assert native.NATIVE_CONTRACTS[node.value.removeprefix("contracts/")], path
    assert found == {
        "bootstrap-assets.json",
        "ffmpeg-build.json",
        "join-length-limits.json",
        "ripple-scope.json",
        "timeline-zoom.json",
        "trim-edge-limits.json",
    }
    payload = load_script("ffmpeg_payload", register=True)
    assert payload.CATALOG.relative_to(ROOT).as_posix() == "contracts/ffmpeg-artifacts.json"
    assert native.NATIVE_CONTRACTS[payload.CATALOG.name] >= native.PAYLOAD_NATIVE
    exporter = load_script("export_limit_contracts")
    assert {row[0] for row in exporter.EXPORTS} == {
        "trim-edge-limits.json",
        "join-length-limits.json",
        "ripple-scope.json",
    }
    assert native.select_native([exporter.OUT.relative_to(ROOT).as_posix()]).required == frozenset(
        (native.NativeFamily.WEB,)
    )


def _payload_imports(path: Path) -> set[Path]:
    tree = ast.parse(path.read_text())
    imports: list[tuple[str, tuple[str, ...]]] = []
    package = path.relative_to(ROOT / "src").parts[:-1] if path.is_relative_to(ROOT / "src") else ()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend((alias.name, ()) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                assert node.level <= len(package), f"unresolved relative import in {path}"
                prefix = package[: len(package) - node.level + 1]
                module = ".".join(
                    (*prefix, *((node.module or "").split(".") if node.module else ()))
                )
            else:
                module = node.module or ""
            imports.append((module, tuple(alias.name for alias in node.names)))
        elif isinstance(node, ast.Call):
            function = (
                node.func.id
                if isinstance(node.func, ast.Name)
                else node.func.attr
                if isinstance(node.func, ast.Attribute)
                else None
            )
            if function not in {
                "__import__",
                "import_module",
                "run_path",
                "spec_from_file_location",
            }:
                continue
            assert (
                node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ), f"classify dynamic import in {path}"
            assert function in {"__import__", "import_module"}, (
                f"classify path-based import in {path}"
            )
            module = node.args[0].value
            assert not module.startswith("."), f"classify dynamic relative import in {path}"
            imports.append((module, ()))
    sources = set()
    packages = {directory.name for directory in (ROOT / "src").iterdir() if directory.is_dir()}
    for module, names in imports:
        if module.partition(".")[0] not in packages:
            assert not (ROOT / "scripts" / f"{module}.py").is_file(), (
                f"classify local script import in {path}"
            )
            continue
        parts = module.split(".")
        source = ROOT / "src" / Path(*parts)
        candidates = (source.with_suffix(".py"), source / "__init__.py")
        existing = [candidate for candidate in candidates if candidate.is_file()]
        assert len(existing) == 1, f"unresolved local import {module} in {path}"
        sources.update(existing)
        sources.update(
            ROOT / "src" / Path(*parts[:end]) / "__init__.py" for end in range(1, len(parts))
        )
        owner = ast.parse(existing[0].read_text())
        exports = {
            node.name
            for node in owner.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        }
        for node in owner.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                exports.update(alias.asname or alias.name for alias in node.names)
            elif isinstance(node, ast.Assign):
                exports.update(target.id for target in node.targets if isinstance(target, ast.Name))
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                exports.add(node.target.id)
        for name in names:
            child = source / f"{name}.py"
            child_init = source / name / "__init__.py"
            if child.is_file() or child_init.is_file():
                sources.add(child if child.is_file() else child_init)
            else:
                assert name in exports, f"unresolved import {module}.{name} in {path}"
    assert all(source.is_file() for source in sources), path
    return sources


def test_payload_local_import_closure_remains_selected() -> None:
    pending = {ROOT / "scripts/ffmpeg_payload.py"}
    visited = set()
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        selected = native.select_native([path.relative_to(ROOT).as_posix()]).required
        assert selected >= native.PAYLOAD_NATIVE, path
        pending.update(_payload_imports(path))


def test_payload_guard_follows_relative_imports_and_package_initializers(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(sys.modules[__name__], "ROOT", tmp_path)
    sources = {
        "scripts/payload.py": "from podcast_mcp.util.foo import value\nfrom podcast_relay import value as relay_value\n",
        "src/podcast_mcp/__init__.py": "",
        "src/podcast_mcp/util/__init__.py": "",
        "src/podcast_mcp/util/foo.py": "from . import other\nvalue = other.value\n",
        "src/podcast_mcp/util/other.py": "value = 1\n",
        "src/podcast_relay/__init__.py": "value = 1\n",
    }
    for name, source in sources.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
    root_imports = _payload_imports(tmp_path / "scripts/payload.py")
    assert root_imports == {
        tmp_path / name
        for name in sources
        if name.startswith("src/") and not name.endswith("other.py")
    }
    assert tmp_path / "src/podcast_mcp/util/other.py" in _payload_imports(
        tmp_path / "src/podcast_mcp/util/foo.py"
    )
    assert (
        native.NativeFamily.PAYLOAD
        not in native.select_native(["src/podcast_mcp/util/foo.py"]).required
    )


@pytest.mark.parametrize(
    "source",
    [
        "from podcast_mcp.util.missing import value\n",
        "import importlib\nimportlib.import_module(target)\n",
        "__import__(target)\n",
        "from . import missing\n",
    ],
)
def test_payload_guard_rejects_unresolved_and_dynamic_imports(tmp_path, source) -> None:
    path = tmp_path / "payload.py"
    path.write_text(source)
    with pytest.raises(AssertionError):
        _payload_imports(path)


def test_workload_direct_sources_and_actions_select_their_consumers() -> None:
    for workload in native.NATIVE_WORKLOADS:
        job = load_github_yaml(ROOT / ".github/workflows" / workload.workflow)["jobs"][workload.job]
        for step in job["steps"]:
            paths = re.findall(r"scripts/[\w/]+\.(?:py|sh|rs|ps1)", step.get("run", ""))
            action = step.get("uses", "")
            if action.startswith("./"):
                paths.append(f"{action[2:]}/action.yml")
            for path in paths:
                assert workload.family in native.select_native([path]).required, (
                    workload.job,
                    path,
                )


@pytest.mark.parametrize(
    "paths,desktop,registry",
    [
        (["docs/testing.md"], 0, 0),
        (["gui/web/src/App.tsx"], 1, 0),
        (["src/podcast_mcp/edits/tighten/propose.py"], 4, 1),
        (["contracts/test-wait-allowlist.json"], 0, 0),
        (["contracts/ffmpeg-artifacts.json"], 6, 1),
        ([], 12, 1),
    ],
)
def test_projected_matrix_expansion_counts(paths, desktop, registry) -> None:
    selected = cp.plan("pull_request", paths).native.required
    counts = {"desktop.yml": 0, "registry-backup-windows.yml": 0}
    for workload in native.NATIVE_WORKLOADS:
        if workload.family not in selected:
            continue
        job = load_github_yaml(ROOT / ".github/workflows" / workload.workflow)["jobs"][workload.job]
        axes = job.get("strategy", {}).get("matrix", {})
        expansions = 1
        for values in axes.values():
            expansions *= len(values)
        counts[workload.workflow] += expansions
    assert counts == {"desktop.yml": desktop, "registry-backup-windows.yml": registry}
