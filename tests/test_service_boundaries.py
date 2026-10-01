from __future__ import annotations

import ast
from importlib.util import resolve_name
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_SUPPORT = "podcast_mcp.services.support"


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


def _violations(source: str, module: str, internals: set[str]) -> set[str]:
    violations: set[str] = set()
    inside_support = module.startswith(_SUPPORT + ".")
    for target in _imports(source, module):
        if inside_support and target.startswith(
            ("podcast_mcp.gui", "podcast_mcp.cli", "podcast_mcp.mcp")
        ):
            violations.add(target)
        if inside_support and target.startswith("podcast_mcp.services."):
            allowed = (_SUPPORT, "podcast_mcp.services.bootstrap")
            if not any(target == name or target.startswith(name + ".") for name in allowed):
                violations.add(target)
        if not inside_support and target.startswith(_SUPPORT + "."):
            member = target.removeprefix(_SUPPORT + ".").split(".")[0]
            if member in internals:
                violations.add(f"{_SUPPORT}.{member}")
    return violations


@pytest.mark.parametrize(
    ("source", "module", "expected"),
    [
        (
            "from podcast_mcp.services.support.doctor import DoctorReport",
            "podcast_mcp.cli.setup_cmd",
            {"podcast_mcp.services.support.doctor"},
        ),
        (
            "from podcast_mcp.services.support import doctor",
            "podcast_mcp.services.pipeline",
            {"podcast_mcp.services.support.doctor"},
        ),
        (
            "from .support import doctor",
            "podcast_mcp.services.pipeline",
            {"podcast_mcp.services.support.doctor"},
        ),
        (
            "def run():\n    import podcast_mcp.gui.routes.deps",
            "podcast_mcp.services.support.doctor",
            {"podcast_mcp.gui.routes.deps"},
        ),
        (
            "from podcast_mcp.services.support import DoctorReport",
            "podcast_mcp.cli.setup_cmd",
            set(),
        ),
        (
            "from .doctor import DoctorReport",
            "podcast_mcp.services.support.config_check",
            set(),
        ),
        (
            "import podcast_mcp.services.play",
            "podcast_mcp.services.support.doctor",
            {"podcast_mcp.services.play"},
        ),
        (
            "from podcast_mcp.services.bootstrap import component_status",
            "podcast_mcp.services.support.diagnostics",
            set(),
        ),
    ],
)
def test_boundary_guard_checks_nested_relative_and_facade_imports(
    source: str, module: str, expected: set[str]
) -> None:
    assert _violations(source, module, {"doctor"}) == expected


def test_support_context_uses_public_facade_and_has_no_adapter_dependencies() -> None:
    support = _ROOT / "src/podcast_mcp/services/support"
    internals = {path.stem for path in support.glob("*.py") if path.stem != "__init__"}
    violations: list[str] = []
    for source_root in (_ROOT / "src", _ROOT / "scripts"):
        for path in source_root.rglob("*.py"):
            module = ".".join(path.relative_to(source_root).with_suffix("").parts)
            for target in sorted(_violations(path.read_text(), module, internals)):
                violations.append(f"{path.relative_to(_ROOT)}: {target}")
    assert not violations, "service context boundary violations:\n" + "\n".join(violations)


def test_migrated_support_modules_have_no_legacy_paths() -> None:
    services = _ROOT / "src/podcast_mcp/services"
    for name in ("config_check", "diagnostics", "doctor", "report_submission"):
        assert not (services / f"{name}.py").exists()
