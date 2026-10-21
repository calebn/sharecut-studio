from __future__ import annotations

import json
import os
import re
import subprocess
from itertools import product
from pathlib import Path

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

cp = load_script("ci_plan", register=True)
ROOT = Path(__file__).resolve().parents[1]
BRANCH = "release-please--branches--main--components--podcast-mcp"
REPOSITORY = "calebn/sharecut-studio"
FILES = {
    "pyproject.toml": '[project]\nname = "podcast-mcp"\nversion = "0.1.1"\n',
    "uv.lock": 'version = 1\n[[package]]\nname = "podcast-mcp"\nversion = "0.1.1"\nsource = { editable = "." }\n',
    "CHANGELOG.md": "old release\n",
    ".release-please-manifest.json": '{".": "0.1.1"}\n',
    "src/podcast_mcp/__init__.py": '"""Toolkit."""\n__version__ = "0.1.1"  # x-release-please-version\n',
    "gui/desktop/package.json": '{"name": "sharecut-desktop", "version": "0.1.1"}\n',
    "gui/desktop/package-lock.json": '{"name": "sharecut-desktop", "version": "0.1.1", "packages": {"": {"name": "sharecut-desktop", "version": "0.1.1"}}}\n',
    "gui/desktop/src-tauri/Cargo.toml": '[package]\nname = "sharecut"\nversion = "0.1.1"\n',
    "gui/desktop/src-tauri/Cargo.lock": 'version = 4\n[[package]]\nname = "sharecut"\nversion = "0.1.1"\n',
    "gui/desktop/src-tauri/tauri.conf.json": '{"version": "0.1.1"}\n',
}


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, text=True, capture_output=True
    ).stdout.strip()


def write(root: Path, path: str, text: str) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def commit(root: Path) -> str:
    git(root, "add", "-A")
    git(root, "commit", "-qm", "fixture")
    return git(root, "rev-parse", "HEAD")


@pytest.fixture
def release_repo(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "ci@example.com")
    git(tmp_path, "config", "user.name", "CI")
    for path, text in FILES.items():
        write(tmp_path, path, text)
    commit(tmp_path)
    git(tmp_path, "checkout", "-qb", BRANCH)
    for path, text in FILES.items():
        write(tmp_path, path, text.replace("0.1.1", "0.1.2"))
    write(tmp_path, "CHANGELOG.md", "arbitrary changelog content\n")
    commit(tmp_path)
    return tmp_path


def classify(root: Path, **overrides):
    metadata = {
        "base": "main",
        "head": "HEAD",
        "head_ref": BRANCH,
        "head_repository": REPOSITORY,
        "base_repository": REPOSITORY,
        "base_ref": "main",
        "root": root,
    }
    return cp.classify_release(**(metadata | overrides))


def assert_full(root: Path, **metadata) -> None:
    result = classify(root, **metadata)
    assert isinstance(result, cp.FullRelease)
    assert result.reason
    plan = cp.plan("pull_request", cp.changed_files("main", "HEAD", root), release=result)
    assert (plan.gui, plan.pytest, plan.release_only, len(plan.e2e)) == (True, "full", False, 6)


def test_all_ten_committed_files_prove_release(release_repo: Path) -> None:
    proof = classify(release_repo)
    assert isinstance(proof, cp.ReleaseProof)
    assert (proof.merge_base, proof.head, proof.version) == (
        git(release_repo, "rev-parse", "main"),
        git(release_repo, "rev-parse", "HEAD"),
        "0.1.2",
    )
    result = cp.plan("pull_request", list(FILES), release=proof)
    assert result.outputs() == {
        "gui": "false",
        "pytest": "release",
        "release-only": "1",
        "e2e-matrix": '{"include":[]}',
        **result.native.outputs(),
    }


def test_uses_blobs_despite_dirty_worktree(release_repo: Path) -> None:
    write(release_repo, "pyproject.toml", "broken worktree")
    assert isinstance(classify(release_repo), cp.ReleaseProof)


