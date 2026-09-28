"""scripts/docs_sync.py: contract parsing, glob matching, evaluate, render, table --check."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
ds = load_script("docs_sync", register=True)


def make_rule(
    rule_id: str,
    *,
    docs: tuple[str, ...] = (),
    gate: tuple[str, ...] = (),
    advisory: tuple[str, ...] | None = (),
    exclude: tuple[str, ...] = (),
):
    """Build a Rule with a one-word when/update cell, for tests that don't care about
    verbatim table text. Pass gate=(...) or advisory=(...) / advisory=None."""
    if gate:
        enforcement = ds.Gate(
            trigger=ds.Trigger(
                include=tuple(ds.Glob.parse(g) for g in gate),
                exclude=tuple(ds.Glob.parse(g) for g in exclude),
            )
        )
    elif advisory is None:
        enforcement = ds.Advisory(trigger=None)
    elif advisory:
        enforcement = ds.Advisory(
            trigger=ds.Trigger(
                include=tuple(ds.Glob.parse(g) for g in advisory),
                exclude=tuple(ds.Glob.parse(g) for g in exclude),
            )
        )
    else:
        raise AssertionError("pass gate=... or advisory=...")
    return ds.Rule(
        id=rule_id,
        when=f"{rule_id} when",
        update=f"{rule_id} update",
        docs=tuple(ds.Glob.parse(g) for g in docs),
        enforcement=enforcement,
    )


# ---------------------------------------------------------------- Glob


@pytest.mark.parametrize(
    ("pattern", "path", "expected"),
    [
        ("ux/pages/", "ux/pages/a/b.md", True),
        ("gui/web/src/*.ts", "gui/web/src/a/b.ts", False),
        ("**/*.test.*", "StatusBar.test.tsx", True),
        ("**/*.test.*", "gui/web/src/layout/StatusBar.test.tsx", True),
        ("gui/web/src/ui/BottomSheet*", "gui/web/src/ui/BottomSheet.tsx", True),
        ("docs/setup.md", "docs/setup.md.bak", False),
    ],
)
def test_glob_table(pattern: str, path: str, expected: bool) -> None:
    assert ds.Glob.parse(pattern).matches(path) is expected


def test_glob_rejects_absolute_and_relative_and_backslash() -> None:
    for bad in ("/abs/path", "./rel", "a\\b"):
        with pytest.raises(ds.ContractError):
            ds.Glob.parse(bad)


# ---------------------------------------------------------------- parse_contract


def test_parse_contract_duplicate_id() -> None:
    raw = {
        "api_version": 1,
        "rules": [
            {"id": "x", "when": "a", "update": "b", "docs": ["c"], "advisory": None},
            {"id": "x", "when": "a", "update": "b", "docs": ["c"], "advisory": None},
        ],
    }
    with pytest.raises(ds.ContractError, match="duplicate id"):
        ds.parse_contract(raw)


def test_parse_contract_gate_and_advisory_both_present() -> None:
    raw = {
        "api_version": 1,
        "rules": [
            {
                "id": "x",
                "when": "a",
                "update": "b",
                "docs": ["c"],
                "gate": {"include": ["c"]},
                "advisory": None,
            }
        ],
    }
    with pytest.raises(ds.ContractError, match="exactly one of gate/advisory"):
        ds.parse_contract(raw)


def test_parse_contract_gate_null_needs_an_include_glob() -> None:
    raw = {
        "api_version": 1,
        "rules": [{"id": "x", "when": "a", "update": "b", "docs": ["c"], "gate": None}],
    }
    with pytest.raises(ds.ContractError, match="gate must be an object"):
        ds.parse_contract(raw)


def test_parse_contract_wrong_api_version() -> None:
    with pytest.raises(ds.ContractError, match="api_version"):
        ds.parse_contract({"api_version": 2, "rules": []})


def test_parse_contract_advisory_row_has_no_trigger() -> None:
    raw = {
        "api_version": 1,
        "rules": [{"id": "x", "when": "a", "update": "b", "docs": ["c"], "advisory": None}],
    }
    contract = ds.parse_contract(raw)
    assert isinstance(contract.rules[0].enforcement, ds.Advisory)
    assert contract.rules[0].enforcement.trigger is None


# ---------------------------------------------------------------- evaluate


def test_evaluate_gate_violated() -> None:
    contract = ds.Contract(
        ignore=(),
        rules=(make_rule("ux-pack", docs=("ux/pages/",), gate=("docs/ui-philosophy.md",)),),
    )
    change = ds.Change(label="range", files=("docs/ui-philosophy.md",))
    report = ds.evaluate(contract, change)
    assert len(report.findings) == 1
    finding = report.findings[0]
    assert finding.outcome == "violated"
    assert finding.triggered_by == ("docs/ui-philosophy.md",)
    assert finding.satisfied_by == ()
    assert report.blocking is True


def test_evaluate_gate_satisfied() -> None:
    contract = ds.Contract(
        ignore=(),
        rules=(make_rule("ux-pack", docs=("ux/pages/",), gate=("docs/ui-philosophy.md",)),),
    )
    change = ds.Change(label="range", files=("docs/ui-philosophy.md", "ux/pages/brief.md"))
    report = ds.evaluate(contract, change)
    finding = report.findings[0]
    assert finding.outcome == "satisfied"
    assert finding.satisfied_by == ("ux/pages/brief.md",)
    assert report.blocking is False


def test_evaluate_self_satisfaction_excluded() -> None:
    contract = ds.Contract(
        ignore=(),
        rules=(make_rule("docs-rule", docs=("docs/",), gate=("docs/session-sync.md",)),),
    )
    change = ds.Change(label="range", files=("docs/session-sync.md",))
    report = ds.evaluate(contract, change)
    assert report.findings[0].outcome == "violated"


def test_evaluate_ignore_and_exclude() -> None:
    contract = ds.Contract(
        ignore=(ds.Glob.parse("**/*.test.*"),),
        rules=(
            make_rule("a", docs=("docs/a.md",), gate=("gui/web/src/layout/",)),
            make_rule(
                "b",
                docs=("docs/b.md",),
                gate=("src/",),
                exclude=("src/pkg/_version.py",),
            ),
        ),
    )
    change = ds.Change(label="r", files=("gui/web/src/layout/StatusBar.test.tsx",))
    assert ds.evaluate(contract, change).findings == ()

    change = ds.Change(label="r", files=("src/pkg/_version.py",))
    assert ds.evaluate(contract, change).findings == ()


def test_evaluate_waiver_with_reason() -> None:
    contract = ds.Contract(
        ignore=(),
        rules=(make_rule("ux-pack", docs=("ux/pages/",), gate=("docs/ui-philosophy.md",)),),
    )
    waiver = ds.Waiver(rule_id="ux-pack", reason="relay-only fix", commit="f3a2d74")
    change = ds.Change(label="r", files=("docs/ui-philosophy.md",), waivers=(waiver,))
    report = ds.evaluate(contract, change)
    assert report.findings[0].outcome == "waived"
    assert report.problems == ()
    assert report.blocking is False


def test_evaluate_legacy_waiver_without_reason_is_a_problem() -> None:
    contract = ds.Contract(
        ignore=(),
        rules=(make_rule("ux-pack", docs=("ux/pages/",), gate=("docs/ui-philosophy.md",)),),
    )
    waiver = ds.Waiver(rule_id="ux-pack", reason=None, commit="f3a2d74")
    change = ds.Change(label="r", files=("docs/ui-philosophy.md",), waivers=(waiver,))
    report = ds.evaluate(contract, change)
    assert report.findings[0].outcome == "waived"
    assert report.problems == (
        "ux-pack: waived without a reason in f3a2d74 ([skip ux-pack]); "
        "write `Docs-Sync-Waive: ux-pack <reason>`",
    )
    assert report.blocking is True


def test_evaluate_unknown_waiver_id_is_a_problem() -> None:
    contract = ds.Contract(
        ignore=(),
        rules=(make_rule("ux-pack", docs=("ux/pages/",), gate=("docs/ui-philosophy.md",)),),
    )
    waiver = ds.Waiver(rule_id="ux-pak", reason="x", commit="abc1234")
    change = ds.Change(label="r", files=("docs/ui-philosophy.md",), waivers=(waiver,))
    report = ds.evaluate(contract, change)
    assert report.problems == ("abc1234: Docs-Sync-Waive names unknown rule 'ux-pak'",)


def test_evaluate_advisory_fired_reports_without_blocking() -> None:
    contract = ds.Contract(
        ignore=(),
        rules=(make_rule("py-deps", docs=("docs/setup.md",), advisory=("pyproject.toml",)),),
    )
    change = ds.Change(label="r", files=("pyproject.toml",))
    report = ds.evaluate(contract, change)
    assert report.findings[0].outcome == "advisory"
    assert report.blocking is False


def test_evaluate_advisory_with_no_trigger_never_fires() -> None:
    contract = ds.Contract(ignore=(), rules=(make_rule("contributor-workflow", advisory=None),))
    change = ds.Change(label="r", files=("docs/contributing.md", "AGENTS.md"))
    assert ds.evaluate(contract, change).findings == ()


# ---------------------------------------------------------------- parse_waivers


def test_parse_waivers() -> None:
    log = (
        "f3a2d74\x00fix: relay pool\n\nDocs-Sync-Waive: ux-pack relay-only fix\n\x1e"
        "22b10d3\x00fix: pipeline lock [skip ux-pack]\n\x1e"
        "9cf1296\x00chore: x\n\nDocs-Sync-Waive: ux-pack\n\x1e"
    )
    waivers = ds.parse_waivers(log)
    assert waivers == (
        ds.Waiver(rule_id="ux-pack", reason="relay-only fix", commit="f3a2d74"),
        ds.Waiver(rule_id="ux-pack", reason=None, commit="22b10d3"),
        ds.Waiver(rule_id="ux-pack", reason=None, commit="9cf1296"),
    )


# ---------------------------------------------------------------- check --range / --staged (git-backed)


def _git(repo: Path, *args: str) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
    }
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True, env=env
    ).stdout


def _write(repo: Path, rel: str, text: str = "x\n") -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


_ONE_RULE_CONTRACT = json.dumps(
    {
        "api_version": 1,
        "rules": [
            {
                "id": "ux-pack",
                "when": "UX onboarding pack",
                "update": "`ux/pages/`",
                "docs": ["ux/pages/"],
                "gate": {"include": ["docs/ui-philosophy.md"]},
            }
        ],
    }
)


@pytest.fixture
def check_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    _git(tmp_path, "init", "-q", "-b", "base")
    _write(tmp_path, "contracts/docs-sync.json", _ONE_RULE_CONTRACT)
    _write(tmp_path, "docs/ui-philosophy.md")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    _git(tmp_path, "checkout", "-qb", "feature")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_check_range_violated_then_satisfied(check_repo: Path) -> None:
    _write(check_repo, "docs/ui-philosophy.md", "changed\n")
    _git(check_repo, "add", "docs/ui-philosophy.md")
    _git(check_repo, "commit", "-qm", "docs: tweak philosophy")
    assert ds.main(["check", "--range", "base...HEAD"]) == 1

    _write(check_repo, "ux/pages/brief.md")
    _git(check_repo, "add", "ux/pages/brief.md")
    _git(check_repo, "commit", "-qm", "docs: add ux page")
    assert ds.main(["check", "--range", "base...HEAD"]) == 0


def test_check_range_waiver_trailer_passes(
    check_repo: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(check_repo, "docs/ui-philosophy.md", "changed\n")
    _git(check_repo, "add", "docs/ui-philosophy.md")
    _git(
        check_repo,
        "commit",
        "-qm",
        "docs: tweak philosophy\n\nDocs-Sync-Waive: ux-pack relay-only fix",
    )
    assert ds.main(["check", "--range", "base...HEAD"]) == 0
    assert "waived    ux-pack" in capsys.readouterr().out


def test_check_range_legacy_waiver_is_a_problem_and_still_fails(check_repo: Path) -> None:
    _write(check_repo, "docs/ui-philosophy.md", "changed\n")
    _git(check_repo, "add", "docs/ui-philosophy.md")
    _git(check_repo, "commit", "-qm", "docs: tweak philosophy [skip ux-pack]")
    assert ds.main(["check", "--range", "base...HEAD"]) == 1


def test_check_range_judges_the_pr_against_its_own_head_contract(check_repo: Path) -> None:
    """A PR that adds a new rule is checked against that rule, not the base contract."""
    two_rule_contract = json.loads(_ONE_RULE_CONTRACT)
    two_rule_contract["rules"].append(
        {
            "id": "new-rule",
            "when": "New thing",
            "update": "`docs/new.md`",
            "docs": ["docs/new.md"],
            "gate": {"include": ["src/new.py"]},
        }
    )
    _write(check_repo, "contracts/docs-sync.json", json.dumps(two_rule_contract))
    _write(check_repo, "src/new.py")
    _git(check_repo, "add", ".")
    _git(check_repo, "commit", "-qm", "feat: new thing, undocumented")
    assert ds.main(["check", "--range", "base...HEAD"]) == 1


def test_check_staged_reads_the_index_and_always_exits_zero(check_repo: Path) -> None:
    _write(check_repo, "docs/ui-philosophy.md", "changed\n")
    _git(check_repo, "add", "docs/ui-philosophy.md")
    assert ds.main(["check", "--staged"]) == 0  # warn only, never blocks the commit


def test_check_staged_never_blocks_on_a_broken_contract(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Any failure reading/parsing the contract (or the git state around it) is a warning
    on stderr, not a blocked commit. `check --range` (the CI gate) keeps failing loudly."""
    _git(tmp_path, "init", "-q", "-b", "base")
    _write(tmp_path, "contracts/docs-sync.json", "not valid json")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    _write(tmp_path, "x")
    _git(tmp_path, "add", "x")
    monkeypatch.chdir(tmp_path)

    assert ds.main(["check", "--staged"]) == 0
    assert "docs-sync (warn):" in capsys.readouterr().err


