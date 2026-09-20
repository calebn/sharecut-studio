"""Shipped CSS !important is consent-gated (see test_css_policy)."""

from __future__ import annotations

from test_css_policy import test_important_and_layer_are_consent_gated


def test_shipped_css_has_no_important() -> None:
    test_important_and_layer_are_consent_gated()
