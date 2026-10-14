"""Fail on absolute levels in the detectors (docs/audio-engineering.md § Detection levels).

Every detection threshold in ``edits/`` and ``engines/`` is an offset from a track's
``LevelProfile`` (``engines/level_profile.py``), so an absolute level there is one that a
recording's gain would move. Two kinds are flagged:

* a negative literal, when it is compared with something, or bound to, passed with or
  combined with a name that reads as a level (a ``db``, ``rms``, ``thresh``, ``floor``,
  ``level`` or ``limit`` token), as a dict value under such a key, or as an argument to
  ``max(-55.0, level)``;
* a linear amplitude threshold: a float from 1e-6 up to 1 (a smaller one is a numerical
  guard) bound to, passed as, defaulted to or compared with a name that reads as an
  amplitude (an ``rms``, ``amp``, ``std``, ``silence`` or ``energy`` token). A difference
  of two levels (``abs(rms_a - rms_b) >= 0.5``) is an offset and passes.

A name that says what the level is relative to (a ``over``, ``under``, ``drop``, ``gain``
and the like token) is an offset and passes; names are read as whole tokens, so
``coverage`` does not pass as ``over``. Physical constants are listed in ``ALLOWED`` by
file and name with the reason they cannot move with gain. The render and delivery modules
in ``RENDER`` set effect and mastering levels, not detection thresholds, and are not
scanned.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCANNED = ("src/podcast_mcp/edits", "src/podcast_mcp/engines")
# The ffmpeg filter graph (effect formatters and presets the user picks) and delivery loudness targets.
RENDER = frozenset(
    {
        "src/podcast_mcp/engines/ffmpeg.py",
        "src/podcast_mcp/engines/effect_filters.py",
        "src/podcast_mcp/engines/mastering.py",
        "src/podcast_mcp/edits/loudness.py",
    }
)
_TOKEN = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")
LEVEL_TOKENS = frozenset({"db", "rms", "thresh", "threshold", "floor", "level", "limit"})
AMPLITUDE_TOKENS = frozenset({"rms", "amp", "amplitude", "std", "silence", "energy"})
RELATIVE_TOKENS = frozenset(
    {
        "over",
        "under",
        "above",
        "below",
        "drop",
        "rise",
        "gain",
        "delta",
        "diff",
        "margin",
        "excess",
        "offset",
        "jump",
        "depth",
        "spread",
    }
)
RELATIVE_PREFIXES = ("attenuat",)
# Names that count something else than a level, so a ``silence`` duration or an ``energy``
# weight is not an amplitude threshold.
NOT_A_LEVEL_TOKENS = frozenset(
    {"sec", "ms", "dur", "duration", "weight", "ratio", "frac", "prob", "step", "count"}
)
NUMERICAL_GUARD = 1e-6


def _tokens(name: str) -> set[str]:
    """Lower-case whole words of ``name``: ``COVERAGE_DB`` is ``coverage`` and ``db``."""
    return {t.lower() for t in _TOKEN.findall(name)}


def _is_relative(name: str) -> bool:
    return any(
        t in RELATIVE_TOKENS
        or t in NOT_A_LEVEL_TOKENS
        or t.rstrip("s") in RELATIVE_TOKENS
        or t.startswith(RELATIVE_PREFIXES)
        for t in _tokens(name)
    )


def _reads_as(name: str, vocabulary: frozenset[str]) -> bool:
    return bool(_tokens(name) & vocabulary)


# (file, name): why the level is physical, the same at any recording gain, or the issue
# that will replace it.
ALLOWED: dict[tuple[str, str], str] = {
    ("src/podcast_mcp/engines/audio_audit.py", "CLIPPING_PEAK_LEVEL_DB"): (
        "clipping ceiling: how close a peak sits to digital full scale"
    ),
    ("src/podcast_mcp/engines/audio_audit.py", "CLIPPING_MIN_PEAK_DB"): (
        "clipping ceiling: a peak this far under full scale was never clipped"
    ),
    # Deferred to #1533: a per-window voice reach regressed real ingest (session start moved
    # 36-48 s on aligned lab tracks), so these keep the fixed gates until a whole-file
    # reference exists.
    (
        "src/podcast_mcp/engines/session_clock.py",
        "rms_threshold",
    ): "ingest gate kept fixed until #1533",
    (
        "src/podcast_mcp/engines/session_clock.py",
        "ref_rms_threshold",
    ): "ingest gate kept fixed until #1533",
    (
        "src/podcast_mcp/engines/session_clock.py",
        "source_rms_threshold",
    ): "ingest gate kept fixed until #1533",
    (
        "src/podcast_mcp/engines/alignment_audit.py",
        "rms_threshold",
    ): "ingest gate kept fixed until #1533",
    (
        "src/podcast_mcp/edits/conversation_align.py",
        "min_rms",
    ): "ingest gate kept fixed until #1533",
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


def _context(
    literal: ast.AST, parents: dict[ast.AST, ast.AST], *, direct: bool
) -> tuple[bool, list[str]]:
    """``(compared, names)``: whether the literal is compared, and the names it goes with.

    ``direct`` keeps only the names it is compared with, defaulted to, passed as or bound
    to; a name in an expression around it (``rms * 0.5``) says nothing about the literal.
    """
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
            if direct and any(
                isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.Sub)
                for sub in ast.walk(parent)
            ):
                return True, []  # a difference of two levels is an offset
            return True, _names(parent)
        if isinstance(parent, ast.Dict) and node in parent.values:
            key = parent.keys[parent.values.index(node)]
            return False, _names(key) if key is not None else []
        if isinstance(parent, (ast.BinOp, ast.Call)):
            return False, [] if direct else _names(parent)
        if isinstance(parent, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = parent.targets if isinstance(parent, ast.Assign) else [parent.target]
            return False, [name for target in targets for name in _names(target)]
        if isinstance(parent, ast.stmt):
            return False, []
        node = parent
    return False, []


def _is_negative_number(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.UnaryOp)
        and isinstance(node.op, ast.USub)
        and isinstance(node.operand, ast.Constant)
        and type(node.operand.value) in (int, float)
    )


def _is_linear_threshold(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Constant)
        and type(node.value) is float
        and NUMERICAL_GUARD <= node.value < 1.0
    )


def violations(path: Path) -> list[tuple[int, str, str]]:
    """``(line, literal, name)`` for each absolute level in ``path``."""
    tree = ast.parse(path.read_text(), filename=str(path))
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    rel = path.resolve().relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name
    found: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if _is_negative_number(node):
            assert isinstance(node, ast.UnaryOp) and isinstance(node.operand, ast.Constant)
            compared, names = _context(node, parents, direct=False)
            literal = f"-{node.operand.value}"
            levels = [name for name in names if _reads_as(name, LEVEL_TOKENS)]
            flagged = compared or bool(levels)
        elif _is_linear_threshold(node):
            assert isinstance(node, ast.Constant)
            _, names = _context(node, parents, direct=True)
            literal = repr(node.value)
            levels = [name for name in names if _reads_as(name, AMPLITUDE_TOKENS)]
            flagged = bool(levels)
        else:
            continue
        if any(_is_relative(name) for name in names):
            continue
        if not flagged or any((rel, name) in ALLOWED for name in levels):
            continue
        found.append((node.lineno, literal, (levels or names or ["?"])[0]))
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
            f"{len(bad)} absolute level(s). Read the level as an offset from the track's "
            "LevelProfile, or list a physical constant in ALLOWED in "
            "scripts/check_level_literals.py."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
