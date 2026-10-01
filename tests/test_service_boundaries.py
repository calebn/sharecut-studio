from __future__ import annotations

import ast
import subprocess
import sys
from importlib.util import resolve_name
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_SERVICES = _ROOT / "src/podcast_mcp/services"
_BASE = "podcast_mcp.services"
_CONTEXTS = (
    "app",
    "collaboration",
    "document",
    "document_sync",
    "media",
    "pipeline",
    "record",
    "remote_mcp",
    "session_sync",
    "share_auth",
    "support",
)
_ADAPTERS = ("podcast_mcp.gui", "podcast_mcp.cli", "podcast_mcp.mcp")
_ADAPTER_EXCEPTIONS = {
    "podcast_mcp.services.app.gui_launch": {
        "podcast_mcp.gui.bind",
        "podcast_mcp.gui.static_assets",
    },
    "podcast_mcp.services.document_sync.service": {"podcast_mcp.gui.assembler"},
    "podcast_mcp.services.remote_mcp.tools": {"podcast_mcp.gui.jobs"},
    "podcast_mcp.services.collaboration.share": {
        "podcast_mcp.gui.mapper",
        "podcast_mcp.gui.audio",
    },
}


def _registry() -> dict[str, set[str]]:
    return {
        f"{_BASE}.{context}": (
            {
                ".".join(path.relative_to(_SERVICES / context).with_suffix("").parts)
                for path in (_SERVICES / context).rglob("*.py")
                if path.name != "__init__.py"
            }
            | {
                ".".join(path.parent.relative_to(_SERVICES / context).parts)
                for path in (_SERVICES / context).rglob("__init__.py")
                if path.parent != _SERVICES / context
            }
        )
        for context in _CONTEXTS
    }


def _exports() -> dict[str, set[str]]:
    return {
        f"{_BASE}.{context}": set(
            ast.literal_eval(
                next(
                    node.value
                    for node in ast.parse((_SERVICES / context / "__init__.py").read_text()).body
                    if isinstance(node, ast.Assign)
                    and any(
                        isinstance(target, ast.Name) and target.id == "__all__"
                        for target in node.targets
                    )
                )
            )
        )
        for context in _CONTEXTS
    }


def _imports(source: str, module: str) -> set[str]:
    imports: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            target = node.module or ""
            if node.level:
                target = resolve_name("." * node.level + target, module.rpartition(".")[0])
            imports.add(target)
            imports.update(f"{target}.{alias.name}" for alias in node.names)
    return imports


def _in(target: str, package: str) -> bool:
    return target == package or target.startswith(package + ".")


def _import_modules(source: str, module: str) -> set[str]:
    imports: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            target = node.module or ""
            if node.level:
                target = resolve_name("." * node.level + target, module.rpartition(".")[0])
            imports.add(target)
    return imports


def _violations(
    source: str, module: str, registry: dict[str, set[str]], exports: dict[str, set[str]]
) -> set[str]:
    owner = next((context for context in registry if module.startswith(context + ".")), None)
    violations: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module == _BASE:
            violations.add(_BASE)
    for target in _import_modules(source, module):
        if _in(target, "podcast_mcp.gui.routes") and module.startswith(_BASE + "."):
            violations.add("podcast_mcp.gui.routes")
        if (
            owner
            and any(_in(target, adapter) for adapter in _ADAPTERS)
            and not any(_in(target, allowed) for allowed in _ADAPTER_EXCEPTIONS.get(module, ()))
        ):
            violations.add(target)
    for target in _imports(source, module):
        for context, internals in registry.items():
            if owner == context or not target.startswith(context + "."):
                continue
            member = target.removeprefix(context + ".")
            private = next(
                (
                    name
                    for name in sorted(internals, key=len)
                    if member == name or member.startswith(name + ".")
                ),
                None,
            )
            if private:
                violations.add(f"{context}.{private}")
            elif "." not in member and member not in exports[context]:
                violations.add(f"{context}.{member}")
    return violations


