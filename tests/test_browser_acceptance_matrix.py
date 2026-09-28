"""Guard the browser acceptance matrix in docs/testing.md against drift.

A "Pass" cell claims the required `frontend-e2e` job runs that check on that
engine with no retry and no skip, so a green `main` means it passed; "Not run"
means no compat project runs it. Rows and cells are derived from the specs in
gui/web/e2e-compat/, playwright.compat.config.ts and the CI workflow.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from github_yaml import load_github_yaml
from markdown_table import MarkdownTable, code_spans, section_table

REPO_ROOT = Path(__file__).parents[1]
TESTING_DOC = REPO_ROOT / "docs" / "testing.md"
HEADING = "### Browser acceptance matrix"
COMPAT_DIR = REPO_ROOT / "gui" / "web" / "e2e-compat"
COMPAT_CONFIG = REPO_ROOT / "gui" / "web" / "playwright.compat.config.ts"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "test.yml"
CI_JOB = "frontend-e2e"
COMPAT_COMMAND = "npm run test:e2e:compat"

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
    job = load_github_yaml(WORKFLOW)["jobs"][CI_JOB]
    assert not job.get("continue-on-error"), f"{CI_JOB} must fail the build"
    return job["steps"]


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

    missing = sorted(set(expected) - set(documented))
    stale = sorted(set(documented) - set(expected))
    assert set(documented) == set(expected), (
        f"missing={missing} stale={stale}; update docs/testing.md § Browser acceptance matrix"
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
    assert _RETRIES_RE.findall(config) == ["0"], "playwright.compat.config.ts must set retries: 0"
    assert _UNSUPPORTED_FILTER_RE.search(config) is None, (
        "playwright.compat.config.ts filters tests with testMatch/grep/grepInvert"
    )


def test_ci_runs_the_compat_matrix_on_every_passing_engine() -> None:
    steps = _frontend_e2e_steps()
    compat_steps = [step for step in steps if str(step.get("run", "")).strip() == COMPAT_COMMAND]
    assert len(compat_steps) == 1, (
        f"expected exactly one {COMPAT_COMMAND!r} step, got {compat_steps}"
    )
    step = compat_steps[0]
    assert not step.get("continue-on-error"), f"{COMPAT_COMMAND} must not continue-on-error"
    assert "if" not in step, f"{COMPAT_COMMAND} must not be conditional"

    installed = set().union(*(installed_engines(str(step.get("run", ""))) for step in steps))
    engines_with_pass = {
        ENGINE_COLUMNS[column]
        for record in _matrix().records()
        for column in ENGINE_COLUMNS
        if record[column] == PASS
    }
    assert engines_with_pass <= installed, (
        f"{engines_with_pass - installed} have a Pass cell but frontend-e2e never installs them"
    )


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
