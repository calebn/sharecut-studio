"""The Agent model guard denies untiered launches and fails open without jq."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / ".claude/hooks/agent-model-guard.sh"
SETTINGS = json.loads((ROOT / ".claude/settings.json").read_text(encoding="utf-8"))

needs_jq = pytest.mark.skipif(shutil.which("jq") is None, reason="jq not installed")


def run_guard(tool_input: dict[str, str], env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        ["sh", str(GUARD)],
        input=json.dumps({"tool_input": tool_input}),
        text=True,
        capture_output=True,
        check=True,
        env=env,
    )
    if not result.stdout:
        return "allow"
    return json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"]


def test_settings_wire_guard_to_agent_tool() -> None:
    entry = SETTINGS["hooks"]["PreToolUse"][0]
    assert entry["matcher"] == "Agent"
    assert (
        entry["hooks"][0]["command"] == '"$CLAUDE_PROJECT_DIR"/.claude/hooks/agent-model-guard.sh'
    )
    assert os.access(GUARD, os.X_OK)


@needs_jq
@pytest.mark.parametrize(
    ("tool_input", "decision"),
    [
        ({"description": "fix bug"}, "deny"),
        ({"description": "implement feature", "model": "opus"}, "deny"),
        ({"description": "implement feature", "model": "fable"}, "deny"),
        ({"description": "implement feature", "model": "Opus"}, "deny"),
        ({"description": "verify the diff", "model": "opus"}, "allow"),
        ({"description": "hardest task escalation", "model": "fable"}, "allow"),
        ({"description": "implement feature", "model": "sonnet"}, "allow"),
        ({"description": "label issue", "model": "haiku"}, "allow"),
        ({"description": "find files", "subagent_type": "Explore"}, "allow"),
    ],
)
def test_guard_decisions(tool_input: dict[str, str], decision: str) -> None:
    assert run_guard(tool_input) == decision


def test_guard_allows_with_warning_when_jq_missing(tmp_path: Path) -> None:
    result = subprocess.run(
        ["/bin/sh", str(GUARD)],
        input="{}",
        text=True,
        capture_output=True,
        check=True,
        env={"PATH": str(tmp_path)},
    )
    assert result.stdout == ""
    assert "jq not found" in result.stderr


@needs_jq
@pytest.mark.parametrize("payload", ["", "not json{", "null", '{"tool_input":"x"}'])
def test_guard_fails_open_on_unexpected_payload(payload: str) -> None:
    result = subprocess.run(
        ["sh", str(GUARD)], input=payload, text=True, capture_output=True, check=True
    )
    assert result.stdout == ""
