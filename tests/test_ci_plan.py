"""scripts/ci_plan.py: which test.yml jobs a pull request, push or nightly run needs."""

from __future__ import annotations

import json
import re
import subprocess
import typing
from pathlib import Path

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
cp = load_script("ci_plan", register=True)

MAIN = ["main-1of4", "main-2of4", "main-3of4", "main-4of4"]
PR_E2E = ["main-smoke"]
RELEASE_E2E = [*MAIN, "compat-webkit-1of3", "compat-webkit-2of3", "compat-webkit-3of3"]
FULL_E2E = [*MAIN, "compat-chromium", "compat-webkit"]

# Every pattern whose changes run Vitest and the browser suites on a PR. Editing
# this list is a review decision: a path left out skips e2e until main runs it.
GUI_PATTERNS = [
    "gui/web/**",
    "src/podcast_mcp/gui/**",
    "src/podcast_mcp/services/**",
    "src/podcast_mcp/models/**",
    "src/podcast_mcp/feed/**",
    "src/podcast_mcp/mcp/**",
    "src/podcast_mcp/extensions/**",
    "src/podcast_mcp/project/**",
    "src/podcast_mcp/config/**",
    "src/podcast_mcp/cli/**",
    "src/podcast_mcp/*.py",
    "contracts/**",
    "schemas/**",
    "deploy/brand/**",
    "tests/fixtures/aligned_dialogue/**",
    "tests/fixtures/sharecut_ux_demo/**",
    "tests/fixtures/document_delta/**",
    "tests/fixtures/gain_curve/**",
    "tests/fixtures/render_clock/**",
    "tests/fixtures/proxy_basis/**",
    "tests/fixtures/timing_map/**",
    "tests/fixtures/edit_head/**",
    "tests/fixtures/bootstrap_status/**",
    "scripts/ci_plan.py",
    "scripts/docs_sync.py",
    "scripts/path_vocab.py",
    "scripts/export_capabilities_copy.py",
    "scripts/export_timeline_zoom.py",
    "scripts/export_limit_contracts.py",
    "scripts/export_roles.py",
    "scripts/build_brand_assets.py",
    "scripts/build_large_project_fixture.py",
    "scripts/ux_demo_prepare_shares.py",
    "docs/daw-shortcuts.md",
    "ux/pages/shortcuts.md",
    "config/distribution.dev.json",
    ".github/workflows/test.yml",
    ".github/actions/**",
    "pyproject.toml",
    "uv.lock",
    ".nvmrc",
    ".agents/defaults/**",
]


def _names(plan) -> list[str]:
    return [job.name for job in plan.e2e]


def test_gui_path_set_is_pinned() -> None:
    gui = [glob.text for glob, scope in cp.PATH_RULES if scope is cp.Scope.GUI]
    assert gui == GUI_PATTERNS


def test_every_tracked_path_is_classified_by_a_rule() -> None:
    unclassified = [path for path in _tracked() if cp.rule_for(path) is None]
    assert unclassified == [], "classify these in scripts/ci_plan.py PATH_RULES"


def test_every_python_package_is_classified_at_its_own_directory() -> None:
    packages = sorted(
        path.name
        for path in (ROOT / "src" / "podcast_mcp").iterdir()
        if path.is_dir() and (path / "__init__.py").exists()
    )
    rules = {glob.text for glob, _ in cp.PATH_RULES}
    assert [name for name in packages if f"src/podcast_mcp/{name}/**" not in rules] == []


def test_no_rule_is_shadowed_by_an_earlier_one() -> None:
    for glob, scope in cp.PATH_RULES:
        probe = glob.text.replace("**", "probe.py")
        probe = probe.replace("*", "probe")
        assert cp.rule_for(probe) == (glob, scope), glob.text


@pytest.mark.parametrize(
    "path",
    ["brand-new-dir/x.py", "src/podcast_mcp/new_package/x.py", "gui/new_shell/main.ts"],
)
def test_an_unclassified_path_runs_the_browser_suites(
    path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cp, "changed_tests", lambda changed, root=cp.ROOT: ["tests/test_x.py"])
    assert cp.rule_for(path) is None
    plan = cp.plan("pull_request", [path])
    assert plan.gui is True
    assert _names(plan) == PR_E2E


