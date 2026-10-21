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
    "jobs",
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
    "podcast_mcp.services.collaboration.share": {
        "podcast_mcp.gui.mapper",
        "podcast_mcp.gui.audio",
    },
}


_DOMAIN_PACKAGES = ("podcast_mcp.edits", "podcast_mcp.engines", "podcast_mcp.pipeline")
_ADAPTER_NAMES = ("gui", "cli", "mcp")
_ADAPTER_DOMAIN_ALLOWLIST_SIZE = 38
_ADAPTER_DOMAIN_ALLOWLIST: dict[str, set[str]] = {
    "podcast_mcp.cli.cut_speech": {
        "podcast_mcp.edits.audio_check_override",
        "podcast_mcp.edits.cut_speech",
    },
    "podcast_mcp.cli.edit": {
        "podcast_mcp.edits.bleed_restore_targets",
        "podcast_mcp.edits.cut_speech",
        "podcast_mcp.edits.decisions",
        "podcast_mcp.edits.edit_reasons",
        "podcast_mcp.edits.source_removals",
        "podcast_mcp.edits.tighten_intensity",
    },
    "podcast_mcp.cli.pipeline": {
        "podcast_mcp.pipeline.meta",
    },
    "podcast_mcp.cli.setup_cmd": {
        "podcast_mcp.engines",
        "podcast_mcp.engines.vad_silero",
    },
    "podcast_mcp.cli.speaker": {
        "podcast_mcp.edits.speaker_split",
    },
    "podcast_mcp.cli.transcript_cmd": {
        "podcast_mcp.edits.transcript_correct",
        "podcast_mcp.edits.transcript_timing",
    },
    "podcast_mcp.gui.assembler": {
        "podcast_mcp.edits.comments",
        "podcast_mcp.edits.join_modes",
        "podcast_mcp.edits.range_target",
        "podcast_mcp.edits.speaker_split",
        "podcast_mcp.edits.transcript_search",
        "podcast_mcp.engines.play_audit",
    },
    "podcast_mcp.gui.mapper": {
        "podcast_mcp.edits.clips_ops",
        "podcast_mcp.edits.cut_policy",
        "podcast_mcp.edits.pending_preview",
        "podcast_mcp.edits.range_target",
        "podcast_mcp.edits.tighten_hits",
        "podcast_mcp.edits.timeline_span",
        "podcast_mcp.engines.session_timeline",
        "podcast_mcp.engines.utterance_runs",
    },
    "podcast_mcp.gui.routes.document": {
        "podcast_mcp.edits.bleed_restore_targets",
        "podcast_mcp.edits.range_target",
        "podcast_mcp.edits.transcript_refine_status",
    },
    "podcast_mcp.gui.routes.pipeline": {
        "podcast_mcp.pipeline",
    },
    "podcast_mcp.gui.routes.transcript": {
        "podcast_mcp.edits.transcript_timing",
    },
    "podcast_mcp.mcp.tools.edits": {
        "podcast_mcp.edits.cut_speech",
        "podcast_mcp.edits.edit_reasons",
    },
    "podcast_mcp.mcp.tools.pipeline": {
        "podcast_mcp.edits.envelopes",
    },
    "podcast_mcp.mcp.tools.timeline": {
        "podcast_mcp.edits.audio_check_override",
        "podcast_mcp.edits.transcript_timing",
    },
}
_ADAPTER_ADAPTER_DELETE = {
    "podcast_mcp.gui.routes.handoff": {"podcast_mcp.cli.handoff", "podcast_mcp.cli.main"},
}
_ADAPTER_ADAPTER_WIRING = {
    "podcast_mcp.cli.gui": {
        "podcast_mcp.gui.bind",
        "podcast_mcp.gui.server",
        "podcast_mcp.gui.static_assets",
    },
    "podcast_mcp.gui.host_mcp": {"podcast_mcp.mcp.server"},
}
_ARCHITECTURE_ALLOWED = {
    "domain": _ADAPTER_DOMAIN_ALLOWLIST,
    "adapter": {**_ADAPTER_ADAPTER_DELETE, **_ADAPTER_ADAPTER_WIRING},
    "util": {},
}