def test_base_movement_uses_merge_base(release_repo: Path) -> None:
    git(release_repo, "checkout", "-q", "main")
    write(release_repo, "README.md", "main moved\n")
    commit(release_repo)
    assert isinstance(classify(release_repo, head=BRANCH), cp.ReleaseProof)


@pytest.mark.parametrize(
    "field,value",
    [
        ("head_ref", None),
        ("head_ref", "release-please--other"),
        ("head_repository", None),
        ("base_repository", None),
        ("head_repository", "fork/sharecut-studio"),
        ("base_ref", None),
        ("base_ref", "other"),
        ("base", None),
        ("head", None),
    ],
)
def test_missing_or_wrong_metadata_is_full(release_repo: Path, field: str, value) -> None:
    assert_full(release_repo, **{field: value})


@pytest.mark.parametrize(
    "path,addition",
    [
        ("README.md", "extra path\n"),
        ("src/podcast_mcp/__init__.py", '\nraise RuntimeError("code")\n'),
        ("pyproject.toml", '\ndependencies = ["evil"]\n'),
        ("uv.lock", '\n[[package]]\nname = "dep"\nversion = "1.2.3"\n'),
        ("gui/desktop/src-tauri/Cargo.lock", '\nchecksum = "changed"\n'),
        ("gui/desktop/package.json", " "),
        ("pyproject.toml", "# new comment\n"),
    ],
)
def test_non_version_changes_are_full(release_repo: Path, path: str, addition: str) -> None:
    target = release_repo / path
    write(release_repo, path, (target.read_text() if target.exists() else "") + addition)
    commit(release_repo)
    assert_full(release_repo)


def test_same_string_dependency_version_cannot_change(release_repo: Path) -> None:
    path = "uv.lock"
    git(release_repo, "checkout", "-q", "main")
    addition = '\n[[package]]\nname = "dep"\nversion = "0.1.1"\n'
    write(release_repo, path, FILES[path] + addition)
    commit(release_repo)
    git(release_repo, "checkout", "-q", BRANCH)
    git(release_repo, "merge", "-q", "main", "--no-edit")
    text = (release_repo / path).read_text()
    write(
        release_repo,
        path,
        text.replace('name = "dep"\nversion = "0.1.1"', 'name = "dep"\nversion = "0.1.2"'),
    )
    commit(release_repo)
    assert_full(release_repo)


def test_unchanged_same_string_dependency_is_allowed(release_repo: Path) -> None:
    path = "uv.lock"
    addition = '\n[[package]]\nname = "dep"\nversion = "0.1.1"\n'
    git(release_repo, "checkout", "-q", "main")
    write(release_repo, path, FILES[path] + addition)
    commit(release_repo)
    git(release_repo, "checkout", "-q", BRANCH)
    git(release_repo, "merge", "-q", "main", "--no-edit")
    assert isinstance(classify(release_repo), cp.ReleaseProof)


@pytest.mark.parametrize(
    "path,text",
    [
        ("gui/desktop/package.json", '{"version": "0.1.2", "version": "0.1.2"}'),
        ("pyproject.toml", '[project]\nversion = "0.1.2"\nversion = "0.1.2"\n'),
        ("gui/desktop/package-lock.json", '{"version": "0.1.2", "packages": []}'),
        (
            "gui/desktop/src-tauri/Cargo.lock",
            '[[package]]\nname = "sharecut"\nversion = "0.1.2"\n[[package]]\nname = "sharecut"\nversion = "0.1.2"\n',
        ),
        (
            "uv.lock",
            '[[package]]\nname = "podcast-mcp"\nversion = "0.1.2"\nsource = { registry = "remote" }\n',
        ),
        ("src/podcast_mcp/__init__.py", '__version__ = "0.1.2"\n__version__ = "0.1.2"\n'),
        ("gui/desktop/src-tauri/tauri.conf.json", "{broken"),
    ],
)
def test_malformed_or_ambiguous_content_is_full(release_repo: Path, path: str, text: str) -> None:
    write(release_repo, path, text)
    commit(release_repo)
    assert_full(release_repo)