@pytest.mark.parametrize(
    ("changed", "gui", "pytest_scope", "e2e"),
    [
        (["docs/setup.md", "README.md"], False, "docs", []),
        (["ux/pages/brand.md", "AGENTS.md", "ROADMAP.md"], False, "docs", []),
        (["docs-site/index.html", ".agents/skills/podcast-setup/SKILL.md"], False, "docs", []),
        (["docs/setup.md", "src/podcast_mcp/edits/cuts.py"], False, "changed", []),
        ([".agents/defaults/pipeline.yaml"], True, "changed", PR_E2E),
        ([".agents/rules/gui-styling.md"], False, "changed", []),
        ([".cursor/rules/pstack-models.mdc"], False, "changed", []),
        (["config/distribution.dev.json"], True, "changed", PR_E2E),
        (["tests/fixtures/document_delta/insert.json"], True, "changed", PR_E2E),
        (
            ["src/podcast_mcp/engines/bleed_gate.py", "tests/test_bleed_gate.py"],
            False,
            "changed",
            [],
        ),
        (["src/podcast_mcp/edits/cuts.py"], False, "changed", []),
        (["gui/web/src/App.tsx", "gui/web/e2e/recordRoom.ts"], True, "web", PR_E2E),
        (["gui/web/src/App.tsx", "docs/gui-integration.md"], True, "web-docs", PR_E2E),
        (
            ["gui/web/src/App.tsx", "docs/design/stages/edit.md", "ux/pages/x.md"],
            True,
            "web-docs",
            PR_E2E,
        ),
        (["gui/web/src/App.tsx", "src/podcast_mcp/edits/cuts.py"], True, "changed", PR_E2E),
        (
            ["docs/setup.md", "src/podcast_mcp/edits/cuts.py", "gui/web/src/App.tsx"],
            True,
            "changed",
            PR_E2E,
        ),
        (["gui/web/src/App.tsx", "contracts/timeline-zoom.json"], True, "changed", PR_E2E),
        (["gui/web/package-lock.json", "docs/setup.md"], True, "web-docs", PR_E2E),
        (["docs/daw-shortcuts.md"], True, "docs", PR_E2E),
        (["src/podcast_mcp/services/play.py"], True, "changed", PR_E2E),
        (["src/podcast_mcp/project/io.py"], True, "changed", PR_E2E),
        (["src/podcast_mcp/config/defaults.py"], True, "changed", PR_E2E),
        (["contracts/test-wait-allowlist.json"], False, "changed", []),
        (["contracts/test-wait-allowlist.json", "tests/test_test_waits.py"], False, "changed", []),
        (["contracts/test-wait-allowlist.json", "gui/web/src/App.tsx"], True, "changed", PR_E2E),
        (["contracts/timeline-zoom.json"], True, "changed", PR_E2E),
        (["contracts/new-contract.json"], True, "changed", PR_E2E),
        (["new-area/file.py"], True, "changed", PR_E2E),
        (["scripts/ci_plan.py"], True, "changed", PR_E2E),
        (["tests/fixtures/aligned_dialogue/episode.sharecut"], True, "changed", PR_E2E),
        ([".github/workflows/test.yml"], True, "changed", PR_E2E),
        ([".github/workflows/desktop.yml"], False, "changed", []),
        (["gui/desktop/src-tauri/src/main.rs"], False, "changed", []),
        (["scripts/desktop/lib.sh", "scripts/desktop/pack_macos_dmg.sh"], False, "changed", []),
        ([], True, "full", PR_E2E),
    ],
)
def test_pull_request_plan(
    changed: list[str],
    gui: bool,
    pytest_scope: str,
    e2e: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cp, "changed_tests", lambda changed, root=cp.ROOT: ["tests/test_x.py"])
    plan = cp.plan("pull_request", changed)
    assert (plan.gui, plan.pytest, _names(plan)) == (gui, pytest_scope, e2e)


@pytest.mark.parametrize("event", ["schedule", "workflow_dispatch"])
def test_nightly_and_dispatch_run_everything(event: str) -> None:
    plan = cp.plan(event, [])
    assert (plan.gui, plan.pytest, _names(plan)) == (True, "full", FULL_E2E)


