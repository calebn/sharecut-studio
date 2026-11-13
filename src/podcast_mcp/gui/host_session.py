"""The owner's browser sessions on a host whose loopback is not trusted.

Another app on the device can reach the loopback port, so the owner's web view proves who it is
with a cookie the server minted for it. The host process that starts the engine holds a
single-use exchange code; the web view's first request trades it for a session id the server
keeps in memory, and every owner request after that carries the id as a cookie.

``HostSessions`` is the one place a code or a session id is minted, redeemed, expired or checked.
Nothing is written to disk, so a new launch starts with no sessions and an old cookie matches
nothing.
"""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Callable

CODE_TTL_SEC = 60.0
_SECRET_BYTES = 32


def _find(candidates: list[str], presented: str) -> str | None:
    """The candidate equal to *presented*, compared in constant time against every candidate."""
    wanted = presented.encode(errors="replace")
    match: str | None = None
    for candidate in candidates:
        if secrets.compare_digest(candidate.encode(), wanted):
            match = candidate
    return match


class HostSessions:
    """Exchange codes that each open one session, and the sessions they opened.

    A code is valid until it is used once or ``code_ttl_sec`` passes, whichever comes first. A
    session lasts until the process ends. ``clock`` is injected so a test advances time itself.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        code_ttl_sec: float = CODE_TTL_SEC,
    ) -> None:
        self._clock = clock
        self._code_ttl_sec = code_ttl_sec
        self._lock = threading.Lock()
        self._codes: dict[str, float] = {}
        self._sessions: set[str] = set()

    def issue_code(self) -> str:
        """A new single-use code, good for ``code_ttl_sec``."""
        code = secrets.token_urlsafe(_SECRET_BYTES)
        with self._lock:
            now = self._clock()
            self._drop_expired(now)
            self._codes[code] = now + self._code_ttl_sec
        return code

    def redeem(self, code: str) -> str | None:
        """Trade *code* for a new session id, or None when it is unknown, used or expired.

        The code is spent by the attempt that matches it, so a second use fails even when the
        first one's response never arrived.
        """
        with self._lock:
            self._drop_expired(self._clock())
            matched = _find(list(self._codes), code)
            if matched is None:
                return None
            del self._codes[matched]
            session_id = secrets.token_urlsafe(_SECRET_BYTES)
            self._sessions.add(session_id)
            return session_id

    def is_live(self, session_id: str | None) -> bool:
        if not session_id:
            return False
        with self._lock:
            return _find(list(self._sessions), session_id) is not None

    def _drop_expired(self, now: float) -> None:
        self._codes = {code: expiry for code, expiry in self._codes.items() if expiry > now}
