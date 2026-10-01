from __future__ import annotations

import ast
from importlib.util import resolve_name
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_SUPPORT = "podcast_mcp.services.support"
_PIPELINE = "podcast_mcp.services.pipeline"
_ADAPTERS = ("podcast_mcp.gui", "podcast_mcp.cli", "podcast_mcp.mcp")


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


def _violations(source: str, module: str, internals: dict[str, set[str]]) -> set[str]:
    violations: set[str] = set()
    owner = next((ctx for ctx in internals if module.startswith(ctx + ".")), None)
    for target in _imports(source, module):
        if owner and any(_in(target, adapter) for adapter in _ADAPTERS):
            violations.add(target)
        if owner and target.startswith("podcast_mcp.services."):
            allowed = {owner}
            if owner == _SUPPORT:
                allowed.add(_PIPELINE)
            else:
                allowed.add("podcast_mcp.services.workspace")
            if not any(_in(target, name) for name in allowed):
                violations.add(".".join(target.split(".")[:3]))
        for context, modules in internals.items():
            if owner == context or not target.startswith(context + "."):
                continue
            member = target.removeprefix(context + ".").split(".")[0]
            if member in modules:
                violations.add(f"{context}.{member}")
    return violations


@pytest.mark.parametrize(
    ("source", "module", "expected"),
    [
        (
            "from podcast_mcp.services.support.doctor import DoctorReport",
            "podcast_mcp.cli.setup_cmd",
            {_SUPPORT + ".doctor"},
        ),
        ("from .support import doctor", "podcast_mcp.services.play", {_SUPPORT + ".doctor"}),
        (
            "from podcast_mcp.services.pipeline.config import config_store",
            "podcast_mcp.gui.jobs",
            {_PIPELINE + ".config"},
        ),
        ("from .pipeline import config", "podcast_mcp.services.play", {_PIPELINE + ".config"}),
        ("import podcast_mcp.cli.main", _PIPELINE + ".service", {"podcast_mcp.cli.main"}),
        ("import podcast_mcp.cli.main", _PIPELINE + ".__init__", {"podcast_mcp.cli.main"}),
        (
            "import podcast_mcp.gui.routes.deps",
            _SUPPORT + ".doctor",
            {"podcast_mcp.gui.routes.deps"},
        ),
        (
            "from podcast_mcp.services.play import PlayService",
            _PIPELINE + ".service",
            {"podcast_mcp.services.play"},
        ),
        (
            "from podcast_mcp.services.pipeline import component_status",
            _SUPPORT + ".diagnostics",
            set(),
        ),
        (
            "from podcast_mcp.services.workspace import ProjectWorkspace",
            _PIPELINE + ".service",
            set(),
        ),
        (
            "from podcast_mcp.services.pipeline.bootstrap import run_bootstrap",
            _PIPELINE + ".config",
            set(),
        ),
        ("from .doctor import DoctorReport", _SUPPORT + ".config_check", set()),
    ],
)
def test_boundary_guard_checks_nested_relative_and_facade_imports(
    source: str, module: str, expected: set[str]
) -> None:
    assert (
        _violations(
            source, module, {_SUPPORT: {"doctor"}, _PIPELINE: {"config", "bootstrap", "service"}}
        )
        == expected
    )


def test_service_contexts_use_public_facades_and_have_no_adapter_dependencies() -> None:
    services = _ROOT / "src/podcast_mcp/services"
    contexts = {_SUPPORT: services / "support", _PIPELINE: services / "pipeline"}
    internals = {
        context: {path.stem for path in directory.glob("*.py") if path.stem != "__init__"}
        for context, directory in contexts.items()
    }
    violations: list[str] = []
    for source_root in (_ROOT / "src", _ROOT / "scripts"):
        for path in source_root.rglob("*.py"):
            module = ".".join(path.relative_to(source_root).with_suffix("").parts)
            for target in sorted(_violations(path.read_text(), module, internals)):
                violations.append(f"{path.relative_to(_ROOT)}: {target}")
    assert not violations, "service context boundary violations:\n" + "\n".join(violations)


def test_migrated_modules_have_no_legacy_paths() -> None:
    services = _ROOT / "src/podcast_mcp/services"
    for name in (
        "config_check",
        "diagnostics",
        "doctor",
        "report_submission",
        "pipeline",
        "pipeline_config",
        "bootstrap",
    ):
        assert not (services / f"{name}.py").exists()
