from __future__ import annotations

import sys
from collections.abc import Callable


def cleanup(actions: list[Callable[[], None]]) -> None:
    original = sys.exc_info()[1]
    first: BaseException | None = None
    for action in actions:
        try:
            action()
        except BaseException as exc:
            if original is not None:
                original.add_note("Registry cleanup could not release an owned resource.")
            elif first is None:
                first = exc
    if first is not None:
        raise first
