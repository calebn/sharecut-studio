"""Resolve an episode into a ``FeedView``, and turn an edit into pins. Both are pure."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ValidationError

from podcast_mcp.feed.fields import (
    FIELDS,
    AtSource,
    Auto,
    FieldSpec,
    Found,
    Missing,
    Resolution,
    lookup,
)
from podcast_mcp.feed.model import (
    ChooseShow,
    CommandFix,
    Credit,
    FeedEdit,
    FeedInputs,
    FeedView,
    FileState,
    Finding,
    Fix,
    InputFix,
    NoShow,
    Pending,
    Pinned,
    ReadyShow,
    Sections,
    SetEdit,
    ShowChoice,
    ShowSuggestion,
    UnsetEdit,
    inherited,
)
from podcast_mcp.feed.notes import NOTES_KEY, notes_html
from podcast_mcp.feed.render import render
from podcast_mcp.models.feed import Pin, PinAuthor
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import short_digest

_SEVERITY_RANK = {"blocker": 0, "warn": 1, "info": 2}
_LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "da": "Danish",
    "fi": "Finnish",
    "no": "Norwegian",
    "sv": "Swedish",
}
APPLE_NOTES_CHARS = 10_000
PSP_NOTES_BYTES = 4_000


def digest(value: Any) -> str:
    """Fingerprint of an auto value, stored beside a pin so a later read can tell it moved."""

    def plain(node: Any) -> Any:
        return node.model_dump(mode="json") if isinstance(node, BaseModel) else str(node)

    return short_digest(json.dumps(value, default=plain, sort_keys=True, ensure_ascii=False), 16)


def _show_fix(inputs: FeedInputs) -> Fix:
    return CommandFix(command="link_show" if len(inputs.shows) > 1 else "create_show")


def _auto(spec: FieldSpec, res: Resolution) -> Auto:
    """What the row would be with no pin: derived, else inherited, else pending."""
    auto = spec.derive(res) if spec.derive else None
    if not isinstance(auto, Found) and spec.inherit:
        parent = res.facts.get(spec.inherit)
        if isinstance(parent, Found):
            return Found(parent.value, inherited(spec.inherit))
    if isinstance(auto, Found):
        return auto
    if spec.scope == "show" and res.show is None:
        return Missing("Your show is not set up yet.", _show_fix(res.inputs))
    if auto is not None:
        return auto
    return Missing(spec.missing or "Not set.", InputFix(key=spec.key) if spec.ask else None)


def _drifted(pin: Pin, auto: Auto) -> bool:
    if pin.basis is None:
        return False
    return not isinstance(auto, Found) or digest(auto.value) != pin.basis


def _resolve_rows(
    inputs: FeedInputs, pins: Mapping[str, Pin]
) -> tuple[Resolution, dict[str, Auto]]:
    res = Resolution(inputs=inputs, pins=pins)
    autos: dict[str, Auto] = {}
    show_pins = inputs.show.pins if inputs.show else {}
    for spec in FIELDS:
        auto = autos[spec.key] = _auto(spec, res)
        pin = (show_pins if spec.scope == "show" else pins).get(spec.key)
        if pin is None or spec.edit != "pin":
            res.facts[spec.key] = auto
            continue
        value = spec.pin_shape(res, pin.value) if spec.pin_shape else pin.value
        res.facts[spec.key] = Found(value, Pinned(by=pin.by, drifted=_drifted(pin, auto)))
    return res, autos


def _show_state(inputs: FeedInputs, credits: list[Credit]) -> NoShow | ChooseShow | ReadyShow:
    if inputs.show is not None:
        return ReadyShow(id=inputs.show.id)
    if len(inputs.shows) > 1:
        return ChooseShow(shows=[ShowChoice(id=s.id, title=s.title) for s in inputs.shows])
    transcripts = inputs.project.transcripts
    code = transcripts[0].language.lower() if transcripts else "en"
    language = _LANGUAGE_NAMES.get(code.split("-")[0], code)
    hosts = [Credit(name=c.name, role="host") for c in credits]
    return NoShow(suggest=ShowSuggestion(language=language, hosts=hosts))


def _fact(fact: Auto) -> dict[str, Any]:
    if isinstance(fact, Missing):
        return {"value": None, "source": Pending(why=fact.why, fix=fact.fix)}
    return {"value": fact.value, "source": fact.source}


def resolve(inputs: FeedInputs, pins: Mapping[str, Pin]) -> FeedView:
    res, _ = _resolve_rows(inputs, pins)
    show_ready = inputs.show is not None
    channel: dict[str, Any] = {}
    item: dict[str, Any] = {}
    sections: dict[str, Any] = {}
    findings: list[Finding] = []
    drift_detail: dict[str, str] = {}
    credits_fact = res.facts["item.person"]
    credits: list[Credit] = credits_fact.value if isinstance(credits_fact, Found) else []
    show = _show_state(inputs, credits)
    if not show_ready:
        findings.append(
            Finding(
                key=None,
                severity="blocker",
                platform="RSS",
                message="The feed needs a show to belong to.",
                fix=_show_fix(inputs),
            )
        )
    for spec in FIELDS:
        fact = res.facts[spec.key]
        pinned = isinstance(fact, Found) and isinstance(fact.source, Pinned)
        if spec.section is not None:
            sections[spec.section] = _fact(fact)
        elif (
            spec.listed == "always"
            or (spec.listed == "known" and isinstance(fact, Found))
            or (spec.listed == "pinned" and pinned)
        ):
            (channel if spec.scope == "show" else item)[spec.key] = _fact(fact)
        if spec.scope == "show" and not show_ready:
            continue
        if isinstance(fact, Missing) and spec.needs is not None:
            findings.append(
                Finding(
                    key=spec.key,
                    severity=spec.needs.severity,
                    platform=spec.needs.platform,
                    message=spec.needs.message or fact.why,
                    fix=fact.fix,
                )
            )
        if isinstance(fact, Found):
            for check in spec.checks:
                findings.extend(check(res, fact))
            if isinstance(fact.source, Pinned) and fact.source.drifted:
                drift_detail[spec.key] = (
                    spec.drift_hint or "The automatic value changed since you edited this."
                )
                findings.append(
                    Finding(
                        key=spec.key,
                        severity="info",
                        platform=None,
                        message=f"The {spec.label} changed since you edited {_them(spec.key)}.",
                        fix=None,
                    )
                )
    view = FeedView(
        show=show,
        channel=channel,
        item=item,
        sections=Sections.model_validate(sections),
        notesHtml="",
        driftDetail=drift_detail or None,
        findings=[],
        file="none",
    )
    notes = notes_html(view)
    findings.extend(_notes_length_findings(notes))
    findings.sort(key=lambda f: _SEVERITY_RANK[f.severity])
    view = view.model_copy(update={"notes_html": notes, "findings": findings})
    return view.model_copy(update={"file": _file_state(view, inputs.files.feed_xml)})


def _them(key: str) -> str:
    return "them" if key == NOTES_KEY else "it"


def _notes_length_findings(notes: str) -> list[Finding]:
    found: list[Finding] = []
    if len(notes) > APPLE_NOTES_CHARS:
        found.append(
            Finding(
                key=NOTES_KEY,
                severity="warn",
                platform="Apple",
                message="Apple reads at most 10,000 characters of show notes.",
                fix=None,
            )
        )
    if len(notes.encode()) > PSP_NOTES_BYTES:
        found.append(
            Finding(
                key=NOTES_KEY,
                severity="warn",
                platform="PSP-1",
                message="PSP-1 limits show notes to 4,000 bytes.",
                fix=None,
            )
        )
    return found


def _file_state(view: FeedView, feed_xml: str | None) -> FileState:
    if feed_xml is None:
        return "none"
    return "current" if render(view) == feed_xml else "stale"


def edited_pins(
    inputs: FeedInputs,
    pins: Mapping[str, Pin],
    edit: FeedEdit,
    by: PinAuthor,
) -> dict[str, Pin]:
    """The pins after ``edit``. A set of the empty string is an unset; unsetting no pin changes nothing."""
    if isinstance(edit, UnsetEdit) or (isinstance(edit, SetEdit) and edit.value == ""):
        return {k: p for k, p in pins.items() if k != edit.key}
    assert isinstance(edit, SetEdit)
    spec = lookup(edit.key)
    if spec is None:
        raise CodedValueError(f"{edit.key} is not a listing field", code="feed_field_unknown")
    if isinstance(spec.edit, AtSource):
        raise CodedValueError(spec.edit.where, code="feed_field_edit_at_source")
    if spec.edit != "pin":
        raise CodedValueError(
            f"{edit.key} is {'made once' if spec.edit == 'mint' else 'measured from the export'} and cannot be edited",
            code="feed_field_not_editable",
        )
    try:
        value = spec.value.validate_python(edit.value)
    except ValidationError as exc:
        reason = exc.errors()[0]["msg"].removeprefix("Value error, ")
        raise CodedValueError(f"{edit.key} {reason}", code="feed_value_invalid") from exc
    others = {k: p for k, p in pins.items() if k != edit.key}
    _, auto = _resolve_rows(inputs, others)
    basis_fact = auto.get(edit.key)
    basis = digest(basis_fact.value) if isinstance(basis_fact, Found) else None
    return {**others, edit.key: Pin(value=value, basis=basis, by=by)}
