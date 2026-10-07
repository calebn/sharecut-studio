"""The one rule both MCP servers use for a tool failure (``util/tool_refusal.py``, #1182).

A refusal (a ``CodedError`` or a busy lock) keeps its message and code; anything else is a
crash and gets no text from the exception. Guest remote MCP applies the same rule with host
paths redacted from the refusal's message; the owner server keeps them (the owner supplied
them).
"""

from __future__ import annotations

import pickle

import pytest
from filelock import Timeout

from podcast_mcp.util.coded_error import (
    CodedError,
    CodedFileNotFoundError,
    CodedKeyError,
    CodedValueError,
)
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE, ProjectBusyError
from podcast_mcp.util.tool_refusal import (
    ToolRefusal,
    crash_tool_result,
    lock_timeout_cause,
    refusal_tool_result,
    tool_refusal,
)

HOST_PATH = "/Users/host/private/episode/raw/host.wav"


def test_coded_error_is_a_refusal_with_its_message_and_code() -> None:
    exc = CodedKeyError("comment not found: c9", code="comment_not_found")
    assert tool_refusal(exc) == ToolRefusal("comment not found: c9", "comment_not_found")
    assert tool_refusal(exc, for_guest=True) == tool_refusal(exc)


def test_refusal_found_through_the_cause_chain() -> None:
    try:
        try:
            raise CodedValueError("timeline_start must be >= 0", code="invalid_range")
        except CodedValueError as inner:
            raise RuntimeError("wrapped") from inner
    except RuntimeError as outer:
        assert tool_refusal(outer) == ToolRefusal("timeline_start must be >= 0", "invalid_range")


@pytest.mark.parametrize(
    "exc",
    [
        ValueError(f"boom at {HOST_PATH}"),
        KeyError("internal_key"),
        TypeError("helper() missing 1 required positional argument"),
        RuntimeError(f"ffmpeg failed: {HOST_PATH}"),
        PermissionError(13, "Permission denied", HOST_PATH),
    ],
)
def test_anything_else_is_a_crash(exc: Exception) -> None:
    assert tool_refusal(exc) is None
    assert tool_refusal(exc, for_guest=True) is None


def test_busy_lock_is_project_busy_without_the_lock_path() -> None:
    refusal = tool_refusal(Timeout("/some/secret/lock/path"), for_guest=True)
    assert refusal is not None
    assert refusal.code == PROJECT_BUSY_CODE
    assert "/secret" not in refusal.message
    busy = ProjectBusyError("/some/secret/episode.project.json.lock")
    assert lock_timeout_cause(RuntimeError("x")) is None
    assert tool_refusal(busy) == ToolRefusal(str(busy), PROJECT_BUSY_CODE)


def test_guest_refusal_redacts_host_paths_owner_keeps_them() -> None:
    exc = CodedFileNotFoundError(f"raw media not found: {HOST_PATH}", code="file_not_found")
    assert tool_refusal(exc) == ToolRefusal(f"raw media not found: {HOST_PATH}", "file_not_found")
    guest = tool_refusal(exc, for_guest=True)
    assert guest == ToolRefusal("raw media not found: [path]", "file_not_found")


def test_windows_and_home_paths_are_redacted_for_guests() -> None:
    for path in (r"C:\Users\host\episode\raw\a.wav", "~/episodes/one/raw/a.wav"):
        refusal = tool_refusal(CodedValueError(f"bad media {path}", code="x"), for_guest=True)
        assert refusal is not None
        assert path not in refusal.message
        assert refusal.message == "bad media [path]"


def test_refusal_and_crash_results_have_the_owner_server_shape() -> None:
    refusal = refusal_tool_result(ToolRefusal("comment not found: c9", "comment_not_found"))
    assert refusal.is_error is True
    assert [c.text for c in refusal.content] == ["comment not found: c9"]
    assert refusal.structured_content == {
        "ok": False,
        "error": "comment not found: c9",
        "error_code": "comment_not_found",
    }
    crash = crash_tool_result("get_comment_tool")
    assert crash.is_error is True
    assert [c.text for c in crash.content] == ["Error executing tool get_comment_tool"]
    assert crash.structured_content is None


class _NamedGuard(CodedError, ValueError):
    code = "named_guard"


@pytest.mark.parametrize(
    "exc",
    [
        CodedValueError("unknown track_id: 'x'", code="track_not_found"),
        CodedKeyError("comment not found: c9", code="comment_not_found"),
        CodedFileNotFoundError("audio file not found: a.wav", code="file_not_found"),
        _NamedGuard("the transcript changed"),
    ],
)
def test_coded_errors_round_trip_through_pickle(exc: CodedError) -> None:
    exc.extra = "kept"  # type: ignore[attr-defined]
    copy = pickle.loads(pickle.dumps(exc))
    assert type(copy) is type(exc)
    assert str(copy) == str(exc)
    assert copy.code == exc.code
    assert copy.args == exc.args
    assert copy.extra == "kept"  # type: ignore[attr-defined]