# ---------------------------------------------------------------- render_table / splice_table


def test_render_table_is_literal_and_compact() -> None:
    """Cells are stored trimmed; render_table emits a compact table (no column padding)."""
    contract = ds.Contract(
        ignore=(),
        rules=(
            ds.Rule(
                id="mix-docs",
                when="Mix levels in services",
                update="`docs/mix.md`",
                docs=(ds.Glob.parse("docs/mix.md"),),
                enforcement=ds.Advisory(trigger=None),
            ),
            ds.Rule(
                id="waveform",
                when="Waveform pyramid / renderer / tiles",
                update="`docs/waveform.md`, `contracts/timeline-zoom.json`",
                docs=(ds.Glob.parse("docs/waveform.md"),),
                enforcement=ds.Advisory(trigger=None),
            ),
        ),
    )
    table = ds.render_table(contract)
    assert table == (
        "| When you change… | Update… |\n"
        "| --- | --- |\n"
        "| Mix levels in services | `docs/mix.md` |\n"
        "| Waveform pyramid / renderer / tiles "
        "| `docs/waveform.md`, `contracts/timeline-zoom.json` |"
    )


def test_splice_table_round_trip() -> None:
    table = "| When you change… | Update… |\n| --- | --- |\n| a | b |"
    agents_md = f"before\n\n{ds.BEGIN}\nstale\n{ds.END}\n\nafter\n"
    spliced = ds.splice_table(agents_md, table)
    assert spliced == f"before\n\n{ds.BEGIN}\n{table}\n{ds.END}\n\nafter\n"
    # Idempotent: splicing the same table again is a no-op.
    assert ds.splice_table(spliced, table) == spliced


def test_splice_table_missing_markers_raises() -> None:
    with pytest.raises(ds.ContractError, match="missing"):
        ds.splice_table("no markers here", "table")


# ---------------------------------------------------------------- real repo


def test_table_check_passes_on_the_real_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(ROOT)
    assert ds.main(["table", "--check"]) == 0


def test_lint_contract_reports_dead_globs_unlisted_and_dead_references() -> None:
    from dataclasses import replace

    rule = replace(
        make_rule("share", docs=("docs/share.md", "docs/moved.md"), advisory=None),
        update="`docs/share.md`, `docs/tokens.md`, `scripts/gone.py`, `prefs.yaml`, `PODCAST_X`",
    )
    tracked = ("docs/share.md", "docs/tokens.md", "scripts/keep.py")
    problems = ds.lint_contract(ds.Contract(ignore=(), rules=(rule,)), tracked)
    assert problems == [
        "docs-sync glob 'docs/moved.md' matches no tracked file",
        "share: update references `docs/tokens.md` but no docs glob matches it",
        "share: update references `scripts/gone.py`, which is not tracked",
    ]


def test_lint_contract_clean_on_the_real_repo() -> None:
    contract = ds.load_contract(None)
    assert ds.lint_contract(contract, ds.tracked_files()) == []
