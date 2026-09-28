"""Coalesce presence hub publishes to at most 10 Hz per project key."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

from podcast_mcp.services.session_sync.hub import get_hub

_lock = threading.Lock()
_in_cooldown: set[str] = set()
_pending: dict[str, Callable[[], list[dict[str, Any]]]] = {}
_timers: dict[str, threading.Timer] = {}
_timer_factory: Callable[[float, Callable[[], None]], threading.Timer] = threading.Timer


def reset() -> None:
    """Cancel timers. Tests call this between cases."""
    with _lock:
        for timer in _timers.values():
            timer.cancel()
        _timers.clear()
        _pending.clear()
        _in_cooldown.clear()


def clear_key(project_key: str) -> None:
    """Drop coalescer state when the last hub subscriber for ``project_key`` leaves."""
    with _lock:
        timer = _timers.pop(project_key, None)
        _pending.pop(project_key, None)
        _in_cooldown.discard(project_key)
    if timer is not None:
        timer.cancel()


def set_timer_factory(
    factory: Callable[[float, Callable[[], None]], threading.Timer] | None,
) -> None:
    global _timer_factory
    _timer_factory = factory or threading.Timer


def schedule(
    project_key: str,
    build_events: Callable[[], list[dict[str, Any]]],
    *,
    min_interval_s: float = 0.1,
) -> None:
    """Publish now, or coalesce into the trailing tick, for ``project_key``.

    ``build_events`` runs on both the leading and the trailing edge (its own diffing
    decides what changed since the last run) and its events are published in order.
    """
    with _lock:
        if project_key in _in_cooldown:
            _pending[project_key] = build_events
            return
        _in_cooldown.add(project_key)
    try:
        _publish_all(project_key, build_events())
    except Exception:
        with _lock:
            _in_cooldown.discard(project_key)
            _pending.pop(project_key, None)
        raise
    _arm(project_key, min_interval_s)


def _publish_all(project_key: str, events: list[dict[str, Any]]) -> None:
    hub = get_hub()
    for event in events:
        hub.publish(project_key, event)


def _arm(project_key: str, min_interval_s: float) -> None:
    def on_timer() -> None:
        with _lock:
            pending = _pending.pop(project_key, None)
            if pending is None:
                _in_cooldown.discard(project_key)
                _timers.pop(project_key, None)
                return
        try:
            _publish_all(project_key, pending())
        except Exception:
            with _lock:
                _in_cooldown.discard(project_key)
                _timers.pop(project_key, None)
                _pending.pop(project_key, None)
            raise
        _arm(project_key, min_interval_s)

    timer = _timer_factory(min_interval_s, on_timer)
    timer.daemon = True
    with _lock:
        old = _timers.pop(project_key, None)
        if old is not None:
            old.cancel()
        _timers[project_key] = timer
    timer.start()
