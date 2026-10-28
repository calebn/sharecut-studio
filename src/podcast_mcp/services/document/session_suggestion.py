"""SessionSuggestionService - record sessions staged for an insert or replace target."""

from __future__ import annotations

import logging
import math
from typing import Any

from podcast_mcp.edits.audio_check_override import mcp_host_override
from podcast_mcp.edits.cut_speech import APPLY_ANYWAY
from podcast_mcp.edits.pending_preview import DEFAULT_AB_GAP_SEC, DEFAULT_SESSION_PAD_SEC
from podcast_mcp.edits.session_suggestions import (
    accept_session_suggestion,
    chosen_take_for_preview,
    find_session_suggestion,
    list_session_suggestions,
    skip_session_suggestion,
)
from podcast_mcp.edits.session_takes import select_session_take, session_takes
from podcast_mcp.edits.transcript_refine_status import (
    REFINE_GATE,
    TranscriptRefineRequiredError,
)
from podcast_mcp.models import SessionSuggestion
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.service_base import mutate_unless_cut_speech_held
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.project_state import RENDER_LOCK_TIMEOUT_SEC

log = logging.getLogger(__name__)

REPLACE_REFINE_HINT = (
    "The transcript clean-up needs to finish first, so the words this replace removes are "
    "the right ones. Finish it with `podcast transcript refine-done` / "
    "`transcript_refine_done_tool`, or skip it with `podcast transcript refine-waive "
    "--reason ...` / `transcript_refine_waive_tool`, then try again."
)


MAX_PREVIEW_PAD_SEC = 10.0
MAX_PREVIEW_GAP_SEC = 5.0


def _require_seconds(name: str, code: str, value: object, ceiling: float) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not (math.isfinite(value) and 0.0 <= value <= ceiling)
    ):
        raise CodedValueError(
            f"{name} must be a number of seconds from 0 to {ceiling:g} (got {value}).", code=code
        )


