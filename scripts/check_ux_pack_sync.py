#!/usr/bin/env python3
"""Fail a commit when Sharecut Studio UX surfaces change without UX pack updates.

Trigger paths (GUI shells, mobile/integration/share/session docs, episode schema)
should ship with matching updates under ``ux/pages/`` (and often the demo fixture / screens).

Bypass (rare): ``UX_PACK_SKIP=1`` or commit message containing ``[skip ux-pack]``.
"""

from __future__ import annotations

import os
import subprocess
import sys

TRIGGER_PREFIXES = (
    "gui/web/src/layout/",
    "gui/web/src/styles/partials/responsive.css",
    "gui/web/src/styles/partials/bottom-sheet.css",
    "gui/web/src/ui/BottomSheet",
    "gui/web/src/keymap/",
    "gui/web/src/commands/catalog.ts",
    "docs/gui-mobile.md",
    "docs/gui-integration.md",
    "docs/daw-editing.md",
    "docs/host-online-relay.md",
    "docs/session-sync.md",
    "docs/recording-session.md",
    "schemas/episode.project.schema.json",
)

UX_PREFIXES = (
    "ux/pages/",
    "ux/assets/screens/",
    "docs/daw-shortcuts.md",
    "tests/fixtures/sharecut_ux_demo/",
    "scripts/build_ux_demo_fixture.py",
)


def _git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def _staged_files() -> list[str]:
    out = _git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
    return [line for line in out.splitlines() if line]


def _commit_msg_allows_skip() -> bool:
    if os.environ.get("UX_PACK_SKIP", "").strip() in {"1", "true", "yes"}:
        return True
    # pre-commit may not have the message yet; check MERGE_MSG / COMMIT_EDITMSG when present
    for rel in (".git/COMMIT_EDITMSG", ".git/MERGE_MSG"):
        path = os.path.join(_git("rev-parse", "--show-toplevel"), rel)
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                text = f.read()
            if "[skip ux-pack]" in text:
                return True
    return False


def _matches(path: str, prefixes: tuple[str, ...]) -> bool:
    return any(path == p or path.startswith(p) for p in prefixes)


def main(argv: list[str]) -> int:
    staged = _staged_files()
    # Prefer explicit filenames from pre-commit when provided
    candidates = argv[1:] or staged
    triggered = [p for p in candidates if _matches(p, TRIGGER_PREFIXES)]
    if not triggered:
        return 0
    if _commit_msg_allows_skip():
        print("ux-pack-sync: skip flag set")
        return 0
    ux_touch = [p for p in staged if _matches(p, UX_PREFIXES)]
    if ux_touch:
        return 0

    print(
        "ux-pack-sync: Sharecut Studio / schema docs changed without UX pack updates.\n"
        f"  triggers: {', '.join(triggered)}\n"
        "  update ux/pages/ (and demo fixture / screens if the UI changed),\n"
        "  or run `make cheatsheet` after keymap/catalog changes,\n"
        "  or set UX_PACK_SKIP=1 / add [skip ux-pack] to the commit message.\n"
        "  See ux/README.md § Keeping docs accurate.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
