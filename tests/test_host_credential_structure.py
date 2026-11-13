"""Only ``host_credential`` reads the owner's credential out of a request (#3810).

A route that picked the token out of a header or a query by hand would keep working on a host
whose credential is the session cookie, and refuse its owner there. So no module under ``gui/``
but the resolver names the token header or the page token, declares a token parameter, or reads
the token query.
"""

from __future__ import annotations

import ast
from pathlib import Path

GUI = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp" / "gui"
RESOLVER = GUI / "routes" / "deps.py"
CREDENTIAL_NAMES = {"x-podcast-token", "x_podcast_token", "session_token"}
PARAMETER_FACTORIES = {"Query", "Header"}


def hand_reads(source: str) -> list[str]:
    """What in *source* reads the owner's credential itself, as short descriptions."""
    found: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value.lower() in CREDENTIAL_NAMES:
                found.append(f"the name {node.value!r} at line {node.lineno}")
        elif isinstance(node, ast.arg) and node.arg == "x_podcast_token":
            found.append(f"a parameter named x_podcast_token at line {node.lineno}")
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            found.extend(_token_parameters(node))
        elif _is_token_query_read(node):
            found.append(f"a token query read at line {node.lineno}")
    return found


def _token_parameters(function: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    arguments = function.args
    positional = [*arguments.posonlyargs, *arguments.args]
    defaults = [None] * (len(positional) - len(arguments.defaults)) + list(arguments.defaults)
    pairs = [
        *zip(positional, defaults, strict=True),
        *zip(arguments.kwonlyargs, arguments.kw_defaults, strict=True),
    ]
    return [
        f"a token {default.func.id}() parameter at line {argument.lineno}"
        for argument, default in pairs
        if argument.arg == "token"
        and isinstance(default, ast.Call)
        and isinstance(default.func, ast.Name)
        and default.func.id in PARAMETER_FACTORIES
    ]


def _is_token_query_read(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "get"
        and isinstance(node.func.value, ast.Attribute)
        and node.func.value.attr == "query_params"
        and bool(node.args)
        and isinstance(node.args[0], ast.Constant)
        and node.args[0].value == "token"
    )


def test_no_gui_module_but_the_resolver_reads_the_credential_itself() -> None:
    offenders = {
        str(path.relative_to(GUI)): reads
        for path in sorted(GUI.rglob("*.py"))
        if path != RESOLVER and (reads := hand_reads(path.read_text(encoding="utf-8")))
    }

    assert offenders == {}


def test_the_resolver_is_the_one_module_that_does() -> None:
    assert len(hand_reads(RESOLVER.read_text(encoding="utf-8"))) > 0


def test_the_check_sees_each_way_of_reading_the_token() -> None:
    sources = {
        "header": "def f(request):\n    return request.headers.get('X-Podcast-Token')\n",
        "parameter": "def f(x_podcast_token=None):\n    return x_podcast_token\n",
        "token query parameter": "def f(token=Query(None)):\n    return token\n",
        "token header parameter": "def f(token=Header(None)):\n    return token\n",
        "token query read": "def f(request):\n    return request.query_params.get('token')\n",
        "page token": "def f(request):\n    return request.query_params['session_token']\n",
    }

    assert {name: len(hand_reads(source)) for name, source in sources.items()} == {
        "header": 1,
        "parameter": 1,
        "token query parameter": 1,
        "token header parameter": 1,
        "token query read": 1,
        "page token": 1,
    }


def test_a_path_parameter_named_token_is_not_a_credential_read() -> None:
    assert hand_reads("def review(token: str, request):\n    return token\n") == []
