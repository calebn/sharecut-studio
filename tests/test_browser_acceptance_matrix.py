from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from github_yaml import load_github_yaml
from markdown_table import MarkdownTable, code_spans, section_table
from script_loader import load_script

REPO_ROOT = Path(__file__).parents[1]
TESTING_DOC = REPO_ROOT / "docs" / "testing-ci.md"
HEADING = "### Browser acceptance matrix"
COMPAT_DIR = REPO_ROOT / "gui" / "web" / "e2e-compat"
COMPAT_CONFIG = REPO_ROOT / "gui" / "web" / "playwright.compat.config.ts"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "test.yml"
CI_SUITES_JOB = "frontend-e2e-suites"
CI_GATE_JOB = "frontend-e2e"
CI_PLAN_GATE = "needs.changes.outputs.gui == 'true'"
CI_MATRIX = "${{ fromJSON(needs.changes.outputs.e2e-matrix) }}"
MAIN_COMMAND = "npm run test:e2e"
MAIN_SHARD_RE = re.compile(r"^npm run test:e2e -- --shard=(\d+)/(\d+)$")
COMPAT_COMMAND = "npm run test:e2e:compat"
COMPAT_ENGINES = ("chromium", "webkit")
CHROMIUM_MAIN_OWNERS = {
    "gui/web/e2e-compat/comment-undo.spec.ts": {
        "main_spec": "gui/web/e2e/comment-undo.spec.ts",
        "helper": "commentUndo",
        "call": "exerciseCommentUndo(page, theme, info)",
        "profile": "360x800, dark, default motion",
        "main_profile": """withAppearance([
            { width: 1440, height: 900 },
            { width: 360, height: 800 },
        ])""",
        "compat_profile": "setViewportSize({ width: 360, height: 800 })",
        "compat_call": 'exerciseCommentUndo(page, "dark", info)',
    },
    "gui/web/e2e-compat/transcript-wordbar.spec.ts": {
        "main_spec": "gui/web/e2e/transcript-wordbar.spec.ts",
        "helper": "wordbarFlow",
        "call": "checkWordbarOutsideRelease(page)",
        "profile": "inherited Desktop Chrome viewport, default theme and motion",
        "main_profile": "",
        "compat_profile": "",
        "compat_call": "checkWordbarOutsideRelease(page)",
    },
}

PASS = "Pass"
NOT_RUN = "Not run"
# Doc column -> the Playwright project (engine) standing in for that browser.
ENGINE_COLUMNS = {
    "Chromium (Chrome)": "chromium",
    "WebKit (Safari)": "webkit",
    "Firefox": "firefox",
}
HEADER = ["Check", "Spec", "Area", *ENGINE_COLUMNS]
AREAS = {
    "Core flow",
    "Audio playback",
    "getUserMedia",
    "WebSocket",
    "IndexedDB",
    "CSS / layout",
    "Waveform",
}
# The areas of concern #30 raised; each needs a row passing on Chromium and WebKit.
ISSUE_30_AREAS = {"Audio playback", "getUserMedia", "WebSocket", "IndexedDB", "CSS / layout"}

_STEP_RE = re.compile(r'\btest\.step\(\s*"((?:[^"\\]|\\.)*)"')
_TEST_RE = re.compile(r'(?<![.\w])test\(\s*"((?:[^"\\]|\\.)*)"')
_NON_LITERAL_TITLE_RE = re.compile(r"(?<![.\w])test(?:\.step)?\(\s*[`']")
_SKIP_RE = re.compile(r"\btest(?:\.describe)?\.(?:skip|fixme|fail|only)\b")
_RETRIES_RE = re.compile(r"\bretries:\s*([^,\n]+)")
CI_RETRIES = "process.env.CI ? 1 : 0"
_UNSUPPORTED_FILTER_RE = re.compile(r"\b(?:testMatch|grep|grepInvert)\s*:")
_PROJECT_NAME_RE = re.compile(r'\bname:\s*"([\w-]+)"')
# The body of a double-quoted string literal with no escapes; every regex below
# that reads a testIgnore list builds on it so they cannot drift apart.
_STRING_BODY = r'[^"]*'
_STRING_RE = re.compile(rf'"({_STRING_BODY})"')
# Quote-aware so a `]` inside a string (e.g. a `[a-c]` glob) does not end the list.
_TEST_IGNORE_RE = re.compile(rf'\btestIgnore:\s*\[((?:"{_STRING_BODY}"|[^\]"])*)\]')
_STRING_LIST_RE = re.compile(rf'\s*(?:"{_STRING_BODY}"\s*,?\s*)*')
# The one testIgnore glob shape the guard reads: a spec file name at any depth.
_IGNORE_GLOB_RE = re.compile(r"\*\*/[\w.-]+\.spec\.ts")
_INSTALL_RE = re.compile(r"\bplaywright install\b([^\n]*)")
ci_plan = load_script("ci_plan", register=True)