@pytest.mark.parametrize(
    ("source", "module", "expected"),
    [
        ("from podcast_mcp.services import share", "podcast_mcp.cli.review", {_BASE}),
        (
            "from podcast_mcp.services.collaboration.share import ShareService",
            "podcast_mcp.cli.review",
            {_BASE + ".collaboration.share"},
        ),
        (
            "from ..collaboration import share",
            _BASE + ".record.service",
            {_BASE + ".collaboration.share"},
        ),
        (
            "from podcast_mcp.services.collaboration import ShareService",
            "podcast_mcp.cli.review",
            set(),
        ),
        (
            "from podcast_mcp.services.collaboration import undeclared_name",
            "podcast_mcp.cli.review",
            {_BASE + ".collaboration.undeclared_name"},
        ),
        ("from .share import ShareService", _BASE + ".collaboration.record_share", set()),
        (
            "from podcast_mcp.services.document_sync.service import DocumentSyncService",
            _BASE + ".collaboration.share",
            {_BASE + ".document_sync.service"},
        ),
        (
            "from podcast_mcp.services.record import RecordSessionService",
            _BASE + ".collaboration.share",
            set(),
        ),
        (
            "from podcast_mcp.services.remote_mcp.tools import call_tool",
            "podcast_mcp.gui.routes.remote_mcp",
            {_BASE + ".remote_mcp.tools"},
        ),
        (
            "from podcast_mcp.gui.routes.deps import require_host",
            _BASE + ".record.service",
            {"podcast_mcp.gui.routes", "podcast_mcp.gui.routes.deps"},
        ),
        (
            "from podcast_mcp.gui.assembler import dump_project_projection",
            _BASE + ".document_sync.service",
            set(),
        ),
        ("from podcast_mcp.gui.jobs import shared_job_manager", _BASE + ".remote_mcp.tools", set()),
        (
            "from podcast_mcp.gui.jobs import shared_job_manager",
            _BASE + ".collaboration.share",
            {"podcast_mcp.gui.jobs"},
        ),
        (
            "from podcast_mcp.gui.bind import gui_server_deps_available",
            _BASE + ".app.gui_launch",
            set(),
        ),
        ("import podcast_mcp.cli.main", _BASE + ".record.__init__", {"podcast_mcp.cli.main"}),
    ],
)
def test_boundary_guard_checks_all_contexts(source: str, module: str, expected: set[str]) -> None:
    assert _violations(source, module, _registry(), _exports()) == expected


def test_service_contexts_use_public_facades_and_declared_adapter_dependencies() -> None:
    assert {
        path.name for path in _SERVICES.iterdir() if path.is_dir() and path.name != "__pycache__"
    } == set(_CONTEXTS)
    assert {path.name for path in _SERVICES.glob("*.py")} == {"__init__.py"}
    assert not (_SERVICES / "__init__.py").read_text().strip()
    registry = _registry()
    exports = _exports()
    violations: list[str] = []
    for source_root in (_ROOT / "src", _ROOT / "scripts"):
        for path in source_root.rglob("*.py"):
            module = ".".join(path.relative_to(source_root).with_suffix("").parts)
            for target in sorted(_violations(path.read_text(), module, registry, exports)):
                violations.append(f"{path.relative_to(_ROOT)}: {target}")
    assert not violations, "service context boundary violations:\n" + "\n".join(violations)


def test_nested_context_package_is_private() -> None:
    registry = _registry()
    assert "handlers" in registry[_BASE + ".document_sync"]
    assert _violations(
        "from podcast_mcp.services.document_sync.handlers import command",
        "podcast_mcp.gui.routes.document",
        registry,
        _exports(),
    ) == {_BASE + ".document_sync.handlers"}


def test_facades_are_cold_and_exports_resolve() -> None:
    for context in _CONTEXTS:
        script = f"""
import importlib
import sys
name = 'podcast_mcp.services.{context}'
facade = importlib.import_module(name)
prefix = name + '.'
assert not any(module.startswith(prefix) for module in sys.modules), name
assert facade.__all__
for export in facade.__all__:
    value = getattr(facade, export)
    assert value is getattr(facade, export), (name, export)
"""
        subprocess.run([sys.executable, "-c", script], check=True, cwd=_ROOT)