def test_push_to_main_plans_only_the_quick_checks() -> None:
    plan = cp.plan("push", [])
    assert (plan.gui, plan.pytest, _names(plan)) == (True, "quick", [])
    outputs = plan.outputs()
    assert (outputs["gui"], outputs["e2e"], outputs["pytest"]) == ("true", "false", "quick")
    assert json.loads(outputs["e2e-matrix"]) == {"include": []}


def test_e2e_output_tracks_whether_any_browser_suite_is_planned() -> None:
    assert cp.plan("pull_request", ["gui/web/src/App.tsx"]).outputs()["e2e"] == "true"
    docs_only = cp.plan("pull_request", ["docs/testing.md"]).outputs()
    assert (docs_only["gui"], docs_only["e2e"]) == ("false", "false")


def test_matrix_output_is_the_workflow_include_list() -> None:
    outputs = cp.plan("pull_request", ["gui/web/src/App.tsx"]).outputs()
    assert outputs["gui"] == "true"
    assert outputs["pytest"] == "web"
    (job,) = json.loads(outputs["e2e-matrix"])["include"]
    assert (job["name"], job["browser"]) == ("main-smoke", "chromium")
    assert job["command"] == "npm run test:e2e -- " + " ".join(
        f"e2e/{name}" for name in cp.SMOKE_SPECS
    )


def test_a_release_pull_request_keeps_webkit_compat_in_shards() -> None:
    plan = cp.plan(
        "pull_request",
        ["gui/web/src/App.tsx"],
        head_ref="release-please--branches--main--components--podcast-mcp",
    )
    assert _names(plan) == RELEASE_E2E


def test_a_pull_request_runs_no_compat_job() -> None:
    plan = cp.plan("pull_request", ["gui/web/src/App.tsx"])
    assert not [name for name in _names(plan) if name.startswith("compat")]


def test_web_subset_selects_files_that_name_gui_web(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    (tests / "nested").mkdir(parents=True)
    (tmp_path / "scripts").mkdir()
    (tests / "test_slash.py").write_text('CSS = ROOT / "gui/web/src/App.css"\n')
    (tests / "test_parts.py").write_text("WEB = ROOT / 'gui' / 'web'\n")
    (tests / "nested" / "test_args.py").write_text('WEB = Path("gui", "web")\n')
    (tests / "test_other.py").write_text('DOCS = ROOT / "docs"\n')
    (tests / "helper_gui_web.py").write_text('X = "gui/web"\n')
    assert cp.subset_tests("web", tmp_path) == [
        "tests/nested/test_args.py",
        "tests/test_parts.py",
        "tests/test_slash.py",
    ]


def test_subset_selects_tests_that_run_a_script_reading_the_scope(tmp_path: Path) -> None:
    (tmp_path / "tests").mkdir()
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "reads_web.py").write_text('SRC = ROOT / "gui/web/src"\n')
    (tmp_path / "scripts" / "wraps_web.py").write_text("from reads_web import SRC\n")
    (tmp_path / "scripts" / "reads_nothing.py").write_text("X = 1\n")
    (tmp_path / "tests" / "test_load.py").write_text('m = load_script("reads_web")\n')
    (tmp_path / "tests" / "test_path.py").write_text('S = ROOT / "scripts/wraps_web.py"\n')
    (tmp_path / "tests" / "test_parts.py").write_text('S = ROOT / "scripts" / "reads_web.py"\n')
    (tmp_path / "tests" / "test_idle.py").write_text('m = load_script("reads_nothing")\n')
    assert cp.subset_tests("web", tmp_path) == [
        "tests/test_load.py",
        "tests/test_parts.py",
        "tests/test_path.py",
    ]


