from __future__ import annotations

import os
from collections.abc import Mapping


def powershell_environment(*, overrides: Mapping[str, str] | None = None) -> dict[str, str]:
    inherited = dict(os.environ)
    if overrides is not None:
        inherited.update(overrides)
    return {key: value for key, value in inherited.items() if key.casefold() != "psmodulepath"}
