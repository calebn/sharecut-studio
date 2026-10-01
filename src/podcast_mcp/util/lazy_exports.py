from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from importlib import import_module


def resolve_export(
    name: str,
    *,
    package: str,
    namespace: MutableMapping[str, object],
    modules: Mapping[str, str],
) -> object:
    try:
        module = modules[name]
    except KeyError:
        raise AttributeError(f"module {package!r} has no attribute {name!r}") from None
    value = getattr(import_module(f"{package}.{module}"), name)
    namespace[name] = value
    return value
