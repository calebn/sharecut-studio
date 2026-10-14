"""Fail on absolute dB levels in the detectors (docs/audio-engineering.md § Detection levels).

Every detection threshold in ``edits/`` and ``engines/`` is an offset from a track's
``LevelProfile`` (``engines/level_profile.py``), so a negative dB literal there is an
absolute level that a recording's gain would move. A negative number is flagged when it
is compared with something, or when the name it is bound to, passed as, or combined with
holds ``db`` or ``rms``. A name that says what the level is relative to (``over``,
``under``, ``drop``, ``gain`` and the like) is an offset and passes. Physical constants
are listed in ``ALLOWED`` by file and name with the reason they cannot move with gain.
The render and delivery modules in ``RENDER`` set effect and mastering levels, not
detection thresholds, and are not scanned.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCANNED = ("src/podcast_mcp/edits", "src/podcast_mcp/engines")
# The ffmpeg filter graph (effect presets the user picks) and delivery loudness targets.
RENDER = frozenset(
    {
        "src/podcast_mcp/engines/ffmpeg.py",
        "src/podcast_mcp/engines/mastering.py",
        "src/podcast_mcp/edits/loudness.py",
    }
)
LEVEL = re.compile(r"db|rms", re.IGNORECASE)
RELATIVE = re.compile(
    r"over|under|above|below|drop|rise|gain|attenuat|delta|diff|margin|excess|offset|jump"
    r"|depth|spread",
    re.IGNORECASE,
)

# (file, name): why the level is physical, the same at any recording gain.
ALLOWED: dict[tuple[str, str], str] = {
    ("src/podcast_mcp/engines/audio_audit.py", "CLIPPING_PEAK_LEVEL_DB"): (
        "clipping ceiling: how close a peak sits to digital full scale"
    ),
    ("src/podcast_mcp/engines/audio_audit.py", "CLIPPING_MIN_PEAK_DB"): (
        "clipping ceiling: a peak this far under full scale was never clipped"
    ),
}


def _names(node: ast.AST) -> list[str]:
    out: list[str] = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name):
            out.append(sub.id)
        elif isinstance(sub, ast.Attribute):
            out.append(sub.attr)
        elif isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            out.append(sub.value)
    return out


def _default_names(arguments: ast.arguments, literal: ast.AST) -> list[str]:
    positional = arguments.posonlyargs + arguments.args
    defaulted = positional[len(positional) - len(arguments.defaults) :]
    pairs = list(zip(defaulted, arguments.defaults, strict=True))
    pairs += [
        (arg, default)
        for arg, default in zip(arguments.kwonlyargs, arguments.kw_defaults, strict=True)
        if default is not None
    ]
    return [arg.arg for arg, default in pairs if default is literal]


def _context(literal: ast.AST, parents: dict[ast.AST, ast.AST]) -> tuple[bool, list[str]]:
    """``(compared, names)``: whether the literal is compared, and the names it goes with."""
    node = literal
    while node in parents:
        parent = parents[node]
        if isinstance(parent, ast.Slice) or (
            isinstance(parent, ast.Subscript) and node is parent.slice
        ):
            return False, []
        if isinstance(parent, ast.keyword):
            return False, [parent.arg or ""]
        if isinstance(parent, ast.arguments):
            return False, _default_names(parent, node)
        if isinstance(parent, ast.Compare):
            return True, _names(parent)
        if isinstance(parent, (ast.BinOp, ast.Call)):
            return False, _names(parent)
        if isinstance(parent, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = parent.targets if isinstance(parent, ast.Assign) else [parent.target]
            return False, [name for target in targets for name in _names(target)]
        if isinstance(parent, ast.stmt):
            return False, []
        node = parent
    return False, []


def violations(path: Path) -> list[tuple[int, str, str]]:
    """``(line, literal, name)`` for each absolute dB level in ``path``."""
    tree = ast.parse(path.read_text(), filename=str(path))
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    rel = path.resolve().relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name
    found: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.UnaryOp)
            and isinstance(node.op, ast.USub)
            and isinstance(node.operand, ast.Constant)
            and type(node.operand.value) in (int, float)
        ):
            continue
        compared, names = _context(node, parents)
        if any(RELATIVE.search(name) for name in names):
            continue
        levels = [name for name in names if LEVEL.search(name)]
        if not (compared or levels) or any((rel, name) in ALLOWED for name in levels):
            continue
        found.append((node.lineno, f"-{node.operand.value}", (levels or names or ["?"])[0]))
    return sorted(found)


def main(argv: list[str]) -> int:
    roots = [Path(arg).resolve() for arg in argv] or [ROOT / d for d in SCANNED]
    files = sorted(
        p
        for r in roots
        for p in (r.rglob("*.py") if r.is_dir() else [r])
        if not p.is_relative_to(ROOT) or p.relative_to(ROOT).as_posix() not in RENDER
    )
    bad = [(p, *v) for p in files for v in violations(p)]
    for path, line, literal, name in bad:
        print(f"{path}:{line}: absolute level {literal} ({name})")
    if bad:
        print(
            f"{len(bad)} absolute dB level(s). Read the level as an offset from the track's "
            "LevelProfile, or list a physical constant in ALLOWED in "
            "scripts/check_level_literals.py."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