def spec_checks(source: str) -> list[str]:
    """A spec's matrix checks: its `test.step` titles, else its test titles.

    A spec that uses `test.step` must wrap the steps in exactly one `test()`,
    so a second top-level test cannot hide behind the steps undocumented.
    """
    steps = _STEP_RE.findall(source)
    tests = _TEST_RE.findall(source)
    if not steps:
        return tests
    assert len(tests) == 1, (
        f"a spec with test.step titles must have exactly one test() wrapping them; found {tests}"
    )
    return steps


def compat_specs() -> dict[str, str]:
    """Every compat spec's repo-relative path mapped to its source."""
    return {
        path.relative_to(REPO_ROOT).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(COMPAT_DIR.rglob("*.spec.ts"))
    }


def compat_projects(config: str) -> dict[str, list[str]]:
    """Map each project `name` in *config* to its `testIgnore` globs.

    A project's block runs from its `name:` to the next `name:` (or to
    `export default`); a `testIgnore` outside those blocks, or not written as a
    string-array literal, fails loudly instead of being misread.
    """
    names = list(_PROJECT_NAME_RE.finditer(config))
    export = config.find("export default")
    projects: dict[str, list[str]] = {}
    found = 0
    for index, match in enumerate(names):
        if index + 1 < len(names):
            end = names[index + 1].start()
        elif export > match.end():
            end = export
        else:
            end = len(config)
        ignore = _TEST_IGNORE_RE.search(config, match.end(), end)
        if ignore:
            assert _STRING_LIST_RE.fullmatch(ignore.group(1)), (
                f"testIgnore list {ignore.group(0)!r} is not only double-quoted string "
                "literals; teach compat_projects to read it"
            )
        globs = _STRING_RE.findall(ignore.group(1)) if ignore else []
        for glob in globs:
            assert _IGNORE_GLOB_RE.fullmatch(glob), (
                f"testIgnore glob {glob!r} is not '**/<file>.spec.ts'; Playwright's glob "
                "rules differ from Python's, so teach compat_projects to read it"
            )
        projects[match.group(1)] = globs
        found += ignore is not None
    assert config.count("testIgnore") == found, (
        "a testIgnore sits outside a project block (after its name:) or is not a "
        "string-array literal; teach compat_projects to read it"
    )
    return projects


def runs_on(spec: str, engine: str, projects: dict[str, list[str]]) -> bool:
    """Whether a project for *engine* exists and does not testIgnore *spec*.

    `compat_projects` only accepts `**/<file>.spec.ts` globs, which match a
    spec by file name at any depth.
    """
    if engine not in projects:
        return False
    return f"**/{spec.rsplit('/', 1)[-1]}" not in projects[engine]


def assert_compat_omissions(projects: dict[str, list[str]]) -> None:
    expected = {f"**/{Path(spec).name}" for spec in CHROMIUM_MAIN_OWNERS}
    for engine, ignored in projects.items():
        allowed = expected if engine == "chromium" else set()
        assert len(ignored) == len(set(ignored)) and set(ignored) == allowed, (
            f"{engine}: testIgnore must match the closed main ownership map; "
            f"expected={sorted(allowed)} actual={ignored}"
        )


