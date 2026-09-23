"""Load repository scripts as fresh modules for tests."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import cast

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load_script(name: str, *, register: bool = False) -> ModuleType:
    """Execute a script afresh, optionally registering it for import-time introspection.

    Most callers historically left ``sys.modules`` untouched. Scripts whose
    dataclasses inspect their defining module need ``register=True`` instead.
    """
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load script {name!r}")
    module = importlib.util.module_from_spec(spec)
    if not register:
        spec.loader.exec_module(module)
        return module

    previous = sys.modules.get(name)
    had_previous = name in sys.modules
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        if had_previous:
            # Import-blocking None entries are valid at runtime despite the
            # typeshed annotation for sys.modules values.
            sys.modules[name] = cast(ModuleType, previous)
        else:
            sys.modules.pop(name, None)
        raise
    return module
