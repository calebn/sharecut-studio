"""The merge-guard hook entry is wired and its shim allows silently when the guard script is absent."""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHIM = ROOT / ".claude/hooks/merge-guard.sh"
SETTINGS = json.loads((ROOT / ".claude/settings.json").read_text(encoding="utf-8"))
PAYLOAD = json.dumps({"tool_name": "Bash", "tool_input": {"command": "gh pr merge 1"}})


def run_shim(guard: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sh", str(SHIM)],
        input=PAYLOAD,
        text=True,
        capture_output=True,
        check=False,
        env={"PATH": "/usr/bin:/bin", "MERGE_GUARD_SCRIPT": str(guard)},
    )


def test_settings_wire_guard_to_merge_tools() -> None:
    entry = next(e for e in SETTINGS["hooks"]["PreToolUse"] if "merge" in e["matcher"])
    assert entry["hooks"][0]["command"] == 'sh "$CLAUDE_PROJECT_DIR"/.claude/hooks/merge-guard.sh'
    assert entry["hooks"][0]["timeout"] == 40
    for tool in ("Bash", "mcp__.*[Gg]it[Hh]ub.*__(merge_pull_request|enable_pr_auto_merge"):
        assert tool in entry["matcher"]


def test_shim_allows_silently_when_guard_script_is_absent(tmp_path: Path) -> None:
    result = run_shim(tmp_path / "missing-merge-guard.sh")
    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")


def test_shim_passes_stdin_and_decision_through_when_guard_exists(tmp_path: Path) -> None:
    guard = tmp_path / "merge-guard.sh"
    guard.write_text(
        '#!/bin/sh\ncat > "$0.stdin"\necho \'{"decision":"deny"}\'\n', encoding="utf-8"
    )
    result = run_shim(guard)
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"decision": "deny"}
    assert (tmp_path / "merge-guard.sh.stdin").read_text(encoding="utf-8") == PAYLOAD


def test_shim_denies_when_the_guard_itself_fails(tmp_path: Path) -> None:
    guard = tmp_path / "merge-guard.sh"
    guard.write_text("#!/bin/sh\nexit 3\n", encoding="utf-8")
    result = run_shim(guard)
    assert result.returncode == 0
    assert json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"] == "deny"
