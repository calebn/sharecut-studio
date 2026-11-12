"""The web app's copy holds no new "Never say" phrase (#3123 item 7, ``scripts/check_terminology.py``)."""

from __future__ import annotations

from pathlib import Path

import pytest

from script_loader import load_script

lint = load_script("check_terminology")

TABLE = """\
## Terminology

| Term | Meaning | Never say |
|---|---|---|
| Review link | Async share | "share link"; "Run pipeline", "Start" |
| Record room | Live room | "session link", "call" |
| Comment here | Starts a draft | "Add comment" in the create menu |
| Land | Finish | "save" (a recording is "Saved to project"; Land places it) |
| Broken | short row |

## Next
| Term | Meaning | Never say |
| Other | x | "should not be read here" |
"""


def _src(tmp_path: Path, name: str, body: str) -> Path:
    path = tmp_path / "gui" / "web" / "src" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def test_the_copy_holds_no_phrase_beyond_the_baseline() -> None:
    assert lint.main([]) == 0


def test_only_quoted_multi_word_phrases_of_the_terminology_table_are_read(tmp_path: Path) -> None:
    doc = tmp_path / "doc.md"
    doc.write_text(TABLE, encoding="utf-8")
    assert lint.never_say_phrases(doc, minimum=1) == {
        "share link": "Review link",
        "run pipeline": "Review link",
        "session link": "Record room",
        "add comment": "Comment here",
    }


def test_a_table_that_yields_too_few_phrases_stops_the_check(tmp_path: Path) -> None:
    doc = tmp_path / "doc.md"
    doc.write_text(TABLE, encoding="utf-8")
    with pytest.raises(SystemExit, match="fewer than"):
        lint.never_say_phrases(doc)
    doc.write_text("# no table", encoding="utf-8")
    with pytest.raises(SystemExit, match="no '## Terminology'"):
        lint.never_say_phrases(doc)


def test_text_is_counted_in_literals_and_jsx_but_not_in_imports_tests_or_stories(
    tmp_path: Path,
) -> None:
    _src(
        tmp_path,
        "View.tsx",
        'import x from "./share link";\n'
        'const a = "Copy the Share Link";\n'
        "const b = `open the share link ${id}`;\n"
        "const c = <p>Your share link is ready</p>;\n"
        'const d = "a shared linkage";\n',
    )
    _src(tmp_path, "View.test.tsx", 'const t = "share link";\n')
    _src(tmp_path, "View.stories.tsx", 'const t = "share link";\n')
    _src(tmp_path, "types.generated.ts", 'const t = "share link";\n')
    _src(tmp_path, "test/helper.ts", 'const t = "share link";\n')
    counts = lint.scan(tmp_path, {"share link": "Review link"})
    assert counts == {"share link|gui/web/src/View.tsx": 3}


def test_a_new_hit_and_a_stale_allowance_are_both_reported() -> None:
    phrases = {"share link": "Review link"}
    messages = list(
        lint.problems(
            {"share link|gui/web/src/A.tsx": 2, "share link|gui/web/src/C.tsx": 1},
            {"share link|gui/web/src/A.tsx": 1, "share link|gui/web/src/B.tsx": 1},
            phrases,
        )
    )
    assert len(messages) == 3
    assert "A.tsx" in messages[0] and "2 time(s), 1 allowed" in messages[0]
    assert "B.tsx" in messages[1] and "lower the baseline" in messages[1]
    assert "C.tsx" in messages[2] and "Review link" in messages[2]


def test_write_then_load_round_trips(tmp_path: Path) -> None:
    path = tmp_path / "baseline.json"
    lint.write_baseline({"b|f": 2, "a|f": 1}, path)
    assert lint.load_baseline(path) == {"a|f": 1, "b|f": 2}


def test_a_phrase_in_parentheses_is_an_example_and_a_short_row_is_skipped(tmp_path: Path) -> None:
    doc = tmp_path / "doc.md"
    doc.write_text(TABLE, encoding="utf-8")
    phrases = lint.never_say_phrases(doc, minimum=1)
    assert "saved to project" not in phrases
    assert "Land" not in phrases.values()


def test_comments_and_mid_word_matches_are_not_copy(tmp_path: Path) -> None:
    _src(
        tmp_path,
        "View.tsx",
        "// the share link in a comment\n"
        "/* share link\n   again */\n"
        'const url = "https://x.test/share link";\n'
        'const a = "reshare link";\n',
    )
    counts = lint.scan(tmp_path, {"share link": "Review link"})
    assert counts == {"share link|gui/web/src/View.tsx": 1}


def test_a_test_folder_above_the_checkout_does_not_hide_the_source(tmp_path: Path) -> None:
    root = tmp_path / "test" / "checkout"
    _src(root, "View.tsx", 'const a = "share link";\n')
    assert lint.scan(root, {"share link": "Review link"}) == {"share link|gui/web/src/View.tsx": 1}


def test_main_exits_on_a_new_hit_and_write_rewrites_the_baseline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    doc = tmp_path / "doc.md"
    doc.write_text(TABLE, encoding="utf-8")
    baseline = tmp_path / "baseline.json"
    lint.write_baseline({}, baseline)
    _src(tmp_path, "View.tsx", 'const a = "share link";\n')
    monkeypatch.setattr(lint, "ROOT", tmp_path)
    monkeypatch.setattr(lint, "TABLE_DOC", doc)
    monkeypatch.setattr(lint, "BASELINE", baseline)
    monkeypatch.setattr(lint, "MIN_PHRASES", 1)
    monkeypatch.setattr(lint, "never_say_phrases", lambda: {"share link": "Review link"})
    assert lint.main([]) == 1
    assert "View.tsx" in capsys.readouterr().err
    assert lint.main(["--write"]) == 0
    assert lint.load_baseline(baseline) == {"share link|gui/web/src/View.tsx": 1}
    assert lint.main([]) == 0