def assert_main_ownership(sources: dict[str, str]) -> None:
    def compact(source: str) -> str:
        return re.sub(r"\s+", "", source)

    for spec, owner in CHROMIUM_MAIN_OWNERS.items():
        main = sources[owner["main_spec"]]
        compat = sources[spec]
        helper = owner["helper"]
        assert f'from "./{helper}"' in main, owner
        assert f'from "../e2e/{helper}"' in compat, owner
        assert owner["call"] in main, owner
        assert owner["compat_call"] in compat, owner
        assert compact(owner["main_profile"]) in compact(main), owner
        assert compact(owner["compat_profile"]) in compact(compat), owner
        assert not re.search(r"emulateMedia|setTheme", main + compat), owner
        if owner["main_profile"]:
            assert re.findall(r"test\.use\(([^;]+)\);", main) == ["{ viewport }"], owner
        else:
            assert "test.use" not in main + compat, owner
        if not owner["main_profile"]:
            assert "setViewportSize" not in main + compat, owner
    theme = compact(sources["gui/web/e2e/theme.ts"])
    assert '{theme:"light",reducedMotion:false},{theme:"dark",reducedMotion:true}' in theme
    assert "APPEARANCES[(index+Math.floor(index/4)+offset)%4]" in theme
    helper = sources["gui/web/e2e/commentUndo.ts"]
    assert "emulateMedia" not in helper


def installed_engines(run: str) -> set[str]:
    """Browser engines named on `playwright install` lines of a workflow `run`."""
    return {
        word
        for match in _INSTALL_RE.finditer(run)
        for word in match.group(1).split()
        if not word.startswith("-")
    }


def _matrix() -> MarkdownTable:
    return section_table(TESTING_DOC, HEADING)


def _spec_path(cell: str) -> str:
    spans = code_spans(cell)
    assert len(spans) == 1 and cell == f"`{spans[0]}`", (
        f"Spec cell must be one backticked repo-relative path: {cell!r}"
    )
    return spans[0]


def _frontend_e2e_steps() -> list[dict]:
    job = load_github_yaml(WORKFLOW)["jobs"][CI_SUITES_JOB]
    assert not job.get("continue-on-error"), f"{CI_SUITES_JOB} must fail the build"
    assert job["if"] == CI_PLAN_GATE, f"{CI_SUITES_JOB} may only skip by the plan"
    return job["steps"]


def planned_include(event: str, changed: tuple[str, ...] = ()) -> list[dict]:
    """The matrix `include` list scripts/ci_plan.py hands the workflow."""
    matrix = ci_plan.plan(event, list(changed)).outputs()["e2e-matrix"]
    return json.loads(matrix)["include"]


def compat_ci_engines(include: list[dict]) -> list[str]:
    rows = [entry for entry in include if entry["name"].startswith("compat")]
    expected = [
        {
            "name": f"compat-{engine}",
            "command": f"{COMPAT_COMMAND} -- --project={engine}",
            "browser": engine,
        }
        for engine in COMPAT_ENGINES
    ]
    assert rows == expected, f"compat jobs must run each complete engine exactly once: {rows}"
    return list(COMPAT_ENGINES)


def test_matrix_header_names_every_engine_column() -> None:
    assert _matrix().header == HEADER


def test_every_row_has_one_cell_per_column() -> None:
    for row in _matrix().rows:
        assert len(row) == len(HEADER), f"expected {len(HEADER)} cells, got {row}"


def test_rows_match_every_compat_check() -> None:
    documented = [(_spec_path(record["Spec"]), record["Check"]) for record in _matrix().records()]
    expected = [
        (spec, check) for spec, source in compat_specs().items() for check in spec_checks(source)
    ]

    assert len(documented) == len(set(documented)), f"duplicate rows: {documented}"
    assert len(expected) == len(set(expected)), f"duplicate spec/check owners: {expected}"

    missing = sorted(set(expected) - set(documented))
    stale = sorted(set(documented) - set(expected))
    assert set(documented) == set(expected), (
        f"missing={missing} stale={stale}; update docs/testing-ci.md § Browser acceptance matrix"
    )


def test_every_compat_spec_has_readable_checks() -> None:
    for spec, source in compat_specs().items():
        assert spec_checks(source), f"{spec}: no test or test.step titles found"
        assert _NON_LITERAL_TITLE_RE.search(source) is None, (
            f"{spec}: a test/test.step title is not a plain double-quoted string literal"
        )


def test_engine_cells_match_the_compat_projects() -> None:
    projects = compat_projects(COMPAT_CONFIG.read_text(encoding="utf-8"))
    for record in _matrix().records():
        spec = _spec_path(record["Spec"])
        for column, engine in ENGINE_COLUMNS.items():
            expected = PASS if runs_on(spec, engine, projects) else NOT_RUN
            assert record[column] == expected, (
                f"{record['Check']} ({spec}): {column} is {record[column]!r}, expected {expected!r}"
            )


