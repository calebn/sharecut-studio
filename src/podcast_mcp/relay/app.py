"""Shim - use ``podcast_relay.app`` (full module alias including private helpers)."""

from __future__ import annotations

import sys

import podcast_relay.app as _impl

sys.modules[__name__] = _impl
