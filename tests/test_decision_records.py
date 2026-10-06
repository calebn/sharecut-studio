"""scripts/decisions_index.py: decision blocks in docs/ and their generated index."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
di = load_script("decisions_index", register=True)


def block(
    heading: str = "### Decision: Keep it",
    *,
    fields: str = "id: D-keep-it\nstatus: accepted\ndate: 2026-10-06\ndecided-by: calebn\n"
    "enforced-by:\n- make lint\n",
) -> str:
    return f"{heading}\n\n<!-- decision\n{fields}-->\n\nProse.\n"


@pytest.fixture
def repo(tmp_path: Path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_x.py").write_text("def test_keeps_it():\n    pass\n")
    (tmp_path / "tests" / "x.test.ts").write_text('it("keeps it", () => {});\n')
    (tmp_path / "contracts").mkdir()
    (tmp_path / "contracts" / "docs-sync.json").write_text(
        json.dumps({"rules": [{"id": "decision-x"}]})
    )
    (tmp_path / "Makefile").write_text("lint:\n\techo\n")
    return di.Repo.load(tmp_path)


def parse_ok(text: str, doc: str = "docs/a.md"):
    decisions, problems = di.parse_doc(doc, text)
    assert problems == []
    return decisions


# ---------------------------------------------------------------- the real repo


def test_every_decision_block_in_docs_is_valid_and_enforced():
    decisions, problems = di.collect(ROOT)
    problems += di.validate(decisions, di.Repo.load(ROOT))
    assert problems == []
    assert {d.status for d in decisions} >= {"accepted", "superseded"}


def test_the_decision_index_is_current():
    decisions, _ = di.collect(ROOT)
    readme = (ROOT / di.INDEX_PATH).read_text(encoding="utf-8")
    assert di.apply_index(readme, di.render_index(decisions)) == readme, (
        "run `make decisions-index`"
    )


# ---------------------------------------------------------------- parsing


def test_block_fields_heading_and_anchor_are_read():
    text = "# Doc\n\n" + block(
        "### Decision: Share links never expire; the host revokes them",
        fields="id: D-links\nstatus: accepted\ndate: 2026-10-06\ndecided-by: calebn\n"
        'evidence:\n- #80 owner: "Links stay non-expiring"\n- #1038\n'
        "enforcement: pending #1027\n",
    )
    [d] = parse_ok(text)
    assert d == di.Decision(
        id="D-links",
        title="Share links never expire; the host revokes them",
        status="accepted",
        date="2026-10-06",
        decided_by="calebn",
        evidence=('#80 owner: "Links stay non-expiring"', "#1038"),
        enforced_by=(),
        manual_review=None,
        pending=1027,
        supersedes=None,
        superseded_by=None,
        doc="docs/a.md",
        line=3,
        anchor="decision-share-links-never-expire-the-host-revokes-them",
    )


def test_repeated_heading_gets_githubs_numbered_anchor():
    text = "## Decision: Keep it\n\nText.\n\n" + block("## Decision: Keep it")
    [d] = parse_ok(text)
    assert d.anchor == "decision-keep-it-1"


def test_a_block_inside_a_code_fence_is_an_example_not_a_decision():
    assert parse_ok("```markdown\n" + block() + "```\n") == []


@pytest.mark.parametrize(
    ("text", "problem"),
    [
        (
            "Intro.\n\n<!-- decision\nid: D-x\n-->\n",
            "a decision block must directly follow its heading",
        ),
        (block("### Keep it"), "status accepted needs a heading that starts with 'Decision: '"),
        (block(fields="id: D-x\nstatus: accepted\n"), "missing date, decided-by"),
        (
            block(fields="id: x\nstatus: accepted\ndate: 2026-10-06\ndecided-by: c\n"),
            "id 'x' must look like D-kebab-case",
        ),
        (
            block(fields="id: D-x\nstatus: done\ndate: 2026-10-06\ndecided-by: c\n"),
            "status 'done' must be accepted, proposed or superseded",
        ),
        (
            block(fields="id: D-x\nstatus: accepted\ndate: 6 Oct\ndecided-by: c\n"),
            "date '6 Oct' must be YYYY-MM-DD",
        ),
        (
            block(fields="id: D-x\nstatus: accepted\ndate: 2026-10-06\ndecided-by: c\nowner: c\n"),
            "unknown field 'owner'",
        ),
        (
            block(
                fields="id: D-x\nstatus: accepted\ndate: 2026-10-06\ndecided-by: c\nenforcement: later\n"
            ),
            "enforcement must read 'pending #<issue>'",
        ),
        (
            block(
                fields="id: D-x\nstatus: accepted\ndate: 2026-10-06\ndecided-by: c\nevidence:\n- see --flag\n"
            ),
            "'--' cannot appear inside an HTML comment",
        ),
        ("## Decision: X\n<!-- decision\nid: D-x\n", "decision block has no closing -->"),
    ],
)
def test_malformed_blocks_are_reported(text, problem):
    _, problems = di.parse_doc("docs/a.md", text)
    assert [p.split(": ", 1)[1] for p in problems] == [problem]


# ---------------------------------------------------------------- validation


def decision(**overrides):
    base = dict(
        id="D-x",
        title="X",
        status="accepted",
        date="2026-10-06",
        decided_by="calebn",
        evidence=(),
        enforced_by=("make lint",),
        manual_review=None,
        pending=None,
        supersedes=None,
        superseded_by=None,
        doc="docs/a.md",
        line=1,
        anchor="decision-x",
    )
    return di.Decision(**{**base, **overrides})


@pytest.mark.parametrize(
    "enforcement",
    [
        {"enforced_by": ("tests/test_x.py::test_keeps_it",)},
        {"enforced_by": ("tests/x.test.ts::keeps it",)},
        {"enforced_by": ("docs-sync: decision-x",)},
        {"enforced_by": (), "manual_review": "the owner listens before merge"},
        {"enforced_by": (), "pending": 1096},
    ],
)
def test_an_accepted_decision_with_enforcement_passes(repo, enforcement):
    assert di.validate([decision(**enforcement)], repo) == []


def test_an_accepted_decision_without_enforcement_fails(repo):
    assert di.validate([decision(enforced_by=())], repo) == [
        "D-x (docs/a.md:1): an accepted decision needs enforced-by, manual-review "
        "or 'enforcement: pending #<issue>'"
    ]


def test_a_proposed_decision_needs_no_enforcement_but_cannot_be_pending(repo):
    assert di.validate([decision(status="proposed", enforced_by=())], repo) == []
    assert di.validate([decision(status="proposed", enforced_by=(), pending=1078)], repo) == [
        "D-x (docs/a.md:1): only an accepted decision can have pending enforcement"
    ]


@pytest.mark.parametrize(
    ("ref", "reason"),
    [
        ("tests/test_gone.py::test_keeps_it", "test file tests/test_gone.py does not exist"),
        ("tests/test_x.py::test_renamed", "tests/test_x.py has no test named 'test_renamed'"),
        ("tests/test_x.py::test_keeps", "tests/test_x.py has no test named 'test_keeps'"),
        ("tests/x.test.ts::keeps", "tests/x.test.ts has no test named 'keeps'"),
        ("docs-sync: decision-y", "docs-sync rule 'decision-y' is not in contracts/docs-sync.json"),
        ("make gone", "make target 'gone' is not in the Makefile"),
        ("CI", "use 'path::test name', 'docs-sync: <rule-id>' or 'make <target>'"),
    ],
)
def test_an_enforcement_entry_must_name_a_real_check(repo, ref, reason):
    assert di.validate([decision(enforced_by=(ref,))], repo) == [
        f"D-x (docs/a.md:1): enforced-by {ref!r}: {reason}"
    ]


def test_two_blocks_cannot_share_an_id(repo):
    assert di.validate([decision(), decision(doc="docs/b.md", line=9)], repo) == [
        "D-x: used by docs/a.md:1 and docs/b.md:9"
    ]


def test_supersession_links_both_ways_in_one_doc(repo):
    old = decision(id="D-old", status="superseded", enforced_by=(), superseded_by="D-new")
    new = decision(id="D-new", supersedes="D-old")
    assert di.validate([old, new], repo) == []


@pytest.mark.parametrize(
    ("old", "new", "problems"),
    [
        (
            {"superseded_by": None},
            {"supersedes": None},
            ["D-old (docs/a.md:1): status superseded and superseded-by go together"],
        ),
        (
            {},
            {"supersedes": None},
            ["D-old (docs/a.md:1): D-new must name it in supersedes"],
        ),
        (
            {"superseded_by": "D-missing"},
            {},
            [
                "D-old (docs/a.md:1): superseded-by D-missing does not exist",
                "D-new (docs/a.md:1): D-old must name it in superseded-by",
            ],
        ),
        (
            {},
            {"doc": "docs/b.md"},
            ["D-old (docs/a.md:1): keep it in docs/b.md, next to D-new"],
        ),
    ],
)
def test_broken_supersession_is_reported(repo, old, new, problems):
    older = decision(
        **{"id": "D-old", "status": "superseded", "enforced_by": (), "superseded_by": "D-new"} | old
    )
    newer = decision(**{"id": "D-new", "supersedes": "D-old"} | new)
    assert di.validate([older, newer], repo) == problems


# ---------------------------------------------------------------- index


def test_index_rows_link_the_doc_anchor_and_each_issue_once():
    rows = di.render_index(
        [
            decision(
                id="D-b",
                title="B | pipe",
                doc="docs/b.md",
                anchor="decision-b",
                evidence=("#80 owner", "#80 again, #1038"),
                enforced_by=(),
                pending=1027,
            ),
            decision(id="D-a", title="A", doc="docs/sub/a.md", anchor="decision-a"),
        ]
    ).splitlines()
    issue = "https://github.com/calebn/sharecut-studio/issues/"
    assert rows[2:] == [
        f"| `D-b` | [B \\| pipe](../b.md#decision-b) | accepted | 2026-10-06 | "
        f"pending [#1027]({issue}1027) | [#80]({issue}80), [#1038]({issue}1038) |",
        "| `D-a` | [A](../sub/a.md#decision-a) | accepted | 2026-10-06 | 1 check |  |",
    ]


def test_apply_index_replaces_only_the_generated_region():
    readme = f"Intro\n{di.BEGIN}\nold\n{di.END}\nOutro\n"
    assert di.apply_index(readme, "new") == f"Intro\n{di.BEGIN}\nnew\n{di.END}\nOutro\n"


def test_check_fails_on_a_stale_index(tmp_path, monkeypatch, capsys):
    docs = tmp_path / "docs"
    (docs / "decisions").mkdir(parents=True)
    (docs / "a.md").write_text(block())
    (docs / "decisions" / "README.md").write_text(f"{di.BEGIN}\n{di.END}\n")
    (tmp_path / "contracts").mkdir()
    (tmp_path / "contracts" / "docs-sync.json").write_text('{"rules": []}')
    (tmp_path / "Makefile").write_text("lint:\n")
    monkeypatch.setattr(di, "_repo_root", lambda: tmp_path)

    assert di.main(["--check"]) == 1
    assert "docs/decisions/README.md is stale" in capsys.readouterr().err
    assert di.main([]) == 0
    assert di.main(["--check"]) == 0
