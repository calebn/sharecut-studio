"""Review gate: a person or agent signs off on a stage before the pipeline moves on.

One gate is a status sidecar under ``artifacts/`` (``pending`` / ``done`` / ``waived``) plus
the fingerprint of what was reviewed. A ``done`` or ``waived`` record clears the gate only
while the fingerprint still matches, so later edits to the reviewed data make it stale.

A stage defines its gate once, as a :class:`ReviewGate` (name, sidecar file, fingerprint
function, ``defaults`` key that holds ``mode``). The mode is ``require``,
``waive_unattended`` (the default) or ``off``. A stage whose clear check or sidecar carries
more than the fingerprint supplies the optional hooks.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.pipeline_unattended import is_unattended
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.coded_error import CodedError, CodedValueError
from podcast_mcp.util.workspace_paths import workspace_relpath

ReviewStatus = Literal["pending", "done", "waived"]
ReviewMode = Literal["require", "waive_unattended", "off"]
ReviewSource = Literal["agent", "user", "cli", "mcp", "unattended", "align", "precorrect"]

GATE_TEXT_MAX_CHARS = 2000
"""Longest gate ``notes`` or waiver ``reason`` a caller may record, in characters."""


def check_gate_text_length(text: str | None, *, subject: str) -> None:
    """Refuse ``text`` over :data:`GATE_TEXT_MAX_CHARS`; ``subject`` reads "The notes are"."""
    length = len(text or "")
    if length > GATE_TEXT_MAX_CHARS:
        raise CodedValueError(
            f"{subject} too long: {length} characters, and the limit is "
            f"{GATE_TEXT_MAX_CHARS}. Shorten the text and try again.",
            code="gate_text_too_long",
        )


_MODES: tuple[ReviewMode, ...] = ("require", "waive_unattended", "off")
_CLEARING: tuple[ReviewStatus, ...] = ("done", "waived")

Defaults = EffectiveConfig


class ReviewRequiredError(CodedError, RuntimeError):
    """A gated step ran while its review is pending or stale. Subclasses set ``code``."""


def _always_covers(_project: EpisodeProject, _data: dict[str, Any] | None) -> bool:
    return True


def _no_payload_extras(
    _project: EpisodeProject, _status: ReviewStatus, _source: ReviewSource
) -> dict[str, Any]:
    return {}


def _no_report_extras(_project: EpisodeProject, _defaults: Defaults) -> dict[str, Any]:
    return {}


def _no_unattended_check(
    _project: EpisodeProject, _data: dict[str, Any] | None, _defaults: Defaults
) -> None:
    return None


@dataclass(eq=False)
class ReviewGate:
    """One review gate. ``mode_key`` is the dotted ``defaults`` path holding ``mode``."""

    name: str
    filename: str
    mode_key: str
    fingerprint_key: str
    fingerprint: Callable[[EpisodeProject], str]
    hint: str
    error: type[ReviewRequiredError]
    pending_source: ReviewSource
    pending_notes: str
    brief: Callable[[EpisodeProject, Defaults], dict[str, Any]]
    covers: Callable[[EpisodeProject, dict[str, Any] | None], bool] = _always_covers
    payload_extras: Callable[[EpisodeProject, ReviewStatus, ReviewSource], dict[str, Any]] = (
        _no_payload_extras
    )
    report_extras: Callable[[EpisodeProject, Defaults], dict[str, Any]] = _no_report_extras
    unattended_check: Callable[[EpisodeProject, dict[str, Any] | None, Defaults], None] = (
        _no_unattended_check
    )

    def path(self, project: EpisodeProject) -> Path:
        return project.artifacts_dir() / self.filename

    def load(self, project: EpisodeProject) -> dict[str, Any] | None:
        return load_json_object(self.path(project))

    def mode(self, defaults: Defaults) -> ReviewMode:
        *parents, leaf = self.mode_key.split(".")
        cfg: Any = defaults
        for key in parents:
            cfg = cfg.get(key, {})
        value = str((cfg.get(leaf) or {}).get("mode", "waive_unattended")).strip().lower()
        return next((mode for mode in _MODES if mode == value), "waive_unattended")

    def write(
        self,
        project: EpisodeProject,
        *,
        status: ReviewStatus,
        source: ReviewSource,
        notes: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "status": status,
            "updated_at": datetime.now(UTC).isoformat(),
            "source": source,
            "notes": notes or "",
            self.fingerprint_key: self.fingerprint(project),
            **self.payload_extras(project, status, source),
        }
        write_json_atomic(self.path(project), payload)
        return payload

    def mark_pending(
        self,
        project: EpisodeProject,
        *,
        source: ReviewSource | None = None,
        notes: str | None = None,
    ) -> dict[str, Any]:
        return self.write(
            project,
            status="pending",
            source=source or self.pending_source,
            notes=notes or self.pending_notes,
        )

    def mark_done(
        self,
        project: EpisodeProject,
        *,
        source: ReviewSource = "agent",
        notes: str | None = None,
    ) -> dict[str, Any]:
        return self.write(project, status="done", source=source, notes=notes)

    def mark_waived(
        self,
        project: EpisodeProject,
        *,
        reason: str,
        source: ReviewSource = "user",
    ) -> dict[str, Any]:
        reason = (reason or "").strip()
        if not reason:
            raise CodedValueError(
                f"{self.name} waive requires a non-empty reason", code="empty_text"
            )
        return self.write(project, status="waived", source=source, notes=reason)

    def data_is_clear(self, project: EpisodeProject, data: dict[str, Any] | None) -> bool:
        """Whether ``data`` (this gate's loaded sidecar) clears the gate for ``project`` now."""
        return self._fingerprint_clears(data, self.fingerprint(project)) and self.covers(
            project, data
        )

    def is_clear(self, project: EpisodeProject) -> bool:
        return self.data_is_clear(project, self.load(project))

    def _fingerprint_clears(self, data: dict[str, Any] | None, fingerprint: str) -> bool:
        if not data or data.get("status") not in _CLEARING:
            return False
        return data.get(self.fingerprint_key) == fingerprint

    def report(self, project: EpisodeProject, defaults: Defaults) -> dict[str, Any]:
        mode = self.mode(defaults)
        fp = self.fingerprint(project)
        data = self.load(project)
        stored_fp = (data or {}).get(self.fingerprint_key)
        status = (data or {}).get("status") or "pending"
        clear = self._fingerprint_clears(data, fp) and self.covers(project, data)
        stale = bool(data) and status in _CLEARING and not clear
        return {
            "status": "pending" if stale or not data else status,
            "stored_status": (data or {}).get("status"),
            "clear": clear,
            "stale": stale,
            "mode": mode,
            "fingerprint": fp,
            "stored_fingerprint": stored_fp,
            "fingerprint_match": bool(data) and stored_fp == fp,
            "source": (data or {}).get("source"),
            "notes": (data or {}).get("notes") or "",
            "updated_at": (data or {}).get("updated_at"),
            "path": workspace_relpath(project, self.path(project)),
            **self.report_extras(project, defaults),
            "hint": None if clear or mode == "off" else self.hint,
        }

    def assert_clear(self, project: EpisodeProject, *, defaults: Defaults) -> None:
        if self.mode(defaults) == "off" or self.is_clear(project):
            return
        raise self.error(self.hint)

    def require_or_waive_unattended(
        self,
        project: EpisodeProject,
        *,
        defaults: Defaults,
        unattended: bool | None = None,
    ) -> str:
        """Pipeline gate: return a summary, or raise when interactive and not clear.

        An unattended run in ``waive_unattended`` mode records its own waiver unless
        ``unattended_check`` raises first.
        """
        mode = self.mode(defaults)
        if mode == "off":
            return f"skipped ({self.mode_key}.mode=off)"
        data = self.load(project)
        if self.data_is_clear(project, data):
            return f"{(data or {}).get('status', 'done')} (fingerprint ok)"
        if mode == "waive_unattended" and is_unattended(flag=unattended, defaults=defaults):
            self.unattended_check(project, data, defaults)
            self.mark_waived(project, reason="unattended pipeline", source="unattended")
            return "waived (unattended)"
        raise self.error(self.hint)
