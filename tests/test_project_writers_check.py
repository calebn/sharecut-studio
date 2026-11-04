"""The project-writer ratchet fails on a new writer, a stale row and a grown count."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
checker = load_script("check_project_writers")

CLI_SOURCE = """\
from podcast_mcp.services.document_sync import apply_external_document_edit


def trim(ws):
    apply_external_document_edit(ws, lambda: 1)
    apply_external_document_edit(ws, lambda: 2)
"""

SERVICE_SOURCE = """\
def land(ws, store):
    ws.mutate(lambda p: p)
    ws.save_merged()
    store.commit(None)
"""


def _tree(tmp_path: Path, files: dict[str, str]) -> Path:
    src = tmp_path / "src" / "podcast_mcp"
    for rel, text in files.items():
        path = src / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return src


def _row(module: str, primitive: str, count: int) -> dict[str, object]:
    return {"module": module, "primitive": primitive, "count": count, "reason": "legacy"}


def test_clean_tree_matches_listed_rows(tmp_path: Path) -> None:
    src = _tree(tmp_path, {"cli/edit.py": CLI_SOURCE})
    rows = [_row("cli/edit.py", "apply_external_document_edit", 2)]
    assert checker.compare(rows, checker.scan(src)) == []


def test_unlisted_writer_fails(tmp_path: Path) -> None:
    src = _tree(tmp_path, {"cli/edit.py": CLI_SOURCE, "mcp/tools/new.py": SERVICE_SOURCE})
    rows = [_row("cli/edit.py", "apply_external_document_edit", 2)]
    problems = checker.compare(rows, checker.scan(src))
    assert any("mcp/tools/new.py" in p and "ws.mutate" in p and "not listed" in p for p in problems)
    assert any("mcp/tools/new.py" in p and "ws.save_merged" in p for p in problems)


def test_stale_row_fails(tmp_path: Path) -> None:
    src = _tree(tmp_path, {"cli/edit.py": "def trim(ws):\n    return ws\n"})
    rows = [_row("cli/edit.py", "apply_external_document_edit", 2)]
    problems = checker.compare(rows, checker.scan(src))
    assert problems == [
        "cli/edit.py apply_external_document_edit: listed 2, found 0; delete the row"
    ]


def test_over_counted_row_fails(tmp_path: Path) -> None:
    src = _tree(tmp_path, {"cli/edit.py": CLI_SOURCE})
    rows = [_row("cli/edit.py", "apply_external_document_edit", 5)]
    problems = checker.compare(rows, checker.scan(src))
    assert problems == [
        "cli/edit.py apply_external_document_edit: listed 5, found 2; lower the count to 2"
    ]


def test_count_growth_fails(tmp_path: Path) -> None:
    src = _tree(tmp_path, {"cli/edit.py": CLI_SOURCE})
    rows = [_row("cli/edit.py", "apply_external_document_edit", 1)]
    problems = checker.compare(rows, checker.scan(src))
    assert problems == [
        "cli/edit.py apply_external_document_edit: listed 1, found 2; "
        "a new writer must use the document dispatcher"
    ]


def test_document_sync_is_the_door_and_is_not_counted(tmp_path: Path) -> None:
    src = _tree(tmp_path, {"services/document_sync/handlers/x.py": SERVICE_SOURCE})
    assert checker.scan(src) == {}


def test_receiver_names_decide_workspace_writes(tmp_path: Path) -> None:
    src = _tree(
        tmp_path,
        {
            "services/a.py": (
                "def f(self, cache):\n"
                "    self.ws.mutate(g)\n"
                "    self._ws.save()\n"
                "    cache.save()\n"
                "    self._store.commit(x)\n"
            )
        },
    )
    assert checker.scan(src) == {
        ("services/a.py", "ws.mutate"): 1,
        ("services/a.py", "ws.save"): 1,
        ("services/a.py", "_store.commit"): 1,
    }


def test_comment_service_writes_are_counted_through_aliases(tmp_path: Path) -> None:
    src = _tree(
        tmp_path,
        {
            "gui/routes/c.py": (
                "def f(ws):\n"
                "    CommentService(ws).add(1)\n"
                "    svc = CommentService(ws)\n"
                "    svc.resolve(2)\n"
                "    svc.list()\n"
                "    CommentService(ws).get(3)\n"
            )
        },
    )
    assert checker.scan(src) == {("gui/routes/c.py", "CommentService.write"): 2}


def test_notify_after_mutation_counts_net_wrapped_tools(tmp_path: Path) -> None:
    src = _tree(
        tmp_path,
        {
            "mcp/tools/t.py": (
                "def register(mcp):\n"
                "    mutating = {a_tool, b_tool, c_tool}\n"
                "    mutating.discard(b_tool)\n"
                "    for fn in (a_tool, b_tool, c_tool, d_tool):\n"
                "        mcp.tool()(notify_after_mutation(fn) if fn in mutating else fn)\n"
            )
        },
    )
    assert checker.scan(src) == {("mcp/tools/t.py", "notify_after_mutation"): 2}


def test_rows_must_be_unique_sorted_and_justified() -> None:
    rows = [
        _row("b.py", "ws.save", 1),
        _row("a.py", "ws.save", 1),
        _row("a.py", "ws.save", 1),
        {"module": "c.py", "primitive": "ws.save", "count": 0, "reason": ""},
    ]
    problems = checker.validate_rows(rows)
    assert any("duplicate" in p for p in problems)
    assert any("sorted" in p for p in problems)
    assert any("count" in p for p in problems)
    assert any("reason" in p for p in problems)


def test_main_exit_codes_and_census(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    src = _tree(tmp_path, {"cli/edit.py": CLI_SOURCE})
    contract = tmp_path / "writers.json"
    contract.write_text(json.dumps([_row("cli/edit.py", "apply_external_document_edit", 2)]))
    assert checker.main(["--src", str(src), "--contract", str(contract)]) == 0
    contract.write_text("[]")
    assert checker.main(["--src", str(src), "--contract", str(contract)]) == 1
    capsys.readouterr()
    assert checker.main(["--src", str(src), "--census"]) == 0
    census = json.loads(capsys.readouterr().out)
    assert census == [
        {
            "module": "cli/edit.py",
            "primitive": "apply_external_document_edit",
            "count": 2,
            "reason": "",
        }
    ]


def test_checked_in_contract_matches_main() -> None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_project_writers.py")],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_grown_flags_new_rows_and_higher_counts() -> None:
    base = [_row("a.py", "ws.save", 2)]
    assert checker.grown(base, [_row("a.py", "ws.save", 2)]) == []
    assert checker.grown(base, [_row("a.py", "ws.save", 1)]) == []
    assert any("grew" in p for p in checker.grown(base, [_row("a.py", "ws.save", 3)]))
    assert any("new row" in p for p in checker.grown(base, [_row("b.py", "ws.save", 1)]))


def test_base_ref_unreadable_is_skipped(tmp_path: Path) -> None:
    src = _tree(tmp_path, {"cli/edit.py": CLI_SOURCE})
    contract = tmp_path / "writers.json"
    contract.write_text(json.dumps([_row("cli/edit.py", "apply_external_document_edit", 2)]))
    args = ["--src", str(src), "--contract", str(contract), "--base", "no-such-ref"]
    assert checker.main(args) == 0
