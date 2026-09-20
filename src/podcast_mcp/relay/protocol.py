"""Shim - use ``podcast_relay.protocol``."""

from __future__ import annotations

import sys

import podcast_relay.protocol as _impl

sys.modules[__name__] = _impl