def test_docs_subset_selects_files_that_name_docs_paths(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tmp_path / "scripts").mkdir()
    for name, line in {
        "test_slash": 'P = ROOT / "docs/setup.md"',
        "test_parts": 'P = ROOT / "ux" / "pages"',
        "test_readme": 'P = ROOT / "README.md"',
        "test_skills": 'P = ROOT / ".agents" / "skills"',
        "test_site": 'P = "docs-site/index.html"',
        "test_defaults": 'P = ROOT / ".agents" / "defaults" / "pipeline.yaml"',
        "test_download": 'DOC = "https://docs.sharecut.studio/x"',
        "test_none": "X = 1",
    }.items():
        (tests / f"{name}.py").write_text(line + "\n")
    assert cp.subset_tests("docs", tmp_path) == [
        "tests/test_defaults.py",
        "tests/test_parts.py",
        "tests/test_readme.py",
        "tests/test_site.py",
        "tests/test_skills.py",
        "tests/test_slash.py",
    ]


def test_web_docs_subset_is_the_union_of_both_subsets() -> None:
    assert set(cp.subset_tests("web-docs")) == set(cp.subset_tests("web")) | set(
        cp.subset_tests("docs")
    )


def test_every_planned_pytest_scope_reaches_the_pytest_aggregator() -> None:
    scopes = typing.get_args(typing.get_type_hints(cp.CiPlan)["pytest"])
    run = load_github_yaml(WORKFLOW)["jobs"]["pytest"]["steps"][0]["run"]
    assert set(scopes) == {"full", "web", "docs", "web-docs", "changed", "quick", "release"}
    for scope in scopes:
        shards = "skipped" if scope == "quick" else "success"
        assert f"success:{scope}:success:{shards}" in run
    assert "success:quick:success:success" not in run


def _tests_tree(tmp_path: Path) -> Path:
    (tmp_path / "tests").mkdir()
    (tmp_path / "scripts").mkdir()
    (tmp_path / "tests" / "test_cuts.py").write_text("from podcast_mcp.edits import cuts\n")
    (tmp_path / "tests" / "test_dotted.py").write_text("import podcast_mcp.edits.cuts\n")
    (tmp_path / "tests" / "test_workflow.py").write_text(
        'WORKFLOW = ".github/workflows/test.yml"\n'
    )
    (tmp_path / "tests" / "test_tool.py").write_text('tool = load_script("my_tool")\n')
    (tmp_path / "tests" / "test_other.py").write_text("x = 1\n")
    return tmp_path


def test_changed_tests_selects_changed_test_files_and_their_references(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    assert cp.changed_tests(["src/podcast_mcp/edits/cuts.py"], root) == [
        "tests/test_cuts.py",
        "tests/test_dotted.py",
    ]
    assert cp.changed_tests(["tests/test_other.py"], root) == ["tests/test_other.py"]
    assert cp.changed_tests([".github/workflows/test.yml"], root) == ["tests/test_workflow.py"]
    assert cp.changed_tests(["scripts/my_tool.py"], root) == ["tests/test_tool.py"]
    assert cp.changed_tests(["README.md", "docs/setup.md"], root) == []


def test_changed_tests_ignores_a_deleted_test_file(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    assert cp.changed_tests(["tests/test_gone.py"], root) == []


def test_a_diff_reaching_too_many_tests_is_not_a_smoke_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _tests_tree(tmp_path)
    monkeypatch.setattr(cp, "MAX_CHANGED_TESTS", 1)
    assert cp.changed_tests(["src/podcast_mcp/edits/cuts.py", "tests/test_other.py"], root) is None


def test_a_pull_request_that_reaches_no_pytest_file_runs_the_full_suite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cp, "changed_tests", lambda changed, root=cp.ROOT: [])
    assert cp.plan("pull_request", ["src/podcast_mcp/edits/cuts.py"]).pytest == "full"


def test_a_pull_request_that_reaches_too_much_runs_the_full_suite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cp, "changed_tests", lambda changed, root=cp.ROOT: None)
    assert cp.plan("pull_request", ["src/podcast_mcp/edits/cuts.py"]).pytest == "full"


def test_every_smoke_spec_exists() -> None:
    for name in cp.SMOKE_SPECS:
        assert (ROOT / "gui" / "web" / "e2e" / name).is_file(), name


def test_web_subset_includes_the_repo_gui_web_readers() -> None:
    selected = set(cp.subset_tests("web"))
    assert {
        "tests/test_browser_acceptance_matrix.py",
        "tests/test_capabilities_manifest.py",
        "tests/test_css_policy.py",
        "tests/test_gui_api.py",
        "tests/test_gui_static_root.py",
        "tests/test_ci_plan.py",
    } <= selected
    assert "tests/test_bleed_gate_channels.py" not in selected


