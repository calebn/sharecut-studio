"""The one rule both MCP servers use for a tool failure (``util/tool_refusal.py``, #1182).

A refusal (a ``CodedError`` or a busy lock) keeps its message and code; anything else is a
crash and gets no text from the exception. Guest remote MCP applies the same rule with host
paths redacted from the refusal's message; the owner server keeps them (the owner supplied
them).
"""

from __future__ import annotations

import pickle
from contextlib import closing

import pytest
from filelock import Timeout

from podcast_mcp.util.coded_error import (
    GENERIC_GUEST_MESSAGE,
    CodedError,
    CodedFileNotFoundError,
    CodedKeyError,
    CodedValueError,
)
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE, ProjectBusyError
from podcast_mcp.util.tool_refusal import (
    ToolRefusal,
    crash_tool_result,
    guest_failure_detail,
    lock_timeout_cause,
    refusal_tool_result,
    tool_refusal,
)

HOST_PATH = "/Users/host/private/episode/raw/host.wav"


def test_coded_error_is_a_refusal_with_its_message_and_code() -> None:
    exc = CodedKeyError("comment not found: c9", code="comment_not_found")
    assert tool_refusal(exc) == ToolRefusal("comment not found: c9", "comment_not_found")
    assert tool_refusal(exc, for_guest=True) == ToolRefusal(
        GENERIC_GUEST_MESSAGE, "comment_not_found"
    )


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
    assert refusal.message == "This project is busy; try again."
    assert "/secret" not in refusal.message
    busy = ProjectBusyError("/some/secret/episode.project.json.lock")
    assert lock_timeout_cause(RuntimeError("x")) is None
    assert tool_refusal(busy) == ToolRefusal(str(busy), PROJECT_BUSY_CODE)
    assert tool_refusal(busy, for_guest=True) == refusal


def test_guest_refusal_withholds_host_paths_owner_keeps_them() -> None:
    exc = CodedFileNotFoundError(f"raw media not found: {HOST_PATH}", code="file_not_found")
    assert tool_refusal(exc) == ToolRefusal(f"raw media not found: {HOST_PATH}", "file_not_found")
    guest = tool_refusal(exc, for_guest=True)
    assert guest == ToolRefusal(GENERIC_GUEST_MESSAGE, "file_not_found")


def test_windows_and_home_paths_are_withheld_from_guests() -> None:
    for path in (r"C:\Users\host\episode\raw\a.wav", "~/episodes/one/raw/a.wav"):
        refusal = tool_refusal(CodedValueError(f"bad media {path}", code="x"), for_guest=True)
        assert refusal is not None
        assert path not in refusal.message
        assert refusal.message == GENERIC_GUEST_MESSAGE


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


def test_guest_failure_detail_is_a_refusals_guest_message_and_nothing_for_a_crash() -> None:
    refusal = CodedValueError(f"bad window in {HOST_PATH}", code="invalid_range")

    assert guest_failure_detail(refusal) == GENERIC_GUEST_MESSAGE
    assert guest_failure_detail(RuntimeError(f"ffmpeg died on {HOST_PATH}")) is None
    assert guest_failure_detail(OSError(2, "No such file", HOST_PATH)) is None


def test_sqlite_write_lock_is_a_fixed_refusal(tmp_path):
    import sqlite3

    database = tmp_path / "private.sqlite"
    with (
        closing(sqlite3.connect(database, timeout=0, isolation_level=None)) as first,
        first,
        closing(sqlite3.connect(database, timeout=0, isolation_level=None)) as second,
        second,
    ):
        first.execute("CREATE TABLE writes (value TEXT)")
        first.execute("BEGIN IMMEDIATE")
        try:
            with pytest.raises(sqlite3.OperationalError) as failure:
                second.execute("BEGIN IMMEDIATE")
            assert tool_refusal(failure.value, for_guest=True) == ToolRefusal(
                "This project is busy; try again.", "project_busy"
            )
            assert tool_refusal(failure.value) == ToolRefusal(
                "Project is busy in another process; try again", "project_busy"
            )
        finally:
            first.rollback()


