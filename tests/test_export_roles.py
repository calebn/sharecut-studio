"""The roles exporter mirrors share_capabilities and refuses an inconsistent table."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

import pytest

from podcast_mcp.services.collaboration import share_capabilities as sc
from script_loader import load_script


@pytest.fixture
def gen():
    return load_script("export_roles", register=True)


def _array(text: str, name: str) -> list[str]:
    match = re.search(rf"export const {name}\b[^=]*=\s*(?:{{.*?)?\[(.*?)\]", text, re.S)
    assert match, name
    return json.loads("[" + match.group(1).rstrip().rstrip(",") + "]")


def _table(text: str, name: str) -> dict[str, list[str]]:
    body = re.search(rf"export const {name}\b[^=]*= {{(.*?)\n}};", text, re.S)
    assert body, name
    return {
        role: json.loads("[" + caps.rstrip().rstrip(",") + "]")
        for role, caps in re.findall(r"(\w+): \[(.*?)\]", body.group(1), re.S)
    }


def test_generated_text_round_trips_the_python_tables(gen) -> None:
    text = gen.generate()
    assert _array(text, "CAPABILITIES") == sc.ALL_CAPABILITIES
    assert _array(text, "REVIEW_ROLE_IDS") == [role.value for role in sc.ReviewRole]
    assert _array(text, "RECORD_ROLE_IDS") == list(sc.RECORD_ROLE_PRESETS)
    assert _table(text, "REVIEW_ROLE_CAPABILITIES") == {
        role.value: list(caps) for role, caps in sc.REVIEW_ROLE_CAPABILITIES.items()
    }
    assert _table(text, "RECORD_ROLE_CAPABILITIES") == sc.RECORD_ROLE_PRESETS


def test_generation_is_deterministic_and_names_no_path_or_time(gen) -> None:
    text = gen.generate()
    assert text == gen.generate()
    assert "scripts/export_roles.py" in text
    assert "/home/" not in text and not re.search(r"\d{4}-\d{2}-\d{2}", text)


def test_generation_is_stable_across_hash_seeds(gen) -> None:
    code = (
        "import sys; sys.path.insert(0, 'scripts'); "
        "import export_roles; sys.stdout.write(export_roles.generate())"
    )
    outputs = {
        subprocess.run(
            [sys.executable, "-c", code],
            cwd=gen.ROOT,
            env={**os.environ, "PYTHONHASHSEED": seed},
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        for seed in ("0", "1", "4242")
    }
    assert outputs == {gen.generate()}


def test_exact_membership_agrees_with_the_server_aliases() -> None:
    caps = sc.ALL_CAPABILITIES
    for role, held in sc.REVIEW_ROLE_CAPABILITIES.items():
        for cap in caps:
            assert (cap in held) == sc.has_capability(list(held), cap), (role, cap)


def test_a_changed_capability_changes_the_output(gen, monkeypatch) -> None:
    before = gen.generate()
    mutated = dict(sc.REVIEW_ROLE_CAPABILITIES)
    mutated[sc.ReviewRole.VIEWER] = (*mutated[sc.ReviewRole.VIEWER], sc.CAP_EDIT)
    monkeypatch.setattr(sc, "REVIEW_ROLE_CAPABILITIES", mutated)
    assert gen.generate() != before


def test_capability_outside_the_vocabulary_is_refused(gen, monkeypatch) -> None:
    monkeypatch.setattr(sc, "ALL_CAPABILITIES", [sc.CAP_VIEW])
    with pytest.raises(ValueError, match="outside ALL_CAPABILITIES"):
        gen._model()


def test_a_role_in_both_tables_is_refused(gen, monkeypatch) -> None:
    monkeypatch.setattr(sc, "RECORD_ROLE_PRESETS", {"viewer": [sc.CAP_VIEW]})
    with pytest.raises(ValueError, match="both tables"):
        gen._model()