def test_docs_subset_includes_the_repo_docs_readers() -> None:
    selected = set(cp.subset_tests("docs"))
    assert {
        "tests/test_beta_story_matrix.py",
        "tests/test_browser_acceptance_matrix.py",
        "tests/test_capabilities_manifest.py",
        "tests/test_decision_records.py",
        "tests/test_docs_layout.py",
        "tests/test_docs_sync.py",
        "tests/test_effects_presets.py",
        "tests/test_mcp_setup_docs.py",
        "tests/test_ux_site_routes.py",
    } <= selected
    assert "tests/test_bleed_gate_channels.py" not in selected


GUI_WEB_REPO_PATH_RE = re.compile(
    r"(?:tests/fixtures|scripts|contracts|schemas|\.agents|config)/[\w./-]*\w"
)


def _tracked() -> list[str]:
    return subprocess.run(
        ["git", "-C", str(ROOT), "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()


def _gui_web_repo_paths() -> dict[str, list[str]]:
    """Tracked repo paths that gui/web code names, with the files that name them."""
    tracked = _tracked()
    named: dict[str, set[str]] = {}
    for rel in tracked:
        if not rel.startswith("gui/web/") or rel.endswith((".md", "package-lock.json")):
            continue
        try:
            text = (ROOT / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        for match in GUI_WEB_REPO_PATH_RE.finditer(text):
            reference = match.group(0)
            prefix = reference.rstrip("/") + "/"
            for path in tracked:
                if path == reference or path.startswith(prefix):
                    named.setdefault(path, set()).add(rel)
    return {path: sorted(files) for path, files in named.items()}


def test_gui_web_finds_the_repo_paths_it_reads() -> None:
    named = _gui_web_repo_paths()
    assert any(path.startswith("tests/fixtures/document_delta/") for path in named)
    assert "contracts/timeline-zoom.json" in named


def test_every_repo_path_gui_web_reads_is_classified_gui() -> None:
    misses = {
        path: files
        for path, files in _gui_web_repo_paths().items()
        if cp.scope_of(path) is not cp.Scope.GUI
    }
    assert misses == {}, "gui/web reads these; classify them GUI in scripts/ci_plan.py PATH_RULES"


def test_changed_files_diffs_from_the_merge_base(tmp_path: Path) -> None:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(tmp_path), *args], capture_output=True, text=True, check=True
        ).stdout.strip()

    git("init", "-q", "-b", "main")
    git("config", "user.email", "ci@example.com")
    git("config", "user.name", "ci")
    (tmp_path / "README.md").write_text("a\n")
    git("add", ".")
    git("commit", "-q", "-m", "base")
    git("checkout", "-q", "-b", "pr")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "x.md").write_text("x\n")
    git("add", ".")
    git("commit", "-q", "-m", "pr")
    git("checkout", "-q", "main")
    (tmp_path / "README.md").write_text("b\n")
    git("commit", "-q", "-am", "trunk moved")
    assert cp.changed_files("main", "pr", root=tmp_path) == ["docs/x.md"]


def test_pytest_shards_take_their_scope_from_the_planner_and_gate_coverage_on_full_runs() -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    shard = jobs["pytest-shard"]
    assert shard["needs"] == "changes"
    assert shard["if"] == (
        "needs.changes.result == 'success' && needs.changes.outputs.pytest != 'quick'"
    )
    assert "plan" not in {step.get("id") for step in shard["steps"]}
    assert shard["env"]["PYTEST_SCOPE"] == "${{ needs.changes.outputs.pytest }}"
    by_name = {step.get("name"): step for step in shard["steps"]}
    assert by_name["Run tests with coverage gate"]["if"] == "env.PYTEST_SCOPE == 'full'"
    web = by_name["Run the tests that read gui/web"]
    assert web["if"] == "env.PYTEST_SCOPE == 'web'"
    assert '"$(python3 scripts/ci_plan.py subset-tests web)"' in web["run"]
    assert "--no-cov" in web["run"]
    docs = by_name["Run the tests that read docs"]
    assert docs["if"] == "env.PYTEST_SCOPE == 'docs'"
    assert '"$(python3 scripts/ci_plan.py subset-tests docs)"' in docs["run"]
    assert "--no-cov" in docs["run"]
    union = by_name["Run the tests that read gui/web or docs"]
    assert union["if"] == "env.PYTEST_SCOPE == 'web-docs'"
    assert '"$(python3 scripts/ci_plan.py subset-tests web-docs)"' in union["run"]
    assert "--no-cov" in union["run"]
    quality = {step.get("name"): step for step in jobs["pytest-quality"]["steps"]}
    assert "needs" not in jobs["pytest-quality"]
    assert "pytest" not in quality["Docs-sync gate (PR diff)"]["if"]


