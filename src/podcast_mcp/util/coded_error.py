"""A domain refusal: an anticipated condition whose message is written for the caller.

A ``CodedError`` says the request cannot be honoured as asked (a stale guard, an unknown id,
an out-of-range index, a missing file or project, a required step not done yet). Its message
is safe to show the host, and its ``code`` is a stable, machine-readable name for the refusal.
Never build the message from another exception's text: log that and chain it with ``from``.
Any other exception is treated as a bug: adapters that must not leak internals (MCP, owner and
guest) keep its text on the server.

Every adapter reports the same message and code: the MCP tool result's
``structured_content.error_code`` (``mcp/tool_errors.py`` and guest remote MCP, both through
``util/tool_refusal.py``, which reads ``guest_message()`` instead for a share guest), the CLI's
``Error: <message> (code <code>)`` line (``cli/busy.py``) and, on routes that map one, the
GUI's ``X-Sharecut-Error-Code`` header (set by ``gui.routes.deps.coded_http_error``). ``project_busy`` (a lock timeout) uses the same
adapters but is not a ``CodedError``; see ``util/project_state.py``.

Raise a refusal through the class matching the builtin the call site always raised
(``CodedValueError`` / ``CodedKeyError`` / ``CodedFileNotFoundError``), so callers that catch
the builtin keep working, or give a named guard class both bases and a class-level ``code``::

    class TranscriptTextChangedError(CodedError, ValueError):
        code = "transcript_changed"
"""

from __future__ import annotations

from typing import Any

from podcast_mcp.util.redact import mentions_host_path

GENERIC_GUEST_MESSAGE = "That didn't work; ask the host to check this episode."
"""Fallback for a code without approved guest-facing copy."""

_GUEST_MESSAGES = {
    "clip_not_found": "That clip is unavailable. Ask the host to refresh the project.",
    "cut_scope_changed": "This edit needs another review. Ask the host to review it in the editor before applying it.",
    "empty_text": "Enter some text and try again.",
    "enrollment_past_end": "A voice sample is past the end of this recording. Choose a sample inside the audio.",
    "export_busy": "This project is busy with an export or render. Try again when it finishes.",
    "export_target_not_file": "An export file can't be written because something else is in its place. Ask the host to check the export folder.",
    "feed_write_failed": "The feed file could not be written on the host's computer. Ask the host to check that its disk has space and is not read-only, then try again.",
    "gate_text_too_long": "That note is too long. Shorten it and try again.",
    "invalid_audio": "This upload is not a playable audio file. Choose a supported audio file and try again.",
    "invalid_lease": "Your recording access is no longer valid. Ask the host to reconnect you.",
    "mix_out_of_date": "The mix is out of date. Ask the host to refresh it before playing this range.",
    "model_needed": "The host needs to download a model first; ask the host to open ShareCut Studio.",
    "no_mix": "No mix is available yet. Ask the host to refresh it.",
    "pending_edit_changed": "This edit changed since you reviewed it. Review the updated edit before trying again.",
    "pending_preview_unavailable": "This preview isn't available right now. Ask the host to check the project.",
    "pipeline_attended": "The host set this project to attended runs; ask the host to start it.",
    "pipeline_from_step_unknown": "That pipeline step isn't available. Choose one of the pipeline's steps.",
    "pipeline_job_unavailable": "The run started but its status isn't available. Ask the host to check the project.",
    "pipeline_only_step_unknown": "That pipeline step isn't available. Choose one of the pipeline's steps.",
    "pipeline_retime_with_force": "Re-time words and re-transcribe can't run together. Choose one.",
    "pipeline_skip_steps_unknown": "A step to skip isn't available. Choose from the pipeline's steps.",
    "pipeline_step_not_shared": "That step is not available on a share link.",
    "project_busy": "This project is busy; try again.",
    "project_write_failed": "Your change could not be saved on the host's computer. Ask the host to check that its disk has space and is not read-only, then try again.",
    "project_unreadable": "This project can't be opened right now; ask the host to check it.",
    "project_not_found": "This link isn't available right now; ask the host to check it.",
    "registry_not_private": "The host's sharing setup needs attention; ask the host to check it.",
    "registry_backup_invalid_path": "The host's sharing setup needs attention; ask the host to check it.",
    "registry_backup_integrity_changed": "The host's sharing setup needs attention; ask the host to check it.",
    "review_artifacts_not_private": "The host's review files need attention; ask the host to check them.",
    "review_media_not_found": "This review's audio isn't available right now; ask the host to republish.",
    "record_consent_required": "Confirm your consent for this take before uploading.",
    "replacement_token_invalid": "Each replacement word needs a letter or number.",
    "roll_needs_abutting_clips": "These clips need to touch before their join can be rolled. Move one clip to the other or trim an edge.",
    "share_capability_required": "This action isn't available on this link. Ask the host to update its access.",
    "speaker_backend_unavailable": "Speaker recognition isn't available on the host's computer. Ask the host to check it.",
    "speaker_enrolled_count_mismatch": "More speakers have voice samples than the speaker count. Raise the count or leave a speaker out.",
    "speaker_enrolled_name_unknown": "A speaker with a voice sample is not in the list of names. Add the name or leave the speaker out.",
    "speaker_move_lane_span_empty": "That range is empty. Select some audio to move.",
    "speaker_move_lane_span_not_sibling": "Both tracks must be lanes of the same speaker split.",
    "speaker_move_lane_span_same_lane": "Choose a different track to move this range to.",
    "speaker_move_lane_span_timeline": "That range isn't one continuous stretch of this track. Select a range within one stretch.",
    "speaker_names_count_mismatch": "Give one name for each speaker.",
    "speaker_names_invalid": "Speaker names must be different and not blank.",
    "speaker_split_already_split": "This track is already split by speaker.",
    "speaker_split_multiple_recordings": "This track plays more than one recording, so it can't be split by speaker.",
    "speaker_split_no_media": "This track has no recording to split.",
    "track_not_found": "That track is unavailable. Ask the host to refresh the project.",
    "transcript_changed": "The transcript changed since you reviewed it. Review the updated transcript before trying again.",
    "transcript_empty": "Every word is cut, so there is nothing to export.",
    "transcript_source_ambiguous": "This transcript can't be searched right now. Ask the host to regenerate it.",
    "transcript_timing_changed": "This word changed. Select it again before adjusting its timing.",
    "vocabulary_conflict": "The vocabulary changed in another window. Reload it before saving.",
    "vocabulary_empty": "Each vocabulary entry needs text and must be at most 100 characters. Check the list and try again.",
    "vocabulary_prompt_too_long": "That vocabulary is too long for the transcription prompt. Remove some terms or names.",
    "word_not_found": "That word is unavailable. Select it again.",
}


