from __future__ import annotations

import pytest

from podcast_mcp.util.mcp_call_tool import wrap_call_tool


class _FakeServer:
    def __init__(self) -> None:
        self.seen: list[tuple] = []

    async def call_tool(self, name, arguments, context=None, *args, **kwargs):
        self.seen.append((name, arguments, context, args, kwargs))
        return "ok"


@pytest.mark.asyncio
async def test_wrap_call_tool_forwards_context_and_extra_args():
    server = _FakeServer()
    arounds = []

    async def around(name, arguments, context, call_next):
        arounds.append((name, arguments, context))
        return await call_next(arguments)

    wrap_call_tool(server, around)
    assert await server.call_tool("t", {"a": 1}, "ctx", "extra", flag=True) == "ok"
    assert arounds == [("t", {"a": 1}, "ctx")]
    assert server.seen == [("t", {"a": 1}, "ctx", ("extra",), {"flag": True})]


@pytest.mark.asyncio
async def test_wrap_call_tool_defaults_context_to_none():
    server = _FakeServer()

    async def around(name, arguments, context, call_next):
        return await call_next(arguments)

    wrap_call_tool(server, around)
    await server.call_tool("t", {})
    assert server.seen == [("t", {}, None, (), {})]


@pytest.mark.asyncio
async def test_wrap_call_tool_around_can_rewrite_arguments_or_short_circuit():
    server = _FakeServer()

    async def around(name, arguments, context, call_next):
        if name == "skip":
            return "short"
        return await call_next({**arguments, "injected": True})

    wrap_call_tool(server, around)
    assert await server.call_tool("skip", {}) == "short"
    assert await server.call_tool("t", {"a": 1}) == "ok"
    assert server.seen == [("t", {"a": 1, "injected": True}, None, (), {})]
