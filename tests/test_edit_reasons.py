from __future__ import annotations

import re
from typing import get_args

from podcast_mcp.config.defaults import repo_root
from podcast_mcp.edits.cut_policy import ReviewKind, review_kind
from podcast_mcp.edits.edit_reasons import LABELLED_REASON_CODES, LABELLED_REASON_PREFIXES
from podcast_mcp.edits.tighten_hits import TIGHTEN_REASON_PREFIXES

_UTILS = repo_root() / "gui" / "web" / "src" / "utils"


def test_every_backend_reason_code_has_a_gui_label() -> None:
    ts = (_UTILS / "pendingEditLabels.ts").read_text(encoding="utf-8")
    for code in LABELLED_REASON_CODES:
        assert f'"{code}":' in ts, code
    for prefix in LABELLED_REASON_PREFIXES:
        assert f'startsWith("{prefix}")' in ts, prefix


def _web(rel: str) -> str:
    return (repo_root() / "gui" / "web" / "src" / rel).read_text(encoding="utf-8")


def test_every_backend_tighten_prefix_maps_to_a_non_other_review_kind() -> None:
    for prefix in TIGHTEN_REASON_PREFIXES:
        assert review_kind(f"{prefix}x") != "other", prefix
    # Acoustic hits are `filler:` reasons, grouped as the Sound chip.
    assert review_kind("filler:acoustic") == "sound"


def test_gui_pending_kind_union_matches_the_backend_review_kinds() -> None:
    ts = _web("types/project.ts")
    union = ts[ts.index("export type PendingKind =") :].split(";", 1)[0]
    assert sorted(re.findall(r'"([\w-]+)"', union)) == sorted(get_args(ReviewKind))


def test_gui_tighten_filter_chips_are_the_non_other_review_kinds() -> None:
    ts = _web("panels/TightenPanel.tsx")
    block = ts[ts.index("const CLASS_FILTERS") :].split("];", 1)[0]
    ids = re.findall(r'id: "([\w-]+)"', block)
    assert sorted(i for i in ids if i != "all") == sorted(
        k for k in get_args(ReviewKind) if k != "other"
    )
