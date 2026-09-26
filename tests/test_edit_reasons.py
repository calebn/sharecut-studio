from __future__ import annotations

import re

from podcast_mcp.config import repo_root
from podcast_mcp.edits.edit_reasons import LABELLED_REASON_CODES, LABELLED_REASON_PREFIXES
from podcast_mcp.gui.mapper import TIGHTEN_REASON_PREFIXES

_UTILS = repo_root() / "gui" / "web" / "src" / "utils"


def test_every_backend_reason_code_has_a_gui_label() -> None:
    ts = (_UTILS / "pendingEditLabels.ts").read_text(encoding="utf-8")
    for code in LABELLED_REASON_CODES:
        assert f'"{code}":' in ts, code
    for prefix in LABELLED_REASON_PREFIXES:
        assert f'startsWith("{prefix}")' in ts, prefix


def test_gui_tighten_classes_match_backend_prefixes() -> None:
    ts = (_UTILS / "tightenHits.ts").read_text(encoding="utf-8")
    line = next(row for row in ts.splitlines() if row.startswith("const TIGHTEN_CLASSES"))
    assert sorted(re.findall(r'"(\w+)"', line)) == sorted(
        p.rstrip(":") for p in TIGHTEN_REASON_PREFIXES
    )
