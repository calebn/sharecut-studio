"""The web app's copy holds no new "Never say" phrase (#3123 item 7, ``scripts/check_terminology.py``)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "check_terminology", ROOT / "scripts" / "check_terminology.py"
)
assert _SPEC is not None and _SPEC.loader is not None
lint = importlib.util.module_from_spec(_SPEC)
sys.modules["check_terminology"] = lint
_SPEC.loader.exec_module(lint)

TABLE = """\
## Terminology

| Term | Meaning | Never say |
|---|---|---|
| Review link | Async share | "share link"; "Run pipeline", "Start" |
| Record room | Live room | "session link", "call" |
| Comment here | Starts a draft | "Add comment" in the create menu |

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
    assert lint.never_say_phrases(doc) == {
        "share link": "Review link",
        "run pipeline": "Review link",
        "session link": "Record room",
        "add comment": "Comment here",
    }


def test_the_real_table_yields_phrases() -> None:
    phrases = lint.never_say_phrases()
    assert phrases["share link"] == "Review link"
    assert "start" not in phrases


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
