"""Docs and copy must not claim Studio reports overlap, unsure stretches or voice samples (#1998)."""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PHILOSOPHY = ROOT / "docs" / "communication-philosophy.md"
GLOSSARY = ROOT / "ux" / "pages" / "domain-glossary.md"
GUI_VIEWER = ROOT / "docs" / "gui-viewer.md"
ATTRIBUTION = ROOT / "docs" / "speaker-attribution.md"
SKILL = ROOT / ".agents" / "skills" / "podcast-speaker-attribution" / "SKILL.md"
INVENTORY = ROOT / "docs" / "model-inventory.md"
SETUP_CMD = ROOT / "src" / "podcast_mcp" / "cli" / "setup_cmd.py"
INSTALL = ROOT / "install.sh"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _table_rows(path: Path) -> dict[str, str]:
    """First-cell name (bold markers dropped) -> full row text, for markdown table rows."""
    rows: dict[str, str] = {}
    for line in _text(path).splitlines():
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            rows[cells[0].strip("*")] = line
    return rows


def _row(path: Path, name: str) -> str:
    rows = _table_rows(path)
    assert name in rows, f"{path.name} has no {name!r} row (renamed? update this test)"
    return rows[name]


def _headings(path: Path) -> list[str]:
    return [
        re.sub(r"^#+\s*", "", line).strip()
        for line in _text(path).splitlines()
        if line.startswith("#")
    ]


def test_philosophy_glossary_has_no_listen_for_or_unsure_stretch_row() -> None:
    rows = _table_rows(PHILOSOPHY)
    assert "Listen for" not in rows
    assert "Unsure stretch" not in rows


def test_philosophy_overlapping_speech_row_says_studio_does_not_report_it() -> None:
    row = _row(PHILOSOPHY, "Overlapping speech")
    assert "the dialog says how long it lasts" not in row
    assert "does not pull it apart or report it" in row


def test_glossaries_have_no_voice_sample_row() -> None:
    assert "Voice sample" not in _table_rows(PHILOSOPHY)
    assert "Voice sample" not in _table_rows(GLOSSARY)
    assert "voice sample" not in _row(GLOSSARY, "Split speakers")
    assert "Voices talking at once are not pulled apart" in _row(GLOSSARY, "Split speakers")


def test_gui_viewer_has_no_review_split_or_split_dialog() -> None:
    text = _text(GUI_VIEWER)
    assert "Review split" not in text
    assert "completed split dialog" not in text


def test_speaker_attribution_doc_does_not_say_studio_reports_overlap_or_takes_names() -> None:
    text = _text(ATTRIBUTION)
    assert "reports overlapping speech" not in text
    assert "stretches it is unsure of" not in text
    assert "optional names" not in text
    assert "Resemblyzer clustering" not in text


def test_speaker_attribution_skill_matches_the_studio_card() -> None:
    text = _text(SKILL)
    assert "the result lists overlapping and unsure stretches" not in text
    assert "optional names" not in text
    assert "count and names" not in text
    assert "Download speaker model" not in text
    assert "**Get** on the Models sheet" in text


def test_model_inventory_has_no_open_decision_or_planned_slices_headings() -> None:
    headings = _headings(INVENTORY)
    assert not [h for h in headings if h.startswith("Decision needed")]
    assert not [h for h in headings if h.startswith("Planned slices")]


def test_model_inventory_does_not_ask_for_a_look_at_a_split_speakers_dialog() -> None:
    text = _text(INVENTORY)
    assert "A look at the Split speakers dialog" not in text
    assert "reads as unavailable" not in text


def test_bootstrap_docstring_does_not_claim_lazy_downloads() -> None:
    tree = ast.parse(_text(SETUP_CMD))
    funcs = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "bootstrap"]
    assert len(funcs) == 1
    doc = ast.get_docstring(funcs[0]) or ""
    assert doc, "bootstrap lost its docstring"
    assert "lazily" not in doc
    assert "Get ready on Home" in doc


def test_install_script_does_not_claim_transcribe_downloads_lazily() -> None:
    assert "lazily" not in _text(INSTALL)


def test_speaker_unavailable_message_does_not_name_a_dialog() -> None:
    from podcast_mcp.engines.speaker_id import SPEAKER_UNAVAILABLE_MESSAGE

    assert "dialog" not in SPEAKER_UNAVAILABLE_MESSAGE.split()
    assert "PODCAST_SPEAKER_BACKEND" in SPEAKER_UNAVAILABLE_MESSAGE