@pytest.mark.parametrize("version", ["1.0.0", "0.1.0", "0.1.2-beta.1", "0.1.02"])
def test_versions_require_increasing_plain_pre_one(release_repo: Path, version: str) -> None:
    for path in FILES:
        target = release_repo / path
        write(release_repo, path, target.read_text().replace("0.1.2", version))
    commit(release_repo)
    assert_full(release_repo)


def test_inconsistent_versions_are_full(release_repo: Path) -> None:
    write(release_repo, ".release-please-manifest.json", '{".": "0.1.3"}\n')
    commit(release_repo)
    assert_full(release_repo)


@pytest.mark.parametrize("change", ["delete", "rename", "mode", "symlink"])
def test_non_modified_regular_file_changes_are_full(release_repo: Path, change: str) -> None:
    target = release_repo / "CHANGELOG.md"
    if change == "mode":
        target.chmod(0o755)
    elif change == "rename":
        target.rename(release_repo / "renamed.md")
    else:
        target.unlink()
        if change == "symlink":
            target.symlink_to("pyproject.toml")
    commit(release_repo)
    assert_full(release_repo)


def test_empty_diff_is_full(release_repo: Path) -> None:
    assert isinstance(classify(release_repo, head="main"), cp.FullRelease)


def test_git_read_error_is_full(release_repo: Path) -> None:
    assert isinstance(classify(release_repo, head="missing-commit"), cp.FullRelease)


def test_read_error_after_diff_is_full(release_repo: Path, monkeypatch) -> None:
    original = cp._git

    def fail_blob(root, *args):
        if args[0] == "cat-file":
            raise OSError("cannot read blob")
        return original(root, *args)

    monkeypatch.setattr(cp, "_git", fail_blob)
    assert_full(release_repo)


def test_unverified_release_branch_gets_full_even_for_docs_only() -> None:
    result = cp.plan("pull_request", ["README.md"], head_ref=BRANCH)
    assert (result.gui, result.pytest, result.release_only) == (True, "full", False)


@pytest.mark.parametrize("event", ["push", "schedule", "workflow_dispatch"])
def test_non_pr_is_full_even_with_release_proof(release_repo: Path, event: str) -> None:
    result = cp.plan(event, list(FILES), release=classify(release_repo))
    assert (result.gui, result.pytest, result.release_only, len(result.e2e)) == (
        True,
        "full",
        False,
        6,
    )


def test_release_subset_is_explicit_and_nonempty() -> None:
    assert cp.subset_tests("release") == [
        "tests/test_ci_plan.py",
        "tests/test_release_ci_plan.py",
        "tests/test_version_policy.py",
    ]
    assert all((ROOT / path).is_file() for path in cp.subset_tests("release"))


def test_selector_locations_match_release_config_and_shipped_versions() -> None:
    config = json.loads((ROOT / "release-please-config.json").read_text())["packages"]["."]
    extras = config["extra-files"]
    expected = {entry if isinstance(entry, str) else entry["path"] for entry in extras}
    assert set(cp._RELEASE_FIELDS) == expected | {"pyproject.toml", ".release-please-manifest.json"}
    configured = {(entry["path"], entry["jsonpath"]) for entry in extras if isinstance(entry, dict)}
    represented = set()
    for path, selectors in cp._RELEASE_FIELDS.items():
        if path in {
            "pyproject.toml",
            ".release-please-manifest.json",
            "src/podcast_mcp/__init__.py",
        }:
            continue
        for selector in selectors:
            if len(selector) == 3 and selector[1].startswith("@"):
                jsonpath = f"$.package[?(@.name.value=='{selector[1][1:]}')].version"
            elif selector == ("packages", "", "version"):
                jsonpath = "$.packages[''].version"
            else:
                jsonpath = "$." + ".".join(selector)
            represented.add((path, jsonpath))
    assert represented == configured
    policy = load_script("version_policy")
    shipped = policy.versions()
    selected = {}
    for path in cp._RELEASE_FIELDS:
        _, values = cp._release_document(path, (ROOT / path).read_text())
        for index, value in enumerate(values):
            key = path if index == 0 else f'{path} packages[""]'
            selected[key] = value
    assert selected == shipped


