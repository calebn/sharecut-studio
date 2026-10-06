"""Hatch build hook that ships the Sharecut Studio web build when one exists.

A static ``force-include`` of the web build fails every build in a tree without
``npm run build``, so the hook adds it only when ``index.html`` is there. Paths
come from ``[tool.hatch.build.hooks.custom]`` in ``pyproject.toml``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class WebBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        # Editable installs import from src/ and serve the live checkout build.
        if version == "editable":
            return
        dist = Path(self.root) / self.config["web-dist"]
        if not (dist / "index.html").is_file():
            return
        # The sdist keeps the checkout layout so a wheel built from it finds the build too.
        target = self.config["wheel-web-dist" if self.target_name == "wheel" else "web-dist"]
        build_data["force_include"][str(dist)] = target