def test_compat_run_has_no_skips_retries_or_filters() -> None:
    for spec, source in compat_specs().items():
        assert _SKIP_RE.search(source) is None, f"{spec}: has a skip/fixme/fail/only"

    config = COMPAT_CONFIG.read_text(encoding="utf-8")
    assert _RETRIES_RE.findall(config) == [CI_RETRIES], (
        f"playwright.compat.config.ts must set retries: {CI_RETRIES}, like the main suite"
    )
    assert _UNSUPPORTED_FILTER_RE.search(config) is None, (
        "playwright.compat.config.ts filters tests with testMatch/grep/grepInvert"
    )


def test_ci_runs_both_browser_suites_on_main_and_nightly_on_every_passing_engine() -> None:
    workflow = load_github_yaml(WORKFLOW)
    triggers = workflow["on"]
    for event in ("push", "pull_request"):
        assert "paths" not in triggers[event], f"{event} must not path-filter browser CI"
        assert "paths-ignore" not in triggers[event], f"{event} must not path-filter browser CI"
    assert {"schedule", "workflow_dispatch"} <= set(triggers)

    job = workflow["jobs"][CI_SUITES_JOB]
    assert job["strategy"]["fail-fast"] is True
    assert job["strategy"]["matrix"] == CI_MATRIX
    include = planned_include("push")
    assert planned_include("schedule") == include
    engines = compat_ci_engines(include)
    shards = [
        MAIN_SHARD_RE.match(entry["command"])
        for entry in include
        if not entry["name"].startswith("compat")
    ]
    assert all(shards), f"main shards must run `{MAIN_COMMAND} -- --shard=i/n`: {include}"
    totals = {shard[2] for shard in shards if shard}
    assert len(totals) == 1, f"main shards disagree on the shard count: {totals}"
    count = int(totals.pop())
    assert [int(shard[1]) for shard in shards if shard] == list(range(1, count + 1)), (
        "main shards must cover --shard=1/n through n/n exactly once"
    )
    assert [entry["name"] for entry in include] == [
        *(f"main-{i}of{count}" for i in range(1, count + 1)),
        *(f"compat-{engine}" for engine in engines),
    ]
    assert len({entry["name"] for entry in include}) == len(include)
    main_shards = [entry for entry in include if not entry["name"].startswith("compat")]
    assert all(entry.get("browser") == "chromium" for entry in main_shards), (
        f"every main shard must install Chromium: {main_shards}"
    )
    declared_browsers = {entry.get("browser") for entry in include}
    assert declared_browsers <= set(COMPAT_ENGINES), (
        f"matrix declares an unknown browser engine: {declared_browsers}"
    )
    steps = _frontend_e2e_steps()
    runner_steps = [
        step for step in steps if str(step.get("run", "")).strip() == "${{ matrix.command }}"
    ]
    assert len(runner_steps) == 1, f"expected one matrix command step, got {runner_steps}"
    runner = runner_steps[0]
    assert "if" not in runner, "the browser suite runner must not be conditional"
    assert not runner.get("continue-on-error"), "the browser suite runner must fail its cell"
    assert "continue-on-error" not in job, f"{CI_SUITES_JOB} must fail the build"

    install_runs = [
        str(step.get("run", "")) for step in steps if _INSTALL_RE.search(str(step.get("run", "")))
    ]
    assert len(install_runs) == 1, f"expected one browser install step, got {install_runs}"
    browser_expression = "${{ matrix.browser }}"
    assert install_runs[0].count(browser_expression) == 1, (
        f"browser install must use exactly one matrix.browser value: {install_runs[0]!r}"
    )
    installed_runs = [
        install_runs[0].replace(browser_expression, entry["browser"]) for entry in include
    ]
    assert all("${{" not in run for run in installed_runs), (
        f"browser install has an unresolved workflow expression: {installed_runs}"
    )
    installed = set().union(*(installed_engines(run) for run in installed_runs))
    assert installed <= set(COMPAT_ENGINES), f"browser install names an unknown engine: {installed}"
    engines_with_pass = {
        ENGINE_COLUMNS[column]
        for record in _matrix().records()
        for column in ENGINE_COLUMNS
        if record[column] == PASS
    }
    assert engines_with_pass <= installed, (
        f"{engines_with_pass - installed} have a Pass cell but {CI_SUITES_JOB} never installs them"
    )