def test_cli_emits_full_plan_when_diff_identity_is_missing(capsys) -> None:
    assert cp.main(["plan", "--event", "pull_request"]) == 0
    output = capsys.readouterr()
    assert "gui=true\n" in output.out
    assert "pytest=full\n" in output.out
    assert "release-only=0\n" in output.out
    assert "full fallback" in output.err


def test_cli_proves_release_with_all_identity_inputs(
    release_repo: Path, monkeypatch, capsys
) -> None:
    monkeypatch.chdir(release_repo)
    original_diff = cp.changed_files
    original_classify = cp.classify_release
    monkeypatch.setattr(
        cp, "changed_files", lambda base, head: original_diff(base, head, release_repo)
    )
    monkeypatch.setattr(
        cp,
        "classify_release",
        lambda *args, **kwargs: original_classify(*args, **kwargs, root=release_repo),
    )
    assert (
        cp.main(
            [
                "plan",
                "--event",
                "pull_request",
                "--base",
                "main",
                "--head",
                "HEAD",
                "--head-ref",
                BRANCH,
                "--head-repository",
                REPOSITORY,
                "--base-repository",
                REPOSITORY,
                "--base-ref",
                "main",
            ]
        )
        == 0
    )
    assert "release-only=1\n" in capsys.readouterr().out


def test_line_ending_changes_are_full(release_repo: Path) -> None:
    path = release_repo / "src/podcast_mcp/__init__.py"
    path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    commit(release_repo)
    assert_full(release_repo)


def test_version_edit_in_comment_is_full(release_repo: Path) -> None:
    path = "pyproject.toml"
    git(release_repo, "checkout", "-q", "main")
    write(release_repo, path, FILES[path] + "# version was 0.1.1\n")
    commit(release_repo)
    git(release_repo, "checkout", "-q", BRANCH)
    git(release_repo, "merge", "-q", "-s", "ours", "main", "--no-edit")
    write(release_repo, path, FILES[path].replace("0.1.1", "0.1.2") + "# version was 0.1.2\n")
    commit(release_repo)
    assert_full(release_repo)


@pytest.mark.parametrize(
    "before,after,count,expected",
    [
        ("0.1.10.1.1", "0.1.10.1.10", 1, True),
        ("0.1.10.1.1", "0.1.100.1.1", 1, True),
        ("0.1.10.1.1", "0.1.100.1.10", 2, True),
        ("0.1.10.1.1", "0.1.100.1.10", 1, False),
        ("0.1.1 / 0.1.10", "0.1.10 / 0.1.10", 1, True),
        ("0.1.1 / 0.1.10", "0.1.10 / 0.1.100", 1, False),
        ("0.1.1 / 0.1.10", "0.1.10 / 0.1.1", 1, False),
        ('"0.1.1" # 0.1.1\n', '"0.1.10" # 0.1.1\n', 1, True),
        ('"0.1.1" # 0.1.1\n', '"0.1.10" # 0.1.10\n', 1, False),
        ('"0.1.1"\n', "'0.1.10'\n", 1, False),
        ('"0.1.1"\n', '"0.1.10"\r\n', 1, False),
    ],
)
def test_version_text_preserves_exact_literals_and_change_count(
    before: str, after: str, count: int, expected: bool
) -> None:
    assert cp._version_text_only(before, after, "0.1.1", "0.1.10", count) is expected


