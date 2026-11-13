"""Wire names of the owner's browser session on a host whose loopback is not trusted.

The server mints the session (``gui/host_session.py``); diagnostics redaction reads the same
names to keep the code and the cookie out of a bundle. Pure strings, so ``util`` can hold them.
"""

from __future__ import annotations

EXCHANGE_PATH = "/api/session/exchange"
EXCHANGE_PARAM = "code"
SESSION_COOKIE = "sharecut_host_session"