def test_changes_job_feeds_frontend_and_the_browser_suites() -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    changes = jobs["changes"]
    assert changes["outputs"] == {
        "gui": "${{ steps.plan.outputs.gui }}",
        "e2e": "${{ steps.plan.outputs.e2e }}",
        "e2e-matrix": "${{ steps.plan.outputs.e2e-matrix }}",
        "release-only": "${{ steps.plan.outputs.release-only }}",
        "pytest": "${{ steps.plan.outputs.pytest }}",
        "playwright-image": "${{ steps.playwright.outputs.image }}",
    }
    (plan,) = [step for step in changes["steps"] if step.get("id") == "plan"]
    assert plan["uses"] == "./.github/actions/ci-plan"
    for name, output in (("frontend-suite", "gui"), ("frontend-e2e-suites", "e2e")):
        assert jobs[name]["needs"] == "changes"
        assert jobs[name]["if"] == f"needs.changes.outputs.{output} == 'true'"
    assert jobs["frontend-e2e"]["steps"][0]["env"]["GUI"] == "${{ needs.changes.outputs.e2e }}"
    assert set(load_github_yaml(WORKFLOW)["on"]) == {
        "push",
        "pull_request",
        "workflow_dispatch",
    }


ALERT_ACTION = ROOT / ".github" / "actions" / "nightly-alert" / "action.yml"


@pytest.mark.parametrize("workflow", ["test.yml", "desktop.yml", "registry-backup-windows.yml"])
def test_only_promote_owns_the_nightly_alert_and_schedule(workflow: str) -> None:
    data = load_github_yaml(ROOT / ".github" / "workflows" / workflow)
    assert "nightly-alert" not in data["jobs"]
    assert "schedule" not in data["on"]


def test_nightly_alert_action_opens_comments_and_closes_the_labelled_issue() -> None:
    action = load_github_yaml(ALERT_ACTION)
    assert action["runs"]["using"] == "composite"
    assert set(action["inputs"]) == {"workflow", "results", "token", "legacy-titles"}
    run = action["runs"]["steps"][0]["run"]
    for command in ("gh issue create", "gh issue comment", "gh issue close"):
        assert command in run


def test_desktop_workflow_runs_manually_and_on_pull_requests_not_on_push() -> None:
    triggers = set(load_github_yaml(ROOT / ".github" / "workflows" / "desktop.yml")["on"])
    assert triggers == {"pull_request", "workflow_dispatch"}


def test_playwright_summary_reads_the_report_configured_for_its_matrix_job() -> None:
    job = load_github_yaml(WORKFLOW)["jobs"]["frontend-e2e-suites"]
    summary = next(
        step for step in job["steps"] if step.get("name") == "Summarize Playwright tests"
    )

    assert '--report "gui/web/$PLAYWRIGHT_JSON_OUTPUT_FILE"' in summary["run"]
    assert "--report gui/web/playwright-report/main.json" not in summary["run"]


def _ci_body_targets() -> set[str]:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    body = re.search(r"^ci-body:(.*)$", makefile, re.M)
    assert body is not None
    return set(body.group(1).split())


def test_required_checks_table_in_docs_is_current() -> None:
    assert cp.sync_required_checks_docs(ROOT, write=False) == []