@pytest.mark.parametrize("old,new", [("a", "aa"), ("aa", "a"), ("a", "b"), (".", "a")])
def test_version_text_matches_bounded_regex_oracle(old: str, new: str) -> None:
    texts = ["".join(chars) for size in range(5) for chars in product("ab.", repeat=size)]
    for before in (text for text in texts if len(text) < 4):
        expression = f"({re.escape(old)}|{re.escape(new)})".join(map(re.escape, before.split(old)))
        oracle = re.compile(expression)
        for after in texts:
            match = oracle.fullmatch(after)
            for count in range(4):
                expected = (
                    match is not None and sum(value == new for value in match.groups()) == count
                )
                assert cp._version_text_only(before, after, old, new, count) is expected, (
                    before,
                    after,
                    old,
                    new,
                    count,
                )


@pytest.mark.parametrize(
    "comment",
    ["# old 0.1.1, new 0.1.10\n", "# old 0.1.10, new 0.1.10\n", "# old 0.1.10, new 0.1.1\n"],
)
def test_prefix_release_preserves_version_tokens_in_comments(
    release_repo: Path, comment: str
) -> None:
    original_comment = "# old 0.1.1, new 0.1.10\n"
    git(release_repo, "checkout", "-q", "main")
    write(release_repo, "pyproject.toml", FILES["pyproject.toml"] + original_comment)
    commit(release_repo)
    git(release_repo, "checkout", "-q", BRANCH)
    git(release_repo, "merge", "-q", "-s", "ours", "main", "--no-edit")
    for path in FILES:
        write(release_repo, path, FILES[path].replace("0.1.1", "0.1.10"))
    write(release_repo, "CHANGELOG.md", "prefix release notes\n")
    target = release_repo / "pyproject.toml"
    write(release_repo, "pyproject.toml", target.read_text() + comment)
    commit(release_repo)
    if comment == original_comment:
        assert isinstance(classify(release_repo), cp.ReleaseProof)
    else:
        assert_full(release_repo)


def test_cli_diff_failure_emits_full_plan(monkeypatch, capsys) -> None:
    def fail(*args):
        raise subprocess.CalledProcessError(1, "git")

    monkeypatch.setattr(cp, "changed_files", fail)
    assert cp.main(["plan", "--event", "pull_request", "--base", "base", "--head", "head"]) == 0
    assert "release-only=0\n" in capsys.readouterr().out


def test_current_repository_files_prove_a_version_only_release(tmp_path: Path) -> None:
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "ci@example.com")
    git(tmp_path, "config", "user.name", "CI")
    policy = load_script("version_policy")
    old = policy.versions()["pyproject.toml"]
    major, minor, patch = map(int, old.split("."))
    new = f"{major}.{minor}.{patch + 1}"
    for path in FILES:
        write(tmp_path, path, (ROOT / path).read_text())
    commit(tmp_path)
    git(tmp_path, "checkout", "-qb", BRANCH)
    for path in FILES:
        target = tmp_path / path
        text = target.read_text()
        if path == "CHANGELOG.md":
            text = "release notes\n" + text
        elif path in {"uv.lock", "gui/desktop/src-tauri/Cargo.lock"}:
            name = "podcast-mcp" if path == "uv.lock" else "sharecut"
            text = text.replace(
                f'name = "{name}"\nversion = "{old}"', f'name = "{name}"\nversion = "{new}"', 1
            )
        elif path == ".release-please-manifest.json":
            text = text.replace(f'"{old}"', f'"{new}"', 1)
        elif path.endswith(".json"):
            count = 2 if path.endswith("package-lock.json") else 1
            text = text.replace(f'"version": "{old}"', f'"version": "{new}"', count)
        else:
            text = text.replace(f'"{old}"', f'"{new}"', 1)
        write(tmp_path, path, text)
    commit(tmp_path)
    result = classify(tmp_path)
    assert isinstance(result, cp.ReleaseProof)
    assert result.version == new