class SessionSuggestionService:
    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws

    def list(self, *, status: str | None = None) -> list[dict[str, Any]]:
        """Staged sessions, optionally only those with ``status``."""
        return [
            row.model_dump(mode="json")
            for row in list_session_suggestions(self.ws.project, status=status)
        ]

    def skip(self, suggestion_id: str) -> dict[str, Any]:
        """Mark a pending staged session skipped (one undo step); its sources stay registered."""
        number = find_session_suggestion(self.ws.project, suggestion_id).session_number
        title = f"Skipped Session {number}"
        return self.ws.mutate(
            f"before {title}",
            f"after {title}",
            lambda p: skip_session_suggestion(p, suggestion_id).model_dump(mode="json"),
            operation="skip_session_suggestion",
            params={"suggestion_id": suggestion_id, "session_number": number},
        )

    def takes(self, suggestion_id: str) -> dict[str, Any]:
        """The takes of a staged session for a take switcher; reads only.

        Per take: length (overall and per track), word count and a snippet of what is said
        (both None for a take nobody has transcribed), whether it is the one picked
        (``chosen``), whether it is the one Accept places when none is named (``default``),
        and the refusal Accept would give it, if any.
        """
        return session_takes(self.ws.project, suggestion_id)

    def select_take(self, suggestion_id: str, take_index: int) -> dict[str, Any]:
        """Pick the take Accept places for a pending replace (one undo step "Chose take N").

        Refuses what Accept refuses for that take, in the same words and codes: a session that
        is not pending, an unknown take (take_not_found), an insert (take_not_applicable), a
        track the take did not record, and a range that has changed (stale_anchor). Picking
        the take already picked changes nothing and writes no history step.
        """
        row = find_session_suggestion(self.ws.project, suggestion_id)
        number = row.session_number
        title = f"Chose take {take_index} for Session {number}"
        if row.status == "pending" and row.selected_take == take_index:
            # The same refusals as a real pick, then nothing to write.
            return select_session_take(self.ws.project, suggestion_id, take_index)
        return self.ws.mutate(
            f"before {title}",
            f"after {title}",
            lambda p: select_session_take(p, suggestion_id, take_index),
            operation="select_session_take",
            params={
                "suggestion_id": suggestion_id,
                "session_number": number,
                "take_index": take_index,
            },
        )

    def accept(
        self,
        suggestion_id: str,
        take_index: int | None = None,
        override_audio_checks: bool = False,
    ) -> dict[str, Any]:
        """Place a pending staged session on the timeline (one undo step titled "Added Session N").

        An insert opens the session's span at its insert point on every dialogue track and
        places the staged takes, room-tone beds and live comments in it. A replace removes its
        range on every dialogue track and puts one take (``take_index``, else the selected or
        last one) in its place. A replace that also removes speech of a track the take did not
        record changes nothing and returns ``needs_confirmation``; repeat with
        ``override_audio_checks=true`` to apply it. Marks the suggestion accepted. A replace
        discards the other takes' staged segments and the live comments held on them in the same
        step (``discarded_takes``, ``comments_not_placed``, ``discard_message``); Undo brings
        them back.
        """
        row = find_session_suggestion(self.ws.project, suggestion_id)
        self._require_refine_clear(row)
        title = f"Added Session {row.session_number}"
        return mutate_unless_cut_speech_held(
            self.ws,
            title,
            "accept_session_suggestion",
            lambda p: accept_session_suggestion(
                p,
                suggestion_id,
                take_index=take_index,
                override_audio_checks=override_audio_checks,
                defaults=self.ws.effective_config(),
            ),
            {
                "suggestion_id": suggestion_id,
                "session_id": row.session_id,
                "session_number": row.session_number,
            },
        )

    def _require_refine_clear(self, row: SessionSuggestion) -> None:
        if row.kind == "replace":
            try:
                REFINE_GATE.assert_clear(self.ws.project, defaults=self.ws.effective_config())
            except TranscriptRefineRequiredError as gated:
                raise TranscriptRefineRequiredError(REPLACE_REFINE_HINT) from gated

    def preview(
        self,
        suggestion_id: str,
        *,
        mode: str = "ab",
        take_index: int | None = None,
        pad_sec: float = DEFAULT_SESSION_PAD_SEC,
        gap_sec: float = DEFAULT_AB_GAP_SEC,
        rerender: bool = False,
        dry_run: bool = False,
        player: str | None = None,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        """Hear a pending insert or replace before accepting it: Current, Suggested or A/B.

        Current is the window around the place as it is, Suggested the same window after
        Accept, so it is what Accept ships; ``take_index`` picks the take of a replace.
        Refuses what Accept refuses (same codes) and never changes the project, its history
        or the session; it needs no ``override_audio_checks``. The result carries both WAVs,
        the length change and, for a replace, the speech it would remove (None otherwise).
        """
        heard = self._hear(
            suggestion_id,
            mode=mode,
            take_index=take_index,
            pad_sec=pad_sec,
            gap_sec=gap_sec,
            rerender=rerender,
            dry_run=dry_run,
            player=player,
            lock_timeout=lock_timeout,
            cached_only=False,
        )
        assert heard is not None
        return heard

    def cached_preview(
        self,
        suggestion_id: str,
        *,
        mode: str = "ab",
        take_index: int | None = None,
        pad_sec: float = DEFAULT_SESSION_PAD_SEC,
        gap_sec: float = DEFAULT_AB_GAP_SEC,
    ) -> dict[str, Any] | None:
        """``preview`` if its windows are already rendered (a file read, no FFmpeg), else None."""
        return self._hear(
            suggestion_id,
            mode=mode,
            take_index=take_index,
            pad_sec=pad_sec,
            gap_sec=gap_sec,
            rerender=False,
            dry_run=True,
            player=None,
            lock_timeout=RENDER_LOCK_TIMEOUT_SEC,
            cached_only=True,
        )

    def _hear(
        self,
        suggestion_id: str,
        *,
        mode: str,
        take_index: int | None,
        pad_sec: float,
        gap_sec: float,
        rerender: bool,
        dry_run: bool,
        player: str | None,
        lock_timeout: float,
        cached_only: bool,
    ) -> dict[str, Any] | None:
        from podcast_mcp.services.document.play import PlayService

        _require_seconds("pad_sec", "pad_sec_invalid", pad_sec, MAX_PREVIEW_PAD_SEC)
        _require_seconds("gap_sec", "gap_sec_invalid", gap_sec, MAX_PREVIEW_GAP_SEC)
        row = find_session_suggestion(self.ws.project, suggestion_id)
        self._require_refine_clear(row)
        chosen = chosen_take_for_preview(self.ws.project, row, take_index)
        return PlayService(self.ws).hear_session_suggestion(
            row,
            chosen,
            mode=mode,
            pad_sec=pad_sec,
            gap_sec=gap_sec,
            rerender=rerender,
            dry_run=dry_run,
            player=player,
            lock_timeout=lock_timeout,
            cached_only=cached_only,
        )

    def warm(
        self, suggestion_id: str, *, lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC
    ) -> dict[str, Any]:
        """Do a pending session's slow work now, so the first Play is a cached file.

        That is the mix trim and the level profiles (as for a pending edit), then the Current
        and Suggested windows. Returns the trim and each side's status: ``ready``,
        ``unavailable`` for a session Accept would refuse, ``failed`` for a render that
        errored, so the caller can retry a failure instead of taking it for done.
        """
        from podcast_mcp.services.document.play import PlayService

        find_session_suggestion(self.ws.project, suggestion_id)
        warmed = PlayService(self.ws).warm_pending_preview(None, lock_timeout=lock_timeout)
        sides: dict[str, str] = {}
        for mode in ("current", "suggested"):
            try:
                self.preview(suggestion_id, mode=mode, dry_run=True, lock_timeout=lock_timeout)
                sides[mode] = "ready"
            except (CodedValueError, KeyError, ValueError):
                log.debug("session %s not warmed for %s", mode, suggestion_id, exc_info=True)
                sides[mode] = "unavailable"
            except OSError:
                log.warning("session %s warm failed for %s", mode, suggestion_id, exc_info=True)
                sides[mode] = "failed"
        return {"trim_db": warmed["trim_db"], "sides": sides}

    def accept_naming_override(
        self,
        suggestion_id: str,
        *,
        take_index: int | None = None,
        override_audio_checks: bool = False,
    ) -> dict[str, Any]:
        """``accept`` for a caller that has no flag help of its own (an agent tool), under the MCP host's override surface.

        A held replace's message also names how to apply it, so the person is not left
        guessing the parameter. The CLI and HTTP surfaces use ``accept`` and add their own.
        """
        with mcp_host_override(enabled=override_audio_checks):
            result = self.accept(
                suggestion_id, take_index=take_index, override_audio_checks=override_audio_checks
            )
        held = result.get("needs_confirmation")
        if isinstance(held, dict) and isinstance(held.get("message"), str):
            held["message"] = f"{held['message']} {APPLY_ANYWAY}"
        return result