def test_sqlite_error_code_prevents_false_busy_refusal():
    import sqlite3

    error = sqlite3.OperationalError("busy private secret")
    error.sqlite_errorcode = sqlite3.SQLITE_ERROR
    assert tool_refusal(error, for_guest=True) is None


@pytest.mark.parametrize(
    "folder", ["Talkin' Shop", "Rock 'n' Roll Hour", '"Best"', "What? Show", "Café Ünï ☕"]
)
def test_guest_message_never_holds_part_of_a_folder_name(folder: str) -> None:
    path = f"/Users/host/{folder}/ep1/raw/host.wav"
    unmarked = CodedFileNotFoundError(f"raw media not found: {path}", code="file_not_found")

    assert unmarked.guest_message() == GENERIC_GUEST_MESSAGE
    assert str(unmarked) == f"raw media not found: {path}"
    assert tool_refusal(unmarked, for_guest=True) == ToolRefusal(
        GENERIC_GUEST_MESSAGE, "file_not_found"
    )


def test_guest_message_is_selected_by_code_not_host_message() -> None:
    exc = CodedValueError("unknown track_id: 'Talkin' Shop'", code="track_not_found")

    assert exc.guest_message() == "That track is unavailable. Ask the host to refresh the project."


@pytest.mark.parametrize(
    "message",
    [
        r"missing: 'C:\\Users\\caleb\\Talkin Shop\\ep1.wav'",
        r"missing: ['C:\\Users\\caleb\\Talkin Shop\\ep1.wav']",
        r"missing: \\\\nas\\shows\\Talkin Shop\\ep1.wav",
        "missing:/media/caleb/Talkin Shop/x.wav",
        "missing-/media/caleb/Talkin Shop/x.wav",
        "missing)/media/caleb/Talkin Shop/x.wav",
        "missing: %2FUsers%2Fcaleb",
        "missing: ../Talkin Shop/x.wav",
        "missing: /TalkinShop",
    ],
    ids=[
        "escaped-windows",
        "escaped-windows-list",
        "escaped-unc",
        "after-colon",
        "after-hyphen",
        "after-parenthesis",
        "percent-encoded",
        "relative-parent",
        "single-root",
    ],
)
def test_guest_message_withholds_all_audited_path_forms(message: str) -> None:
    exc = CodedError(message, code="file_not_found")

    assert exc.guest_message() == GENERIC_GUEST_MESSAGE


def test_guest_message_does_not_forward_a_bare_filename() -> None:
    exc = CodedError("A wav not found: A.wav", code="file_not_found")

    assert exc.guest_message() == GENERIC_GUEST_MESSAGE


def test_guest_message_withholds_a_path_with_leading_spaces() -> None:
    exc = CodedError("missing: / Private Show/ Ep1.wav", code="file_not_found")

    assert exc.guest_message() == GENERIC_GUEST_MESSAGE


def test_guest_message_is_derived_after_pickle() -> None:
    exc = CodedValueError("bad /Users/host/x.wav", code="track_not_found")

    assert pickle.loads(pickle.dumps(exc)).guest_message() == (
        "That track is unavailable. Ask the host to refresh the project."
    )


def test_conflict_wrapping_uses_effective_code_for_guest_message() -> None:
    from podcast_mcp.services.document_sync.errors import DocumentConflictError

    cause = CodedValueError("gone /Users/host/Talkin' Shop/x.wav", code="clip_not_found")

    conflict = DocumentConflictError.wrapping(cause, code=cause.code)

    assert str(conflict) == str(cause)
    assert (
        conflict.guest_message() == "That clip is unavailable. Ask the host to refresh the project."
    )
    assert conflict.code == "clip_not_found"


@pytest.mark.parametrize(
    "host_message",
    ["Private customer notes", "Different private details", "{private_path}"],
)
def test_guest_unknown_code_never_projects_host_text(host_message: str, tmp_path) -> None:
    host_message = host_message.replace("{private_path}", str(tmp_path / "episode.wav"))
    exc = CodedValueError(host_message, code="unregistered_guest_failure")
    assert tool_refusal(exc, for_guest=True) == ToolRefusal(
        GENERIC_GUEST_MESSAGE, "unregistered_guest_failure"
    )
    assert tool_refusal(exc) == ToolRefusal(host_message, "unregistered_guest_failure")
