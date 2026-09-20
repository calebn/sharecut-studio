"""Soft-load ExtensionBackend entry points - failures are absent, not fatal."""

from __future__ import annotations

import logging
import os
from importlib.metadata import entry_points
from typing import Any

from podcast_mcp.extensions.api_version import HOST_API_VERSION
from podcast_mcp.extensions.registry import FeatureRegistry
from podcast_mcp.extensions.spi import ExtensionBackend

logger = logging.getLogger(__name__)

ENTRY_POINT_GROUP = "podcast_mcp.extensions"
ENV_EXTENSIONS = "PODCAST_EXTENSIONS"


def _allowlist() -> set[str] | None:
    """None = load all; empty set = load none; else name allowlist."""
    raw = os.environ.get(ENV_EXTENSIONS)
    if raw is None:
        return None
    if raw.strip() == "":
        return set()
    return {p.strip() for p in raw.split(",") if p.strip()}


def _iter_entry_points() -> list[Any]:
    eps = entry_points()
    select = getattr(eps, "select", None)
    if callable(select):
        return list(select(group=ENTRY_POINT_GROUP))
    grouped = getattr(eps, "get", None)
    if callable(grouped):
        return list(grouped(ENTRY_POINT_GROUP, []))
    return []


def load_extensions(
    *,
    host_api_version: int = HOST_API_VERSION,
    extra_backends: list[ExtensionBackend] | None = None,
) -> FeatureRegistry:
    """Discover and contribute extensions into a fresh FeatureRegistry."""
    registry = FeatureRegistry()
    allow = _allowlist()
    backends: list[tuple[str, ExtensionBackend]] = []

    def _canonical_name(source_name: str, backend: ExtensionBackend) -> str:
        return str(getattr(backend, "name", source_name))

    if allow is not None and len(allow) == 0:
        logger.info("%s empty - loading no extensions", ENV_EXTENSIONS)
    else:
        for ep in _iter_entry_points():
            if allow is not None and ep.name not in allow:
                continue
            try:
                factory = ep.load()
                backend = factory() if callable(factory) else factory
                backends.append((ep.name, backend))
            except Exception:
                logger.exception("skip extension entry point %s", ep.name)

    if extra_backends:
        for i, backend in enumerate(extra_backends):
            name = getattr(backend, "name", f"extra-{i}")
            if allow is not None and len(allow) == 0:
                continue
            if allow is not None and name not in allow:
                continue
            backends.append((str(name), backend))

    # Editable/source installs may not expose entry points yet. Collaboration is
    # part of the FOSS distribution and is the only product surface loaded by
    # the built-in fallback. Private providers register their own entry points.
    if (allow is None or "collaboration" in allow) and not any(
        _canonical_name(name, backend) == "collaboration" for name, backend in backends
    ):
        try:
            from podcast_mcp.extensions.collaboration import create as create_collaboration

            backends.append(("collaboration", create_collaboration()))
        except Exception:
            logger.exception("skip built-in collaboration extension fallback")

    if allow is None and not any(
        _canonical_name(name, backend) == "example" for name, backend in backends
    ):
        try:
            from podcast_mcp.extensions.example import create as create_example

            backends.append(("example", create_example()))
        except Exception:
            logger.exception("skip built-in example extension fallback")

    seen_names: set[str] = set()
    for source_name, backend in backends:
        name = _canonical_name(source_name, backend)
        if name in seen_names:
            logger.warning(
                "skip duplicate extension %s from %s; first registration wins",
                name,
                source_name,
            )
            continue
        seen_names.add(name)
        try:
            if not backend.compatible(host_api_version):
                logger.warning(
                    "skip extension %s: incompatible with host api %s",
                    name,
                    host_api_version,
                )
                continue
            backend.contribute(registry)
        except Exception:
            logger.exception("skip extension %s during contribute", name)

    return registry


def apply_gui_extensions(app: Any, registry: FeatureRegistry) -> None:
    """Mount middleware and routers from the registry onto a FastAPI app."""
    for cls, kwargs in registry.middlewares:
        app.add_middleware(cls, **kwargs)
    for router in registry.routers:
        app.include_router(router)
    app.state.feature_registry = registry


def apply_cli_extensions(
    typer_app: Any, registry: FeatureRegistry | None = None
) -> FeatureRegistry:
    """Run CLI registrars (e.g. share mint commands) from loaded extensions."""
    reg = registry if registry is not None else load_extensions()
    for registrar in reg.cli_registrars:
        registrar(typer_app)
    return reg
