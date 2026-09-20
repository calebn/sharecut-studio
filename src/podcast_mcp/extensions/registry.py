"""Feature registry - contributions from ExtensionBackend.contribute()."""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from podcast_mcp.extensions.features import (
    EXPERIMENTAL_FEATURE_IDS,
    FEATURE_SHARE_ROUTES,
    STABLE_FEATURE_IDS,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Contribution:
    """One contribution to a feature/slot id."""

    feature_id: str
    source: str
    payload: Any = None
    version: int = 1


@dataclass
class FeatureRegistry:
    """Merge contributions from soft-loaded extensions."""

    _by_id: dict[str, list[Contribution]] = field(default_factory=dict)
    _known: frozenset[str] = field(
        default_factory=lambda: STABLE_FEATURE_IDS | EXPERIMENTAL_FEATURE_IDS
    )
    _route_mounts: list[Any] = field(default_factory=list)
    _mcp_registrars: list[Callable[[Any], None]] = field(default_factory=list)
    _cli_registrars: list[Callable[[Any], None]] = field(default_factory=list)
    _middlewares: list[Any] = field(default_factory=list)
    _spa_hooks: list[Callable[..., Any]] = field(default_factory=list)

    def has(self, feature_id: str) -> bool:
        return bool(self._by_id.get(feature_id))

    def get(self, feature_id: str) -> list[Contribution]:
        return list(self._by_id.get(feature_id, ()))

    def feature_ids(self) -> list[str]:
        return sorted(self._by_id.keys())

    def add(
        self,
        feature_id: str,
        *,
        source: str,
        payload: Any = None,
        version: int = 1,
    ) -> None:
        if feature_id not in self._known:
            logger.warning(
                "extension %s contributed unknown feature id %r - ignored",
                source,
                feature_id,
            )
            return
        self._by_id.setdefault(feature_id, []).append(
            Contribution(
                feature_id=feature_id,
                source=source,
                payload=payload,
                version=version,
            )
        )

    def add_router(
        self,
        router: Any,
        *,
        source: str,
        feature_id: str | None = FEATURE_SHARE_ROUTES,
    ) -> None:
        self._route_mounts.append(router)
        if feature_id is not None:
            self.add(feature_id, source=source, payload={"kind": "router"})

    def add_middleware(self, middleware_cls: Any, *, source: str, **kwargs: Any) -> None:
        self._middlewares.append((middleware_cls, kwargs))

    def add_mcp_registrar(self, registrar: Callable[[Any], None], *, source: str) -> None:
        self._mcp_registrars.append(registrar)
        self.add("share.mcp_tools", source=source, payload={"kind": "mcp"})

    def add_cli_registrar(self, registrar: Callable[[Any], None], *, source: str) -> None:
        self._cli_registrars.append(registrar)
        self.add("share.cli", source=source, payload={"kind": "cli"})

    def add_spa_hook(self, hook: Callable[..., Any], *, source: str) -> None:
        self._spa_hooks.append(hook)
        self.add("share.ui.routes", source=source, payload={"kind": "spa"})

    @property
    def routers(self) -> Sequence[Any]:
        return tuple(self._route_mounts)

    @property
    def middlewares(self) -> Sequence[tuple[Any, dict[str, Any]]]:
        return tuple(self._middlewares)

    @property
    def mcp_registrars(self) -> Sequence[Callable[[Any], None]]:
        return tuple(self._mcp_registrars)

    @property
    def cli_registrars(self) -> Sequence[Callable[[Any], None]]:
        return tuple(self._cli_registrars)

    @property
    def spa_hooks(self) -> Sequence[Callable[..., Any]]:
        return tuple(self._spa_hooks)

    def to_manifest(self) -> dict[str, Any]:
        from podcast_mcp.extensions.api_version import HOST_API_VERSION

        return {
            "api_version": HOST_API_VERSION,
            "features": self.feature_ids(),
        }