def _runtime_imports(source: str, package: str) -> set[str]:
    """Imported modules, inline ones included, minus `if TYPE_CHECKING:` blocks."""
    tree = ast.parse(source)
    skipped: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and (
            (isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING")
            or (isinstance(node.test, ast.Attribute) and node.test.attr == "TYPE_CHECKING")
        ):
            skipped.update(id(child) for stmt in node.body for child in ast.walk(stmt))
    imports: set[str] = set()
    for node in ast.walk(tree):
        if id(node) in skipped:
            continue
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            target = node.module or ""
            if node.level:
                target = resolve_name("." * node.level + target, package)
            imports.add(target)
            if target == "podcast_mcp" or target in ("podcast_mcp." + n for n in _ADAPTER_NAMES):
                imports.update(f"{target}.{alias.name}" for alias in node.names)
    return imports


def _layer(module: str) -> str:
    parts = module.split(".")
    return parts[1] if len(parts) > 1 and parts[0] == "podcast_mcp" else ""


def _architecture_edges(source: str, module: str, package: str) -> dict[str, set[str]]:
    edges: dict[str, set[str]] = {"domain": set(), "adapter": set(), "util": set()}
    layer = _layer(module)
    for target in _runtime_imports(source, package):
        target_layer = _layer(target)
        if layer in _ADAPTER_NAMES and any(_in(target, d) for d in _DOMAIN_PACKAGES):
            edges["domain"].add(target)
        elif layer in _ADAPTER_NAMES and target_layer in _ADAPTER_NAMES and target_layer != layer:
            edges["adapter"].add(target)
        elif layer == "util" and target_layer in _ADAPTER_NAMES:
            edges["util"].add(target)
    return edges


def _architecture_violations(source: str, module: str) -> set[str]:
    edges = _architecture_edges(source, module, module.rpartition(".")[0])
    return _edge_violations(edges, module)


def _edge_violations(edges: dict[str, set[str]], module: str) -> set[str]:
    return {
        f"{kind}:{target}"
        for kind, targets in edges.items()
        for target in targets - _ARCHITECTURE_ALLOWED[kind].get(module, set())
    }


def _scan_architecture() -> tuple[dict[str, dict[str, set[str]]], list[str]]:
    found: dict[str, dict[str, set[str]]] = {"domain": {}, "adapter": {}, "util": {}}
    violations: list[str] = []
    source_root = _ROOT / "src"
    for path in source_root.rglob("*.py"):
        parts = path.relative_to(source_root).with_suffix("").parts
        is_init = parts[-1] == "__init__"
        module = ".".join(parts[:-1] if is_init else parts)
        package = module if is_init else module.rpartition(".")[0]
        source = path.read_text()
        edges = _architecture_edges(source, module, package)
        for kind, targets in edges.items():
            if targets:
                found[kind][module] = targets
        violations.extend(f"{module}: {v}" for v in sorted(_edge_violations(edges, module)))
    return found, violations


def test_adapters_do_not_grow_new_domain_adapter_or_util_edges() -> None:
    _, violations = _scan_architecture()
    assert not violations, (
        "adapter/domain boundary violations (route through a service or a typed contract, "
        "do not add an allowlist entry):\n" + "\n".join(violations)
    )


def test_architecture_allowlists_match_the_tree_exactly() -> None:
    found, _ = _scan_architecture()
    assert found["domain"] == _ADAPTER_DOMAIN_ALLOWLIST
    assert sum(map(len, _ADAPTER_DOMAIN_ALLOWLIST.values())) == _ADAPTER_DOMAIN_ALLOWLIST_SIZE
    assert found["adapter"] == _ARCHITECTURE_ALLOWED["adapter"]
    assert found["util"] == {}


@pytest.mark.parametrize(
    ("source", "module", "expected"),
    [
        (
            "from podcast_mcp.edits.new_logic import run",
            "podcast_mcp.cli.review",
            {"domain:podcast_mcp.edits.new_logic"},
        ),
        (
            "def f():\n    from podcast_mcp.engines.ffmpeg import run",
            "podcast_mcp.mcp.tools.new",
            {"domain:podcast_mcp.engines.ffmpeg"},
        ),
        ("from podcast_mcp.pipeline.meta import X", "podcast_mcp.cli.pipeline", set()),
        ("from podcast_mcp import edits", "podcast_mcp.cli.review", {"domain:podcast_mcp.edits"}),
        ("from . import edits", "podcast_mcp.cli.review", set()),
        (
            "from podcast_mcp.gui import job_events",
            "podcast_mcp.mcp.tools.review",
            {"adapter:podcast_mcp.gui", "adapter:podcast_mcp.gui.job_events"},
        ),
        (
            "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n"
            "    from podcast_mcp.edits.new_logic import Shape",
            "podcast_mcp.cli.review",
            set(),
        ),
        (
            "from podcast_mcp.gui.job_events import stream_job_events",
            "podcast_mcp.mcp.tools.review",
            {"adapter:podcast_mcp.gui.job_events"},
        ),
        (
            "from ...cli.main import app",
            "podcast_mcp.gui.routes.shares",
            {"adapter:podcast_mcp.cli.main"},
        ),
        (
            "from podcast_mcp.cli.context import ctx",
            "podcast_mcp.util.other",
            {"util:podcast_mcp.cli.context"},
        ),
        ("from podcast_mcp.edits.anything import x", "podcast_mcp.services.record.service", set()),
        (
            "import typing\nif typing.TYPE_CHECKING:\n"
            "    from podcast_mcp.edits.hidden import Shape\n"
            "else:\n    from podcast_mcp.edits.runtime import run",
            "podcast_mcp.cli.review",
            {"domain:podcast_mcp.edits.runtime"},
        ),
    ],
)
def test_architecture_guard_fails_on_a_synthetic_new_edge(
    source: str, module: str, expected: set[str]
) -> None:
    assert _architecture_violations(source, module) == expected


def test_architecture_scan_reports_the_same_edges_and_violations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    adapter = tmp_path / "src/podcast_mcp/cli"
    adapter.mkdir(parents=True)
    (adapter / "review.py").write_text(
        "from podcast_mcp.edits.new_logic import run\nfrom podcast_mcp.gui import new_view\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(sys.modules[__name__], "_ROOT", tmp_path)
    found, violations = _scan_architecture()
    assert found == {
        "domain": {"podcast_mcp.cli.review": {"podcast_mcp.edits.new_logic"}},
        "adapter": {"podcast_mcp.cli.review": {"podcast_mcp.gui", "podcast_mcp.gui.new_view"}},
        "util": {},
    }
    assert violations == [
        "podcast_mcp.cli.review: adapter:podcast_mcp.gui",
        "podcast_mcp.cli.review: adapter:podcast_mcp.gui.new_view",
        "podcast_mcp.cli.review: domain:podcast_mcp.edits.new_logic",
    ]


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


def _in(target: str, package: str) -> bool:
    return target == package or target.startswith(package + ".")


def _violations(
    source: str, module: str, registry: dict[str, set[str]], exports: dict[str, set[str]]
) -> set[str]:
    owner = next((context for context in registry if module.startswith(context + ".")), None)
    violations: set[str] = set()
    modules: set[str] = set()
    imports: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            target = node.module or ""
            if node.level:
                target = resolve_name("." * node.level + target, module.rpartition(".")[0])
            elif target == _BASE:
                violations.add(_BASE)
            modules.add(target)
            imports.add(target)
            imports.update(f"{target}.{alias.name}" for alias in node.names)
    for target in modules:
        if _in(target, "podcast_mcp.gui.routes") and module.startswith(_BASE + "."):
            violations.add("podcast_mcp.gui.routes")
        if (
            owner
            and any(_in(target, adapter) for adapter in _ADAPTERS)
            and not any(_in(target, allowed) for allowed in _ADAPTER_EXCEPTIONS.get(module, ()))
        ):
            violations.add(target)
    for target in imports:
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
        (
            "from podcast_mcp.gui.job_events import stream_job_events",
            _BASE + ".remote_mcp.tools",
            {"podcast_mcp.gui.job_events"},
        ),
        (
            "from podcast_mcp.services.jobs import shared_job_manager",
            _BASE + ".remote_mcp.tools",
            set(),
        ),
        (
            "from podcast_mcp.services.jobs.manager import JobManager",
            "podcast_mcp.gui.routes.pipeline",
            {_BASE + ".jobs.manager"},
        ),
        (
            "from podcast_mcp.gui.bind import gui_server_deps_available",
            _BASE + ".app.gui_launch",
            set(),
        ),
        ("import podcast_mcp.cli.main", _BASE + ".record.__init__", {"podcast_mcp.cli.main"}),
        (
            "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n"
            "    from podcast_mcp.services.collaboration import share as hidden",
            "podcast_mcp.cli.review",
            {_BASE + ".collaboration.share"},
        ),
        (
            "def f():\n    from podcast_mcp.services import jobs as job_context",
            _BASE + ".record.service",
            {_BASE},
        ),
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


def _relay_references(source: str) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.update(a.name for a in node.names if a.name.split(".")[0] == "podcast_relay")
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and (node.module or "").split(".")[0] == "podcast_relay":
                found.add(node.module or "")
        elif (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and "podcast_relay" in node.value
        ):
            found.add(node.value)
    return found


def test_podcast_mcp_never_references_podcast_relay() -> None:
    """The relay is a separate deployable; shared wire code lives in util/relay_protocol."""
    violations = [
        f"{path.relative_to(_ROOT)}: {ref}"
        for path in sorted((_ROOT / "src/podcast_mcp").rglob("*.py"))
        for ref in sorted(_relay_references(path.read_text()))
    ]
    assert not violations, (
        "podcast_mcp must not reference podcast_relay (move shared code to "
        "podcast_mcp.util.relay_protocol):\n" + "\n".join(violations)
    )


@pytest.mark.parametrize(
    "source",
    [
        "import podcast_relay",
        "from podcast_relay.protocol import msg",
        "def f():\n    from podcast_relay.share_claims import sign_share_claim",
        "importlib.import_module('podcast_relay.app')",
    ],
)
def test_relay_reference_guard_fails_on_a_synthetic_edge(source: str) -> None:
    assert _relay_references(source)


def test_relay_reference_guard_allows_the_neutral_package() -> None:
    assert not _relay_references("from podcast_mcp.util.relay_protocol.protocol import msg")