def test_ci_uploads_only_native_playwright_failure_diagnostics() -> None:
    steps = _frontend_e2e_steps()
    uploads = [
        step for step in steps if step.get("name") == "Upload Playwright traces from failed specs"
    ]
    assert len(uploads) == 1
    upload = uploads[0]
    diagnostic_globs = [
        "gui/web/test-results/**/trace.zip",
        "gui/web/test-results/**/error-context.md",
    ]
    assert upload["if"] == (
        f"always() && hashFiles('{diagnostic_globs[0]}', '{diagnostic_globs[1]}') != ''"
    )
    assert upload["uses"] == "actions/upload-artifact@v7"
    artifact = upload["with"]
    assert artifact["name"] == "playwright-test-results-${{ matrix.name }}"
    assert artifact["path"].splitlines() == diagnostic_globs
    assert artifact["retention-days"] == 7
    assert artifact["if-no-files-found"] == "ignore"


def test_pull_requests_run_every_webkit_compat_spec_in_complete_shards() -> None:
    include = planned_include("pull_request", ("gui/web/src/App.tsx",))
    compat = [entry for entry in include if entry["name"].startswith("compat")]
    assert [entry["name"] for entry in include if entry not in compat] == [
        entry["name"] for entry in planned_include("push") if not entry["name"].startswith("compat")
    ]
    shard_re = re.compile(rf"^{COMPAT_COMMAND} -- --project=webkit --shard=(\d+)/(\d+)$")
    shards = [shard_re.match(entry["command"]) for entry in compat]
    assert all(shards), f"PR compat must shard the complete WebKit project: {compat}"
    count = int(shards[0][2]) if shards[0] else 0
    assert count > 1
    assert [(int(m[1]), int(m[2])) for m in shards if m] == [
        (i, count) for i in range(1, count + 1)
    ]
    assert [entry["name"] for entry in compat] == [
        f"compat-webkit-{i}of{count}" for i in range(1, count + 1)
    ]
    assert {entry["browser"] for entry in compat} == {"webkit"}


def test_ci_compat_inventory_has_no_missing_or_duplicate_cases() -> None:
    engines = compat_ci_engines(planned_include("push"))
    projects = compat_projects(COMPAT_CONFIG.read_text(encoding="utf-8"))
    checks = [
        (spec, check) for spec, source in compat_specs().items() for check in spec_checks(source)
    ]
    assert_compat_omissions(projects)
    expected = {
        (engine, spec, check)
        for engine in COMPAT_ENGINES
        for spec, check in checks
        if not (engine == "chromium" and spec in CHROMIUM_MAIN_OWNERS)
    }
    selected = [
        (engine, spec, check)
        for engine in engines
        for spec, check in checks
        if runs_on(spec, engine, projects)
    ]
    assert len(selected) == len(set(selected)), "compat jobs duplicate engine/check pairs"
    assert set(selected) == expected, "compat jobs omit engine/check pairs"
    config = COMPAT_CONFIG.read_text(encoding="utf-8")
    assert re.search(r"\bworkers:\s*1\s*,", config)
    assert re.search(r"\bfullyParallel:\s*false\s*,", config)


def test_chromium_omissions_keep_exact_main_helpers_and_profiles() -> None:
    sources = {
        path: (REPO_ROOT / path).read_text(encoding="utf-8")
        for path in {
            *CHROMIUM_MAIN_OWNERS,
            *(owner["main_spec"] for owner in CHROMIUM_MAIN_OWNERS.values()),
            "gui/web/e2e/theme.ts",
            "gui/web/e2e/commentUndo.ts",
        }
    }
    assert_main_ownership(sources)
    for owner in CHROMIUM_MAIN_OWNERS.values():
        changed = {
            **sources,
            owner["main_spec"]: sources[owner["main_spec"]].replace(owner["call"], ""),
        }
        with pytest.raises(AssertionError):
            assert_main_ownership(changed)
    changed = {
        **sources,
        "gui/web/e2e/theme.ts": sources["gui/web/e2e/theme.ts"].replace(
            'theme: "dark"', 'theme: "light"'
        ),
    }
    with pytest.raises(AssertionError):
        assert_main_ownership(changed)