def test_ambiguous_merge_base_is_full(release_repo: Path) -> None:
    base = git(release_repo, "rev-parse", "main")
    tree = git(release_repo, "rev-parse", "HEAD^{tree}")
    left = git(release_repo, "commit-tree", tree, "-p", base, "-m", "left")
    right = git(release_repo, "commit-tree", tree, "-p", base, "-m", "right")
    first = git(release_repo, "commit-tree", tree, "-p", left, "-p", right, "-m", "first")
    second = git(release_repo, "commit-tree", tree, "-p", right, "-p", left, "-m", "second")
    result = classify(release_repo, base=first, head=second)
    assert isinstance(result, cp.FullRelease)
    assert "merge base" in result.reason


def test_shared_action_supplies_the_complete_pr_identity() -> None:
    action = load_github_yaml(ROOT / ".github/actions/ci-plan/action.yml")
    (step,) = action["runs"]["steps"]
    assert step["id"] == "plan"
    assert step["env"] == {
        "EVENT": "${{ github.event_name }}",
        "BASE_SHA": "${{ github.event.pull_request.base.sha }}",
        "HEAD_SHA": "${{ github.event.pull_request.head.sha }}",
        "HEAD_REF": "${{ github.event.pull_request.head.ref }}",
        "HEAD_REPOSITORY": "${{ github.event.pull_request.head.repo.full_name }}",
        "BASE_REPOSITORY": "${{ github.event.pull_request.base.repo.full_name }}",
        "BASE_REF": "${{ github.event.pull_request.base.ref }}",
    }
    for flag in (
        "event",
        "base",
        "head",
        "head-ref",
        "head-repository",
        "base-repository",
        "base-ref",
    ):
        assert f"--{flag} " in step["run"]
    assert set(action["outputs"]) == set(cp.plan("push", []).outputs())
    for name, value in action["outputs"].items():
        assert value["value"] == f"${{{{ steps.plan.outputs.{name} }}}}"


def test_advisory_release_guards_run_on_uncertainty_and_stop_on_cancellation() -> None:
    names = ("desktop", "extras-import", "registry-backup-windows")
    settings = {}
    for name in names:
        workflow = load_github_yaml(ROOT / ".github/workflows" / f"{name}.yml")
        selector = workflow["jobs"]["changes"]
        assert selector["if"] == "github.event_name == 'pull_request'"
        expected_outputs = (
            {"release-only": "${{ steps.plan.outputs.release-only }}"}
            if name == "extras-import"
            else {
                key: f"${{{{ steps.plan.outputs.{key} }}}}"
                for key in cp.plan("push", []).outputs()
                if key.startswith("skip-native-")
                and any(f"outputs.{key}" in job.get("if", "") for job in workflow["jobs"].values())
            }
        )
        assert selector["outputs"] == expected_outputs
        checkout, plan = selector["steps"]
        assert checkout["with"]["fetch-depth"] == 0
        assert plan["id"] == "plan" and plan["uses"] == "./.github/actions/ci-plan"
        for job_name, job in workflow["jobs"].items():
            if job_name != "changes":
                settings[f"{name}/{job_name}"] = job
    test = load_github_yaml(ROOT / ".github/workflows/test.yml")
    settings["test/pytest-python-floor"] = test["jobs"]["pytest-python-floor"]
    script = r"""
const jobs = JSON.parse(process.argv[1]);
for (const [label, job] of Object.entries(jobs)) {
  const dependencies = Array.isArray(job.needs) ? job.needs : [job.needs];
  if (!dependencies.includes('changes')) throw Error(label + ' lacks selector');
  const expression = job.if.slice(3, -2).replace(/\.([\w]+(?:-[\w]+)+)/g, "['$1']");
  const evaluate = Function('needs', 'cancelled', `return (${expression});`);
  for (const [result, flag, cancelled, expected] of [
    ['success', '1', false, false],
    ['success', '0', false, true],
    ['success', '', false, true],
    ['success', 'TRUE', false, true],
    ['success', 'true', false, true],
    ['success', '01', false, true],
    ['success', '1.0', false, true],
    ['success', ' 1 ', false, true],
    ['success', null, false, true],
    ['failure', '1', false, true],
    ['skipped', undefined, false, true],
    ['cancelled', undefined, true, false],
    ['success', '0', true, false],
  ]) {
    const needs = Object.fromEntries(dependencies.map(name => [name, {result: 'success'}]));
    const key = job.if.match(/outputs\.([\w-]+)/)[1];
    needs.changes = {result, outputs: {[key]: typeof flag === 'string' ? flag.toLowerCase() : flag}};
    if (evaluate(needs, () => cancelled) !== expected) {
      throw Error(JSON.stringify({label, result, flag, cancelled, expected}));
    }
    for (const dependency of dependencies.filter(name => name !== 'changes')) {
      needs[dependency].result = 'failure';
      if (evaluate(needs, () => cancelled) !== false) throw Error(label + ' ignores failed producer');
      needs[dependency].result = 'success';
    }
  }
}
"""
    subprocess.run(["node", "-e", script, json.dumps(settings)], check=True, capture_output=True)


