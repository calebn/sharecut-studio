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


def _http_flagged(source: str) -> list[str]:
    return [scope for _node, scope in lint.http_violations(ast.parse(source))]


def test_bare_http_exceptions_are_flagged_and_coded_ones_are_not():
    source = (
        "from fastapi import HTTPException\n"
        "def a():\n    raise HTTPException(status_code=404, detail='x')\n"
        "def b():\n    raise coded_http_error(404, 'x', code='x_missing')\n"
        "def c():\n    return fastapi.HTTPException(400, 'y')\n"
        "from starlette.exceptions import HTTPException as HE\n"
        "def d():\n    raise HE(status_code=400, detail='z')\n"
    )
    assert _http_flagged(source) == ["a", "c", "d"]


def test_gui_host_routes_build_http_errors_only_through_coded_http_error():
    assert lint.check_http(lint.http_scoped_files()) == []
