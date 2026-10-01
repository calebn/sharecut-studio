from __future__ import annotations

import ast
from importlib.util import resolve_name
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_SUPPORT = "podcast_mcp.services.support"
_PIPELINE = "podcast_mcp.services.pipeline"
_APP = "podcast_mcp.services.app"
_MEDIA = "podcast_mcp.services.media"
_SESSION_SYNC = "podcast_mcp.services.session_sync"
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
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.ImportFrom)
            and node.level == 0
            and node.module == "podcast_mcp.services"
        ):
            violations.add("podcast_mcp.services")
    for target in _imports(source, module):
        if _in(target, "podcast_mcp.gui.routes") and module.startswith("podcast_mcp.services."):
            violations.add(".".join(target.split(".")[:4]))
        if (
            owner
            and any(_in(target, adapter) for adapter in _ADAPTERS)
            and not (
                module == _APP + ".gui_launch"
                and any(
                    _in(target, name)
                    for name in ("podcast_mcp.gui.bind", "podcast_mcp.gui.static_assets")
                )
            )
        ):
            violations.add(
                ".".join(target.split(".")[:4]) if _in(target, "podcast_mcp.gui.routes") else target
            )
        if owner and target.startswith("podcast_mcp.services."):
            allowed = {owner}
            if owner == _SUPPORT:
                allowed.add(_PIPELINE)
            elif owner == _PIPELINE:
                allowed.add(_APP)
            elif owner == _APP:
                allowed.add(_SESSION_SYNC)
            elif owner == _MEDIA:
                allowed.update({_APP, _PIPELINE})
            if not any(_in(target, name) for name in allowed):
                violations.add(".".join(target.split(".")[:3]))
        if owner == _APP and target.startswith(_SESSION_SYNC + "."):
            member = target.removeprefix(_SESSION_SYNC + ".").split(".")[0]
            if member not in {"ensure_non_loopback_session_auth", "is_bind_loopback"}:
                violations.add(_SESSION_SYNC)
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
            "from podcast_mcp.services.app import ProjectWorkspace",
            _PIPELINE + ".service",
            set(),
        ),
        (
            "from podcast_mcp.services.pipeline.bootstrap import run_bootstrap",
            _PIPELINE + ".config",
            set(),
        ),
        ("from .doctor import DoctorReport", _SUPPORT + ".config_check", set()),
        (
            "from podcast_mcp.services.media.waveform import tile_bytes",
            "podcast_mcp.gui.routes.waveform",
            {_MEDIA + ".waveform"},
        ),
        ("from .media import waveform", "podcast_mcp.services.play", {_MEDIA + ".waveform"}),
        ("import podcast_mcp.cli.main", _MEDIA + ".ingest", {"podcast_mcp.cli.main"}),
        ("from podcast_mcp.services.app import ProjectWorkspace", _MEDIA + ".ingest", set()),
        (
            "from podcast_mcp.services.pipeline import asr_options_for",
            _MEDIA + ".transcript",
            set(),
        ),
        ("from .waveform import tile_bytes", _MEDIA + ".ingest", set()),
        (
            "from podcast_mcp.services.app.workspace import ProjectWorkspace",
            _PIPELINE + ".service",
            {_APP + ".workspace"},
        ),
        (
            "from podcast_mcp.services.app.fanout_hub import FanoutHub",
            "podcast_mcp.gui.job_events",
            {_APP + ".fanout_hub"},
        ),
        ("from .workspace import ProjectWorkspace", _APP + ".gui_launch", set()),
        (
            "from podcast_mcp.gui.routes.deps import require_host",
            _APP + ".gui_launch",
            {"podcast_mcp.gui.routes.deps"},
        ),
        (
            "from podcast_mcp.gui.routes.deps import require_host",
            "podcast_mcp.services.play",
            {"podcast_mcp.gui.routes.deps"},
        ),
        ("from podcast_mcp.gui.bind import gui_server_deps_available", _APP + ".gui_launch", set()),
        (
            "from podcast_mcp.services.session_sync import ensure_non_loopback_session_auth",
            _APP + ".gui_launch",
            set(),
        ),
        (
            "from podcast_mcp.services.session_sync.authz import ensure_non_loopback_session_auth",
            _APP + ".gui_launch",
            {"podcast_mcp.services.session_sync"},
        ),
        ("import podcast_mcp.cli.main", _APP + ".__init__", {"podcast_mcp.cli.main"}),
        (
            "from podcast_mcp.services import ProjectWorkspace",
            "podcast_mcp.cli.main",
            {"podcast_mcp.services"},
        ),
    ],
)
def test_boundary_guard_checks_nested_relative_and_facade_imports(
    source: str, module: str, expected: set[str]
) -> None:
    assert (
        _violations(
            source,
            module,
            {
                _SUPPORT: {"doctor"},
                _PIPELINE: {"config", "bootstrap", "service"},
                _APP: {"workspace", "fanout_hub", "gui_launch"},
                _MEDIA: {
                    "bounce",
                    "ingest",
                    "media_store",
                    "proxy_media",
                    "review_media",
                    "speaker",
                    "transcript",
                    "transcript_precorrect",
                    "transcript_refine",
                    "waveform",
                },
            },
        )
        == expected
    )


def test_service_contexts_use_public_facades_and_have_no_adapter_dependencies() -> None:
    services = _ROOT / "src/podcast_mcp/services"
    contexts = {
        _SUPPORT: services / "support",
        _PIPELINE: services / "pipeline",
        _APP: services / "app",
        _MEDIA: services / "media",
    }
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
        "workspace",
        "fanout_hub",
        "gui_launch",
        "bounce",
        "ingest",
        "media_store",
        "proxy_media",
        "review_media",
        "speaker",
        "transcript",
        "transcript_precorrect",
        "transcript_refine",
        "waveform",
    ):
        assert not (services / f"{name}.py").exists()
