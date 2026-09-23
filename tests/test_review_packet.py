"""scripts/review_packet.py builds the pipeline's review packet from plain git."""

from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "review_packet", ROOT / "scripts" / "review_packet.py"
)
assert _spec and _spec.loader
review_packet = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(review_packet)


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


def _write(repo: Path, rel: str, text: str) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    _write(tmp_path, "src/podcast_mcp/services/mix.py", "def level(x):\n    return x\n")
    _write(
        tmp_path,
        "src/podcast_mcp/cli/mix.py",
        "from podcast_mcp.services.mix import level\n\nlevel(1)\n",
    )
    _write(tmp_path, "tests/test_mix.py", "from podcast_mcp.services.mix import level\n")
    _write(
        tmp_path, "AGENTS.md", "| Mix levels in services | `docs/mix.md` |\n| Unrelated | `x` |\n"
    )
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    _git(tmp_path, "branch", "base")
    _write(
        tmp_path,
        "src/podcast_mcp/services/mix.py",
        "def level(x):\n    return x\n\n\ndef normalize_gain(x):\n    return level(x) * 2\n",
    )
    _git(tmp_path, "commit", "-qam", "change")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_packet_has_every_section_with_real_data(repo: Path) -> None:
    packet = review_packet.build("HEAD", "base..HEAD")
    for title in (
        "## Diff stat",
        "## Diff (with 30 lines of context)",
        "## Callers and references",
        "## Importers of changed modules (second hop)",
        "## Twin paths (CLI / MCP / GUI adapters)",
        "## Related tests",
        "## Applicable repo rules (AGENTS.md rows)",
    ):
        assert title in packet, title
    assert "+def normalize_gain(x):" in packet
    assert "### normalize_gain" in packet
    # The CLI adapter imports the changed service module: a twin path, unchanged in this diff.
    assert "src/podcast_mcp/cli/mix.py:1:" in packet
    assert "[unchanged]" in packet
    assert "tests/test_mix.py" in packet
    assert "| Mix levels in services |" in packet
    assert "| Unrelated |" not in packet


def test_packet_is_capped(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(review_packet, "MAX_CHARS", 200)
    packet = review_packet.build("HEAD", "base..HEAD")
    assert packet.endswith("[packet truncated at 200 chars]\n")


def test_diff_is_capped_with_a_pointer(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(review_packet, "DIFF_CAP", 50)
    packet = review_packet.build("HEAD", "base..HEAD")
    assert "[diff truncated at 50 chars; run `git diff base..HEAD` for the rest]" in packet


def test_main_writes_the_file(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = repo / ".git" / "pipeline-packets" / "pr1-r1.md"
    assert review_packet.main(["--ref", "HEAD", "--range", "base..HEAD", "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8").startswith("## Diff stat")
    assert str(out) in capsys.readouterr().out


def test_symbols_ignore_tests_and_short_names() -> None:
    diff = "+def test_x():\n+def ok():\n+export function useMixer() {}\n+class Mixer:\n+  def level(self):\n"
    assert review_packet.changed_symbols(diff) == ["useMixer", "Mixer", "level"]


def test_typescript_importers(repo: Path) -> None:
    _write(repo, "gui/web/src/audio/meter.ts", "export const peak = 1\n")
    _write(repo, "gui/web/src/ui/Panel.tsx", "import { peak } from '../audio/meter'\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "ts")
    assert review_packet.importers("HEAD", "gui/web/src/audio/meter.ts") == [
        "gui/web/src/ui/Panel.tsx:1:import { peak } from '../audio/meter'"
    ]
    assert review_packet.importers("HEAD", "README.md") == []