def test_required_checks_table_rewrites_a_stale_embed(tmp_path: Path) -> None:
    for relative in cp.REQUIRED_CHECKS_DOCS:
        doc = tmp_path / relative
        doc.parent.mkdir(parents=True, exist_ok=True)
        doc.write_text(f"intro\n{cp.REQUIRED_CHECKS_BEGIN}\nold\n{cp.REQUIRED_CHECKS_END}\ntail\n")
    assert cp.sync_required_checks_docs(tmp_path, write=True) == list(cp.REQUIRED_CHECKS_DOCS)
    assert cp.sync_required_checks_docs(tmp_path, write=False) == []
    text = (tmp_path / cp.REQUIRED_CHECKS_DOCS[0]).read_text()
    assert text.startswith("intro\n") and text.endswith("tail\n")
    assert "| `gitleaks-history` | `secret-scan.yml` |" in text


def test_required_checks_embed_needs_both_markers() -> None:
    with pytest.raises(ValueError, match="missing"):
        cp.embed_required_checks("no markers here")


def test_make_ci_body_is_the_union_of_the_local_mirrors() -> None:
    mirrored = {target for check in cp.REQUIRED_CHECKS for target in check.local}
    assert mirrored == _ci_body_targets()


def test_every_required_check_is_a_job_in_its_workflow() -> None:
    for check in cp.REQUIRED_CHECKS:
        workflow = load_github_yaml(ROOT / ".github" / "workflows" / check.workflow)
        job = workflow["jobs"][check.job]
        assert job.get("name", check.job) == check.name


def test_the_merge_gate_reads_the_same_required_checks() -> None:
    gate = load_script("poteto_issue_gate")
    assert tuple(check.name for check in cp.REQUIRED_CHECKS) == gate.REQUIRED_CHECKS


def test_a_source_file_no_test_names_runs_the_whole_suite(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    assert cp.changed_tests(["src/podcast_mcp/edits/unnamed.py"], root) is None
    assert cp.changed_tests(["tests/helper_nobody_imports.py"], root) is None


def test_a_shared_test_helper_reaches_the_tests_that_import_it(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    (root / "tests" / "test_uses_helper.py").write_text("from bleed_helpers import make\n")
    assert cp.changed_tests(["tests/bleed_helpers.py"], root) == ["tests/test_uses_helper.py"]


def test_a_parenthesised_from_import_reaches_the_module(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    (root / "tests" / "test_multi.py").write_text(
        "from podcast_mcp.gui.routes import (\n    other,\n    export_routes,\n)\n"
    )
    assert cp.changed_tests(["src/podcast_mcp/gui/routes/export_routes.py"], root) == [
        "tests/test_multi.py"
    ]


def test_a_workflow_named_test_yml_reaches_the_tests_that_read_it(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    (root / "tests" / "test_reads.py").write_text('p = ".github" / "workflows" / "test.yml"\n')
    assert "tests/test_reads.py" in (cp.changed_tests([".github/workflows/test.yml"], root) or [])


def test_a_changed_test_module_reaches_the_tests_that_import_it(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    (root / "tests" / "test_base.py").write_text("x = 1\n")
    (root / "tests" / "test_user.py").write_text("from test_base import x\n")
    assert cp.changed_tests(["tests/test_base.py"], root) == [
        "tests/test_base.py",
        "tests/test_user.py",
    ]


def test_a_mixed_diff_keeps_the_docs_readers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _tests_tree(tmp_path)
    monkeypatch.setattr(
        cp, "subset_tests", lambda scope, root=cp.ROOT: ["tests/test_docs_reader.py"]
    )
    reached = cp.changed_tests(["docs/setup.md", "tests/test_other.py"], root)
    assert reached == ["tests/test_docs_reader.py", "tests/test_other.py"]


def test_a_non_python_file_no_test_names_runs_the_whole_suite(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    assert cp.changed_tests(["deploy/relay/Dockerfile"], root) is None


def test_a_planner_meta_test_does_not_vouch_for_a_path(tmp_path: Path) -> None:
    root = _tests_tree(tmp_path)
    (root / "tests" / "test_meta.py").write_text(
        'import ci_plan\nPATH = "deploy/relay/Dockerfile"\n'
    )
    assert cp.changed_tests(["deploy/relay/Dockerfile"], root) is None