@pytest.mark.parametrize("spec", sorted(compat_specs()))
@pytest.mark.parametrize("engine", COMPAT_ENGINES)
def test_compat_ownership_rejects_every_unmapped_omission(spec: str, engine: str) -> None:
    projects = compat_projects(COMPAT_CONFIG.read_text(encoding="utf-8"))
    glob = f"**/{Path(spec).name}"
    if engine == "chromium" and spec in CHROMIUM_MAIN_OWNERS:
        projects[engine].remove(glob)
    else:
        projects[engine].append(glob)
    with pytest.raises(AssertionError, match="closed main ownership map"):
        assert_compat_omissions(projects)


@pytest.mark.parametrize("glob", ["**/unknown.spec.ts", "**/comment-undo.spec.ts"])
def test_compat_ownership_rejects_unknown_and_duplicate_ignores(glob: str) -> None:
    projects = compat_projects(COMPAT_CONFIG.read_text(encoding="utf-8"))
    projects["chromium"].append(glob)
    with pytest.raises(AssertionError, match="closed main ownership map"):
        assert_compat_omissions(projects)


@pytest.mark.parametrize(
    "commands",
    [
        [],
        ["chromium"],
        ["webkit"],
        ["chromium", "chromium", "webkit"],
        ["chromium", "webkit --grep history"],
        ["chromium --shard=1/2", "webkit"],
    ],
)
def test_ci_compat_selection_rejects_missing_duplicate_or_filtered_engines(
    commands: list[str],
) -> None:
    include = [
        {
            "name": f"compat-{engine}",
            "command": f"{COMPAT_COMMAND} -- --project={engine}",
            "browser": engine,
        }
        for engine in commands
    ]
    with pytest.raises(AssertionError, match="each complete engine exactly once"):
        compat_ci_engines(include)


@pytest.mark.parametrize(
    ("plan_result", "gui", "suite_result", "expected_returncode"),
    [
        ("success", "true", "success", 0),
        ("success", "true", "failure", 1),
        ("success", "true", "cancelled", 1),
        ("success", "true", "skipped", 1),
        ("success", "false", "skipped", 0),
        ("success", "false", "success", 1),
        ("failure", "", "skipped", 1),
        ("cancelled", "", "skipped", 1),
        ("skipped", "", "skipped", 1),
        ("", "false", "skipped", 1),
        ("unknown", "false", "skipped", 1),
        ("success", "", "skipped", 1),
        ("success", "unknown", "skipped", 1),
        ("success", "TRUE", "skipped", 1),
        ("success", "null", "skipped", 1),
        ("success", "true", "", 1),
        ("success", "true", "unknown", 1),
        ("success", "false", "", 1),
        ("success", "false", "unknown", 1),
        ("success", "false", "failure", 1),
        ("success", "false", "cancelled", 1),
        ("failure", "true", "success", 1),
        ("cancelled", "true", "success", 1),
        ("skipped", "true", "success", 1),
    ],
)
@pytest.mark.parametrize(
    ("gate_name", "suite_name"),
    [("frontend", "frontend-suite"), (CI_GATE_JOB, CI_SUITES_JOB)],
)
def test_ci_gate_requires_the_plan_and_every_planned_suite(
    plan_result: str,
    gui: str,
    suite_result: str,
    expected_returncode: int,
    gate_name: str,
    suite_name: str,
) -> None:
    gate = load_github_yaml(WORKFLOW)["jobs"][gate_name]
    assert gate["needs"] == ["changes", suite_name]
    assert gate["if"] == "always()"
    assert not gate.get("continue-on-error"), f"{CI_GATE_JOB} must fail the build"
    (step,) = gate["steps"]
    assert "if" not in step
    assert not step.get("continue-on-error")
    assert step["shell"] == "bash"
    assert step["env"] == {
        "PLAN": "${{ needs.changes.result }}",
        "GUI": "${{ needs.changes.outputs.gui }}",
        "SUITES": "${{ needs." + suite_name + ".result }}",
    }
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", str(step["run"])],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "PLAN": plan_result, "GUI": gui, "SUITES": suite_result},
    )
    assert result.returncode == expected_returncode, result.stderr