def guest_message_for_code(code: str) -> str:
    """Return approved guest copy for ``code``, or the fixed generic fallback."""
    message = _GUEST_MESSAGES.get(code, GENERIC_GUEST_MESSAGE)
    return GENERIC_GUEST_MESSAGE if mentions_host_path(message) else message


class CodedError(Exception):
    """A refusal whose message reaches the caller; ``code`` names it (for example ``no_mix``).

    Pass ``code`` per raise, or set it once as a class attribute on a named subclass. Guest
    copy comes from the fixed policy for that code, never from the host diagnostic.
    """

    code: str

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        if not getattr(self, "code", ""):
            raise TypeError(f"{type(self).__name__} needs a code")

    def __str__(self) -> str:
        # The message as written, also for a KeyError subclass (KeyError quotes its arg).
        return str(self.args[0]) if self.args else ""

    def guest_message(self) -> str:
        """The approved guest-facing message for this code."""
        return guest_message_for_code(self.code)

    def __reduce__(self) -> tuple[Any, ...]:
        # Exception pickling re-calls ``cls(*args)``, which loses a per-raise ``code`` (it is
        # keyword-only) and breaks subclasses with their own ``__init__``. Rebuild without
        # ``__init__`` instead, so a refusal survives a process pool.
        return (_restore_coded_error, (type(self), self.args, dict(self.__dict__)))


def _restore_coded_error(
    cls: type[CodedError], args: tuple[Any, ...], state: dict[str, Any]
) -> CodedError:
    exc = cls.__new__(cls, *args)
    exc.args = args
    exc.__dict__.update(state)
    return exc


class CodedValueError(CodedError, ValueError):
    """A refused value or state where the call site raises ``ValueError``."""


class CodedKeyError(CodedError, KeyError):
    """An unknown id where the call site raises ``KeyError``."""


class CodedFileNotFoundError(CodedError, FileNotFoundError):
    """A missing file or project where the call site raises ``FileNotFoundError``."""


class CodedPermissionError(CodedError, PermissionError):
    """A refused permission where the call site raises ``PermissionError``."""


class HostSetupError(CodedPermissionError):
    """The host's own setup refuses to run: a private file or folder is not private.

    Not a caller's missing capability: adapters answer it as a server-side failure (HTTP 500,
    JSON-RPC ``-32603``). The host's message names the path and the fix; guest copy is
    selected by code.
    """


class GuardRefusal(CodedError):
    """An auth guard's refusal: who may call, not what was asked.

    Its message is written for any caller, a share guest included, and goes out as written
    (a refusal from the domain gets guest copy by code instead). The HTTP adapter answers it
    with ``gui.routes.deps.guard_http_error``.
    """


class AccessDeniedError(GuardRefusal, CodedPermissionError):
    """The caller is known and not allowed (HTTP 403)."""


class SignInRequiredError(AccessDeniedError):
    """The share needs a signed-in principal and the caller has none (HTTP 401)."""

    code = "authentication_required"


class UnknownShareError(GuardRefusal, CodedKeyError):
    """No live share has this token (HTTP 404)."""


def coded_cause(exc: BaseException) -> CodedError | None:
    """Walk ``exc`` and its ``__cause__`` chain for a ``CodedError``, else ``None``."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        if isinstance(current, CodedError):
            return current
        seen.add(id(current))
        current = current.__cause__
    return None


def describe_error(exc: BaseException) -> str:
    """The message, plus ``(code <code>)`` when ``exc`` is a ``CodedError``."""
    if isinstance(exc, CodedError):
        return f"{exc} (code {exc.code})"
    return str(exc)
