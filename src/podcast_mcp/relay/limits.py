"""Shim - use ``podcast_relay.limits``."""

from __future__ import annotations

import sys

import podcast_relay.limits as _impl

sys.modules[__name__] = _impl