def test_areas_cover_every_issue_30_concern_on_chromium_and_webkit() -> None:
    records = _matrix().records()
    for record in records:
        assert record["Area"] in AREAS, f"unknown Area {record['Area']!r} in {record}"

    covered = {
        record["Area"]
        for record in records
        if record["Chromium (Chrome)"] == PASS and record["WebKit (Safari)"] == PASS
    }
    missing = ISSUE_30_AREAS - covered
    assert not missing, f"{missing} have no row passing on both Chromium and WebKit"


def test_spec_checks_prefer_steps_over_test_titles() -> None:
    walks = """
    test("walks", async ({ page }) => {
      await test.step("record: go", async () => {});
      await test.step(
        "share: play",
        async () => {},
      );
    });
    """
    assert spec_checks(walks) == ["record: go", "share: play"]

    grouped = """
    test.describe("group", () => {
      test(
        "plays",
        async ({ page }) => {},
      );
    });
    """
    assert spec_checks(grouped) == ["plays"]

    mixed = """
    test("walks", async ({ page }) => {
      await test.step("record: go", async () => {});
    });
    test("new smoke check", async ({ page }) => {});
    """
    with pytest.raises(AssertionError, match="exactly one test"):
        spec_checks(mixed)


def test_compat_projects_reads_names_and_test_ignore() -> None:
    config = (
        "const projects = [\n"
        '  { name: "chromium", use: {} },\n'
        '  { name: "webkit", testIgnore: ["**/core-flow.spec.ts"], use: {} },\n'
        "];\n"
        "export default defineConfig({ projects });\n"
    )
    projects = compat_projects(config)
    assert projects == {"chromium": [], "webkit": ["**/core-flow.spec.ts"]}

    spec = "gui/web/e2e-compat/core-flow.spec.ts"
    assert runs_on(spec, "chromium", projects) is True
    assert runs_on(spec, "webkit", projects) is False
    assert runs_on(spec, "firefox", projects) is False


def test_compat_projects_rejects_an_unreadable_test_ignore() -> None:
    top_level = (
        'const projects = [{ name: "chromium", use: {} }];\n'
        "export default defineConfig({\n"
        "  projects,\n"
        '  testIgnore: ["**/core-flow.spec.ts"],\n'
        "});\n"
    )
    with pytest.raises(AssertionError, match="testIgnore"):
        compat_projects(top_level)

    regex_literal = (
        "const projects = [\n"
        '  { name: "webkit", testIgnore: /core-flow/, use: {} },\n'
        "];\n"
        "export default defineConfig({ projects });\n"
    )
    with pytest.raises(AssertionError, match="testIgnore"):
        compat_projects(regex_literal)

    segment_glob = (
        "const projects = [\n"
        '  { name: "webkit", testIgnore: ["*.spec.ts"], use: {} },\n'
        "];\n"
        "export default defineConfig({ projects });\n"
    )
    with pytest.raises(AssertionError, match="testIgnore glob"):
        compat_projects(segment_glob)

    bracket_glob = (
        "const projects = [\n"
        '  { name: "webkit", testIgnore: ["**/[a-c]*.spec.ts"], use: {} },\n'
        "];\n"
        "export default defineConfig({ projects });\n"
    )
    with pytest.raises(AssertionError, match="testIgnore glob"):
        compat_projects(bracket_glob)

    non_literal_entry = (
        "const projects = [\n"
        '  { name: "webkit", testIgnore: ["**/core-flow.spec.ts", ignored], use: {} },\n'
        "];\n"
        "export default defineConfig({ projects });\n"
    )
    with pytest.raises(AssertionError, match="testIgnore list"):
        compat_projects(non_literal_entry)


def test_installed_engines_reads_the_playwright_install_line() -> None:
    assert installed_engines("npm ci\nnpx playwright install --with-deps chromium webkit\n") == {
        "chromium",
        "webkit",
    }
    assert installed_engines("npm ci") == set()


def test_skip_regex_flags_every_skip_form() -> None:
    for flagged in (
        "test.skip(",
        "test.fixme()",
        "test.describe.skip(",
        "test.only(",
        "test.fail(",
    ):
        assert _SKIP_RE.search(flagged), flagged
    for allowed in ("test.step(", "test.slow()", "test.describe("):
        assert _SKIP_RE.search(allowed) is None, allowed
