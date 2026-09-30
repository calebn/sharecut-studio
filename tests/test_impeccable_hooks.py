"""Project design hooks dispatch portably and keep private runtime state local."""

import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SKILL = Path(".agents/skills/impeccable")
HOOKS = json.loads((ROOT / ".codex/hooks.json").read_text(encoding="utf-8"))["hooks"]


@pytest.mark.parametrize("event", ["PostToolUse", "Stop"])
def test_design_hook_dispatches_event_from_project_root(tmp_path: Path, event: str) -> None:
    launcher = tmp_path / SKILL / "scripts/impeccable"
    launcher.parent.mkdir(parents=True)
    launcher.write_text('#!/bin/sh\nprintf "%s\\n" "$1"\ncat\n', encoding="utf-8")
    launcher.chmod(0o755)
    definition = HOOKS[event][0]["hooks"][0]
    payload = json.dumps({"hook_event_name": event, "session_id": "test-design-hook"})

    result = subprocess.run(
        ["sh", "-c", definition["command"]],
        cwd=tmp_path,
        input=payload,
        text=True,
        capture_output=True,
        check=True,
    )

    verb, received = result.stdout.split("\n", 1)
    assert verb == "hook"
    assert json.loads(received) == json.loads(payload)
    assert definition["type"] == "command"
    assert definition["timeout"] > 0


def test_design_hooks_enabled_with_portable_launcher_and_private_state() -> None:
    config = json.loads((ROOT / ".impeccable/config.json").read_text(encoding="utf-8"))
    assert config["hook"]["enabled"] is True
    assert HOOKS["PostToolUse"][0]["matcher"] == "Edit|Write|apply_patch"
    assert os.access(ROOT / SKILL / "scripts/impeccable", os.X_OK)
    assert (ROOT / SKILL / "scripts/impeccable.cmd").is_file()
    assert (ROOT / SKILL / "scripts/VERSION").read_text(encoding="utf-8").strip()
    private_paths = [
        str(SKILL / "scripts/bin/darwin-arm64/impeccable"),
        ".impeccable/config.local.json",
        ".impeccable/hook.cache.json",
        ".impeccable/hook.pending.json",
        ".impeccable/hook.ndjson",
    ]
    result = subprocess.run(
        ["git", "check-ignore", "--stdin"],
        cwd=ROOT,
        input="\n".join(private_paths) + "\n",
        text=True,
        capture_output=True,
        check=True,
    )
    assert result.stdout.splitlines() == private_paths