def test_release_scope_keeps_policy_and_compatibility_checks() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
    steps = {step.get("name"): step for step in workflow["jobs"]["pytest"]["steps"]}
    release = steps["Run release policy and planner tests"]
    assert release["if"] == "steps.plan.outputs.pytest == 'release'"
    assert "python3 scripts/version_policy.py" in release["run"]
    assert "scripts/ci_plan.py subset-tests release" in release["run"]
    assert "--no-cov" in release["run"]
    compatibility = steps["Project and history compatibility"]
    assert "if" not in compatibility
    assert "inputs.compatibility-base" in compatibility["env"]["COMPAT_BASE"]
    guard = steps["Verify final release integration identity"]
    assert (
        guard["if"] == "github.event_name == 'workflow_dispatch' && inputs.compatibility-base != ''"
    )
    assert "git merge-base --is-ancestor" in guard["run"]
    assert "git ls-remote origin refs/heads/main" in guard["run"]
    assert "git rev-parse HEAD" in guard["run"]


def test_reusable_wheel_remains_full_and_registry_can_be_dispatched() -> None:
    wheel = load_github_yaml(ROOT / ".github/workflows/release-wheel.yml")
    assert "workflow_call" in wheel["on"]
    assert "changes" not in wheel["jobs"]
    assert "if" not in wheel["jobs"]["wheel"]
    registry = load_github_yaml(ROOT / ".github/workflows/registry-backup-windows.yml")
    assert "workflow_dispatch" in registry["on"]


def test_dispatch_guard_checks_real_head_current_main_and_ancestry(release_repo: Path) -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
    guard = next(
        step["run"]
        for step in workflow["jobs"]["pytest"]["steps"]
        if step.get("name") == "Verify final release integration identity"
    )
    git(release_repo, "remote", "add", "origin", str(release_repo))
    base = git(release_repo, "rev-parse", "main")
    head = git(release_repo, "rev-parse", "HEAD")

    def run(expected_base: str, expected_head: str) -> int:
        return subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", guard],
            cwd=release_repo,
            env=os.environ | {"EXPECTED_BASE": expected_base, "EXPECTED_HEAD": expected_head},
            capture_output=True,
        ).returncode

    assert run(base, head) == 0
    assert run(base, base) != 0
    assert run("$(touch injected)", head) != 0
    assert not (release_repo / "injected").exists()
    git(release_repo, "checkout", "-q", "main")
    write(release_repo, "README.md", "main changed\n")
    current = commit(release_repo)
    git(release_repo, "checkout", "-q", BRANCH)
    assert run(base, head) != 0
    assert run(current, head) != 0
    git(release_repo, "merge", "-q", "main", "--no-edit")
    assert run(current, git(release_repo, "rev-parse", "HEAD")) == 0
