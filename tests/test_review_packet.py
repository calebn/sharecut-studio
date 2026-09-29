"""scripts/review_packet.py builds the pipeline's review packet from plain git."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "review_packet", ROOT / "scripts" / "review_packet.py"
)
assert _spec and _spec.loader
review_packet = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(review_packet)

_DOCS_SYNC_SOURCE = (ROOT / "scripts" / "docs_sync.py").read_text(encoding="utf-8")
_MIX_DOCS_CONTRACT = json.dumps(
    {
        "api_version": 1,
        "rules": [
            {
                "id": "mix-docs",
                "when": "Mix levels in services",
                "update": "`docs/mix.md`",
                "docs": ["docs/mix.md"],
                "gate": {"include": ["src/podcast_mcp/services/mix.py"]},
            }
        ],
    }
)


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
    """``base`` predates the docs-sync checker (it is added in the ``change`` commit), so
    tests exercise both the found-checker and the "unavailable at this ref" fallback."""
    _git(tmp_path, "init", "-q", "-b", "main")
    _write(tmp_path, "src/podcast_mcp/services/mix.py", "def level(x):\n    return x\n")
    _write(
        tmp_path,
        "src/podcast_mcp/cli/mix.py",
        "from podcast_mcp.services.mix import level\n\nlevel(1)\n",
    )
    _write(tmp_path, "tests/test_mix.py", "from podcast_mcp.services.mix import level\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    _git(tmp_path, "branch", "base")
    _write(tmp_path, "scripts/docs_sync.py", _DOCS_SYNC_SOURCE)
    _write(tmp_path, "contracts/docs-sync.json", _MIX_DOCS_CONTRACT)
    _write(
        tmp_path,
        "src/podcast_mcp/services/mix.py",
        "def level(x):\n    return x\n\n\ndef normalize_gain(x):\n    return level(x) * 2\n",
    )
    _git(tmp_path, "add", ".")  # -am below only stages already-tracked files
    _git(tmp_path, "commit", "-qm", "change")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_packet_has_every_section_with_real_data(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The fixture embeds the real, growing scripts/docs_sync.py as a whole-file addition;
    # raise the cap so its diff never crowds out the later files under test (cap behavior
    # itself is covered by test_diff_is_capped_with_a_pointer / test_packet_is_capped).
    monkeypatch.setattr(review_packet, "DIFF_CAP", 200_000)
    packet = review_packet.build("HEAD", "base..HEAD")
    for title in (
        "## Diff stat",
        "## Diff (with 30 lines of context)",
        "## Callers and references",
        "## Importers of changed modules (second hop)",
        "## Twin paths (CLI / MCP / GUI adapters)",
        "## Related tests",
        "## Changed docs (docs-accuracy lens)",
        "## Docs-sync rules (contracts/docs-sync.json)",
    ):
        assert title in packet, title
    assert "## Applicable repo rules (AGENTS.md rows)" not in packet
    # The small docs sections precede the diff so the MAX_CHARS cut never drops them.
    assert packet.index("## Docs-sync rules") < packet.index("## Changed docs")
    assert packet.index("## Changed docs") < packet.index("## Diff (with 30 lines of context)")
    assert "+def normalize_gain(x):" in packet
    assert "### normalize_gain" in packet
    # The CLI adapter imports the changed service module: a twin path, unchanged in this diff.
    assert "src/podcast_mcp/cli/mix.py:1:" in packet
    assert "[unchanged]" in packet
    assert "tests/test_mix.py" in packet
    assert "VIOLATED  mix-docs  Mix levels in services" in packet
    # The fixture's change commit touches no Markdown doc.
    assert "(no docs changed)" in packet


def test_packet_is_capped(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(review_packet, "MAX_CHARS", 200)
    packet = review_packet.build("HEAD", "base..HEAD")
    assert "\n[packet truncated at 200 chars; cut: " in packet
    assert packet.endswith("; Related tests]\n")


def test_diff_is_capped_with_a_pointer(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(review_packet, "DIFF_CAP", 50)
    packet = review_packet.build("HEAD", "base..HEAD")
    assert "[diff truncated at 50 chars; run `git diff base..HEAD` for the rest]" in packet


def test_doc_heavy_packet_keeps_docs_sync_and_names_the_cut(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for i in range(40):
        _write(repo, f"docs/d{i:02}.md", "See `services/mix.py` and `cli/mix.py`.\n")
    _git(repo, "add", "docs")
    _git(repo, "commit", "-qm", "docs: many")
    monkeypatch.setattr(review_packet, "DOCS_CAP", 300)
    full = review_packet.build("HEAD", "base..HEAD")
    assert (
        "more changed docs not listed; run "
        "`git diff --name-only --diff-filter=d base..HEAD -- '*.md'`" in full
    )
    assert "### docs/d39.md" not in full
    monkeypatch.setattr(review_packet, "MAX_CHARS", full.index("## Diff (with 30") + 10)
    packet = review_packet.build("HEAD", "base..HEAD")
    assert "VIOLATED  mix-docs  Mix levels in services" in packet
    assert "### docs/d00.md" in packet
    assert "cut: Diff (with 30 lines of context); Callers and references" in packet


def test_main_writes_the_file(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = repo / ".git" / "pipeline-packets" / "pr1-r1.md"
    assert review_packet.main(["--ref", "HEAD", "--range", "base..HEAD", "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8").startswith("## Diff stat")
    printed = capsys.readouterr().out
    assert str(out) in printed
    assert printed.strip().endswith("docs=0")


def test_docs_sync_findings_reports_a_violation_at_the_given_ref(repo: Path) -> None:
    findings = review_packet.docs_sync_findings("HEAD", "base..HEAD")
    assert "  VIOLATED  mix-docs  Mix levels in services" in findings


def test_docs_sync_findings_falls_back_before_the_checker_existed(repo: Path) -> None:
    # "base" predates scripts/docs_sync.py, which is only added in the "change" commit.
    assert review_packet.docs_sync_findings("base", "base..HEAD") == [
        "(docs-sync unavailable at this ref)"
    ]


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


def test_changed_docs_name_the_code_their_added_lines_reference(repo: Path) -> None:
    _write(
        repo,
        "docs/mix.md",
        "Normalize with `services/mix.py` (`normalize_gain`); see "
        "[CLI](../src/podcast_mcp/cli/mix.py), [site](https://x.dev/a.md) and "
        "`docs/missing.md`.\n",
    )
    _git(repo, "add", "docs/mix.md")
    _git(repo, "commit", "-qm", "docs: mix")
    assert review_packet.changed_docs("base..HEAD") == ["docs/mix.md"]
    packet = review_packet.build("HEAD", "base..HEAD")
    assert (
        "### docs/mix.md\npaths named in added lines: "
        "src/podcast_mcp/services/mix.py, src/podcast_mcp/cli/mix.py" in packet
    )


def test_deleted_docs_are_not_listed(repo: Path) -> None:
    _write(repo, "docs/old.md", "old\n")
    _git(repo, "add", "docs/old.md")
    _git(repo, "commit", "-qm", "docs: add old")
    _git(repo, "branch", "with-doc")
    _git(repo, "rm", "-q", "docs/old.md")
    _git(repo, "commit", "-qm", "docs: remove old")
    assert review_packet.changed_docs("with-doc..HEAD") == []


def test_tracked_paths_include_parent_dirs(repo: Path) -> None:
    tracked = review_packet.tracked_paths("HEAD")
    assert "src/podcast_mcp/services/mix.py" in tracked
    assert "src/podcast_mcp/services" in tracked
    assert "src" in tracked


def test_package_prefix_matches_docs_sync() -> None:
    # review_packet.py runs from a git object and cannot import docs_sync.py, so it keeps a copy.
    docs_sync = load_script("docs_sync", register=True)
    assert review_packet.PACKAGE_PREFIX == docs_sync._PACKAGE_PREFIX
