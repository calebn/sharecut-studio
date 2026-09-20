"""Shim - use ``podcast_relay.version``."""

from __future__ import annotations

import sys

import podcast_relay.version as _impl

sys.modules[__name__] = _impl
