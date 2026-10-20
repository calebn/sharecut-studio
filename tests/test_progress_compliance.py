"""Every class that implements the progress protocol derives from ``ElapsedProgressMixin``.

The mixin carries the protocol's no-op bodies and the one heartbeat, so a reporter states only
the events it acts on. A class found by AST that defines all six protocol methods, itself or
through a base in the tree, must have the mixin among its ancestors.
"""

from __future__ import annotations

import ast
from pathlib import Path

from podcast_mcp.util.progress import ProgressReporter

_ROOT = Path(__file__).resolve().parents[1]
_SOURCE_ROOTS = (_ROOT / "src" / "podcast_mcp", _ROOT / "src" / "podcast_relay")
_BASE = "ElapsedProgressMixin"
_PROTOCOL_METHODS = frozenset(name for name in vars(ProgressReporter) if not name.startswith("_"))


def _base_name(node: ast.expr) -> str:
    return node.attr if isinstance(node, ast.Attribute) else ast.unparse(node)


def _classes(source: str, path: str) -> dict[str, tuple[set[str], set[str]]]:
    """Class name to (base names, methods defined), skipping ``Protocol`` declarations."""
    found: dict[str, tuple[set[str], set[str]]] = {}
    for node in ast.walk(ast.parse(source, filename=path)):
        if not isinstance(node, ast.ClassDef):
            continue
        bases = {_base_name(b) for b in node.bases}
        if "Protocol" in bases:
            continue
        methods = {
            n.name for n in node.body if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)
        }
        known_bases, known_methods = found.setdefault(f"{path}:{node.name}", (set(), set()))
        known_bases |= bases
        known_methods |= methods
    return found


def non_compliant_reporters(sources: dict[str, str]) -> tuple[list[str], list[str]]:
    """(implementers of the protocol, those among them without the mixin as an ancestor)."""
    classes: dict[str, tuple[set[str], set[str]]] = {}
    by_simple_name: dict[str, list[str]] = {}
    for path, source in sources.items():
        for key, value in _classes(source, path).items():
            classes[key] = value
            by_simple_name.setdefault(key.rpartition(":")[2], []).append(key)

    def ancestry(key: str) -> tuple[set[str], set[str]]:
        names: set[str] = set()
        methods: set[str] = set()
        todo = [key]
        seen: set[str] = set()
        while todo:
            current = todo.pop()
            if current in seen:
                continue
            seen.add(current)
            bases, own = classes[current]
            methods |= own
            for base in bases:
                names.add(base)
                todo.extend(by_simple_name.get(base, []))
        return names, methods

    implementers: list[str] = []
    missing: list[str] = []
    for key in sorted(classes):
        simple = key.rpartition(":")[2]
        if simple == _BASE:
            continue
        names, methods = ancestry(key)
        if not methods >= _PROTOCOL_METHODS:
            continue
        implementers.append(key)
        if _BASE not in names:
            missing.append(key)
    return implementers, missing


def _tree_sources() -> dict[str, str]:
    return {
        str(path.relative_to(_ROOT)): path.read_text(encoding="utf-8")
        for root in _SOURCE_ROOTS
        for path in sorted(root.rglob("*.py"))
    }


def test_every_protocol_implementer_derives_from_elapsed_progress_mixin() -> None:
    implementers, missing = non_compliant_reporters(_tree_sources())
    names = {key.rpartition(":")[2] for key in implementers}
    assert {
        "NullProgress",
        "RecordingProgress",
        "MultiProgress",
        "McpNotificationProgress",
        "JsonProgressReporter",
        "CliProgressReporter",
        "GuestMcpProgressContext",
        "GuestWsProgressReporter",
        "JobProgressReporter",
        "SsePublishReporter",
        "AgentJobFanInReporter",
    } <= names
    assert not missing, (
        f"derive these from podcast_mcp.util.progress.ElapsedProgressMixin: {missing}"
    )


_PROTOCOL_BODY = "\n".join(
    f"    def {name}(self, *args, **kwargs):\n        pass" for name in sorted(_PROTOCOL_METHODS)
)


def test_a_hand_rolled_reporter_is_reported() -> None:
    sources = {"bad.py": f"class HandRolled:\n{_PROTOCOL_BODY}\n"}
    assert non_compliant_reporters(sources) == (["bad.py:HandRolled"], ["bad.py:HandRolled"])


def test_the_mixin_and_its_subclasses_pass() -> None:
    sources = {
        "ok.py": (
            f"class Direct(ElapsedProgressMixin):\n{_PROTOCOL_BODY}\n\n"
            "class Inherits(Direct):\n    pass\n\n"
            f"class Viaattr(mod.ElapsedProgressMixin):\n{_PROTOCOL_BODY}\n"
        )
    }
    implementers, missing = non_compliant_reporters(sources)
    assert implementers == ["ok.py:Direct", "ok.py:Inherits", "ok.py:Viaattr"]
    assert missing == []


def test_a_subclass_of_a_hand_rolled_reporter_is_reported() -> None:
    sources = {"bad.py": f"class Base:\n{_PROTOCOL_BODY}\n\nclass Child(Base):\n    pass\n"}
    assert non_compliant_reporters(sources)[1] == ["bad.py:Base", "bad.py:Child"]


def test_partial_and_protocol_classes_are_not_implementers() -> None:
    partial = "\n".join(
        f"    def {name}(self):\n        pass" for name in sorted(_PROTOCOL_METHODS)[:-1]
    )
    sources = {
        "other.py": (
            f"class Partial:\n{partial}\n\n"
            f"class Declared(Protocol):\n{_PROTOCOL_BODY}\n\n"
            "class Unrelated:\n    def start(self):\n        pass\n"
        )
    }
    assert non_compliant_reporters(sources) == ([], [])
