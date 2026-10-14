"""The coded-error lint flags bare refusals and leaves pydantic validators and the tree clean."""

from __future__ import annotations

import ast

from script_loader import load_script

lint = load_script("check_coded_errors")


def _flagged(source: str) -> list[tuple[str, str]]:
    return [
        (lint._raised_name(node.exc), scope) for node, scope in lint.violations(ast.parse(source))
    ]


def test_bare_refusals_are_flagged_and_validators_are_not():
    source = (
        "from pydantic import field_validator\n"
        "def a():\n    raise PermissionError('no')\n"
        "def b():\n    raise ValueError\n"
        "def c():\n    raise CodedValueError('x', code='x')\n"
        "class M:\n"
        "    @field_validator('x')\n"
        "    def v(cls, x):\n        raise ValueError('bad')\n"
    )
    assert _flagged(source) == [("PermissionError", "a"), ("ValueError", "b")]


def test_services_and_registry_raise_only_coded_refusals():
    assert lint.check(lint.scoped_files()) == []
