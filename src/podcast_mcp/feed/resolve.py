"""Resolve an episode into a ``FeedView``, and turn an edit into pins. Both are pure."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ValidationError

from podcast_mcp.feed.fields import (
    FIELDS,
    PERSON_KEY,
    AtSource,
    Auto,
    FieldSpec,
    Found,
    Missing,
    Resolution,
    lookup,
    speakers,
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
    usable_ledger,
)
from podcast_mcp.feed.notes import NOTES_KEY, notes_html
from podcast_mcp.feed.render import render
from podcast_mcp.models.feed import Pin, PinAuthor
from podcast_mcp.util.coded_error import GENERIC_GUEST_MESSAGE, CodedValueError
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.redact import mentions_host_path

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


def _show_fix(inputs: FeedInputs) -> Fix | None:
    """Create or pick a show; for a linked show whose file is unreadable, pick another or nothing."""
    if inputs.show_unreadable is not None:
        return CommandFix(command="link_show") if inputs.shows else None
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
        why = "The show file cannot be used." if res.inputs.show_unreadable else None
        return Missing(why or "Your show is not set up yet.", _show_fix(res.inputs))
    if auto is not None:
        return auto
    return Missing(spec.missing or "Not set.", InputFix(key=spec.key) if spec.ask else None)


def _drifted(pin: Pin, auto: Auto) -> bool:
    if pin.basis is None:
        return False
    return not isinstance(auto, Found) or digest(auto.value) != pin.basis


_LIMIT_PHRASES = {
    "string_too_long": "is too long",
    "too_long": "is too long",
    "string_too_short": "is blank",
    "too_short": "is blank",
    "greater_than": "is outside the allowed range",
    "greater_than_equal": "is outside the allowed range",
    "less_than": "is outside the allowed range",
    "less_than_equal": "is outside the allowed range",
}


def _limit_phrase(exc: ValidationError) -> str | None:
    """How a value of the right kind broke a size or range limit, or None for any other failure."""
    return _LIMIT_PHRASES.get(exc.errors()[0]["type"])


def _usable_pin(spec: FieldSpec, pin: Pin, res: Resolution) -> bool:
    """False when a stored pin is the wrong kind of value, such as a number where text belongs.

    A value of the right kind that breaks a limit stays visible, with a blocker saying which limit.
    """
    try:
        spec.value.validate_python(pin.value)
    except ValidationError as exc:
        if (phrase := _limit_phrase(exc)) is not None:
            res.refused_pins[spec.key] = phrase
            return True
        return exc.errors()[0]["type"] == "value_error"
    return True


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
        if not _usable_pin(spec, pin, res):
            res.unusable_pins.add(spec.key)
            res.facts[spec.key] = auto
            continue
        pinned = Pinned(by=pin.by, drifted=_drifted(pin, auto))
        if spec.pin_resolve is not None:
            resolved = spec.pin_resolve(res, pin.value)
            res.facts[spec.key] = (
                Found(resolved.value, pinned) if isinstance(resolved, Found) else resolved
            )
            continue
        value = spec.pin_shape(res, pin.value) if spec.pin_shape else pin.value
        res.facts[spec.key] = Found(value, pinned)
    return res, autos


def _show_state(inputs: FeedInputs, credits: list[Credit]) -> NoShow | ChooseShow | ReadyShow:
    if inputs.show is not None:
        return ReadyShow(id=inputs.show.id)
    if len(inputs.shows) > 1 or inputs.show_unreadable is not None:
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
                message=inputs.show_unreadable or "The feed needs a show to belong to.",
                fix=_show_fix(inputs),
            )
        )
    findings.extend(_show_file_findings(inputs))
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
        findings.extend(_row_findings(spec, fact, res))
        if spec.key in res.unusable_pins:
            findings.append(_unusable_pin_finding(spec))
        if spec.key in res.refused_pins:
            findings.append(_refused_pin_finding(spec, res.refused_pins[spec.key]))
        if isinstance(fact, Found) and isinstance(fact.source, Pinned) and fact.source.drifted:
            drift_detail[spec.key] = spec.drift_hint or DEFAULT_DRIFT_HINT
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


DEFAULT_DRIFT_HINT = "The automatic value changed since you edited this."


def _row_findings(spec: FieldSpec, fact: Auto, res: Resolution) -> list[Finding]:
    """What a row costs: its need when missing; its checks and any drift when known."""
    if isinstance(fact, Missing):
        if spec.needs is None:
            return []
        return [
            Finding(
                key=spec.key,
                severity=spec.needs.severity,
                platform=spec.needs.platform,
                message=spec.needs.message or fact.why,
                fix=fact.fix,
            )
        ]
    found = [finding for check in spec.checks for finding in check(res, fact)]
    found.extend(_stored_value_findings(spec, fact))
    if isinstance(fact.source, Pinned) and fact.source.drifted:
        found.append(
            Finding(
                key=spec.key,
                severity="info",
                platform=None,
                message=f"The {spec.label} changed since you edited {_them(spec.key)}.",
                fix=None,
            )
        )
    return found


def _unusable_pin_finding(spec: FieldSpec) -> Finding:
    return Finding(
        key=spec.key,
        severity="blocker",
        platform="RSS",
        message=f"The stored {spec.label} is not the kind of value this setting takes. "
        "Set it again or unset it.",
        fix=None,
    )


def _refused_pin_finding(spec: FieldSpec, phrase: str) -> Finding:
    return Finding(
        key=spec.key,
        severity="blocker",
        platform="RSS",
        message=f"The stored {spec.label} {phrase}. Set it again or unset it.",
        fix=None,
    )


def _stored_value_findings(spec: FieldSpec, fact: Found) -> list[Finding]:
    """A stored value its XML shape now refuses is a blocker naming the field, never an exception."""
    for tag in spec.tags:
        if tag.shape is None or fact.value in (None, ""):
            continue
        try:
            tag.shape(fact.value)
        except ValueError as exc:
            return [
                Finding(
                    key=spec.key,
                    severity="blocker",
                    platform="RSS",
                    message=f"The stored {spec.label} is not valid: {exc}. Set it again or unset it.",
                    fix=None,
                )
            ]
    return []


def _show_file_findings(inputs: FeedInputs) -> list[Finding]:
    found = [
        Finding(key=None, severity="warn", platform=None, message=problem, fix=None)
        for problem in inputs.show_problems
    ]
    ledger = inputs.show.ledger if inputs.show else {}
    if (ignored := len(ledger) - len(usable_ledger(ledger))) > 0:
        found.append(
            Finding(
                key=None,
                severity="warn",
                platform=None,
                message="The show file has episode numbers that are zero, negative or repeated; "
                f"{ignored} ignored.",
                fix=None,
            )
        )
    return found


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


def clears(edit: FeedEdit) -> bool:
    """An unset, or a set of nothing but whitespace: both hand the value back to automatic."""
    return isinstance(edit, UnsetEdit) or (isinstance(edit.value, str) and not edit.value.strip())


class FeedValueInvalidError(CodedValueError):
    """A value the field refuses. The sentence names the field in plain words and is safe for a guest."""

    code = "feed_value_invalid"

    def __init__(self, sentence: str) -> None:
        super().__init__(sentence)

    def guest_message(self) -> str:
        """The sentence, unless it mentions a path on the host's machine."""
        text = str(self)
        return GENERIC_GUEST_MESSAGE if mentions_host_path(text) else text


def _refusal_sentence(spec: FieldSpec, exc: ValidationError) -> str:
    """``Hosting address template must have exactly one place for the file name.``: label and rule broken."""
    label = spec.label[:1].upper() + spec.label[1:]
    first = exc.errors()[0]
    if (phrase := _limit_phrase(exc)) is not None:
        return f"{label} {phrase}."
    if first["type"] != "value_error":
        return f"That isn't the kind of value the {spec.label} setting takes."
    return f"{label} {first['msg'].removeprefix('Value error, ')}."


def pin_row(key: str) -> FieldSpec:
    """The row ``key`` names when a pin edits it, or the coded refusal that says why not."""
    spec = lookup(key)
    if spec is None:
        raise CodedValueError(f"{key} is not a listing field", code="feed_field_unknown")
    if isinstance(spec.edit, AtSource):
        raise CodedValueError(spec.edit.where, code="feed_field_edit_at_source")
    if spec.edit != "pin":
        raise CodedValueError(
            f"{key} is {'made once' if spec.edit == 'mint' else 'measured from the export'} and cannot be edited",
            code="feed_field_not_editable",
        )
    return spec


def checked_value(edit: SetEdit) -> tuple[FieldSpec, Any]:
    """The row ``edit`` names and its value as that row stores it, or the refusal that says why not."""
    spec = pin_row(edit.key)
    try:
        return spec, spec.value.validate_python(edit.value)
    except ValidationError as exc:
        raise FeedValueInvalidError(_refusal_sentence(spec, exc)) from exc


def edited_pins(
    inputs: FeedInputs,
    pins: Mapping[str, Pin],
    edit: FeedEdit,
    by: PinAuthor,
) -> dict[str, Pin]:
    """The pins after ``edit``, or the coded refusal every entry point shares.

    A set of blank text is an unset, and unsetting a key that holds no pin changes nothing.
    """
    spec = lookup(edit.key)
    if spec is not None and spec.scope == "show":
        raise CodedValueError(
            f"{edit.key} is a show setting; it is saved on the show, not the episode",
            code="feed_show_unavailable",
        )
    if clears(edit):
        if spec is None and isinstance(edit, SetEdit) and edit.key not in pins:
            raise CodedValueError(f"{edit.key} is not a listing field", code="feed_field_unknown")
        return {k: p for k, p in pins.items() if k != edit.key}
    assert isinstance(edit, SetEdit)
    _, value = checked_value(edit)
    _require_speaker(inputs, edit.key)
    others = {k: p for k, p in pins.items() if k != edit.key}
    _, auto = _resolve_rows(inputs, others)
    basis_fact = auto.get(edit.key)
    basis = digest(basis_fact.value) if isinstance(basis_fact, Found) else None
    return {**others, edit.key: Pin(value=value, basis=basis, by=by)}


def cleared_pins(inputs: FeedInputs, pins: Mapping[str, Pin], key: str) -> dict[str, Pin]:
    """The pins without ``key``. A key that names nothing is refused, so a typo is not silent."""
    if key not in pins:
        if lookup(key) is None:
            raise CodedValueError(f"{key} is not a listing field", code="feed_field_unknown")
        _require_speaker(inputs, key)
    return edited_pins(inputs, pins, UnsetEdit(key=key), "person")


def _require_speaker(inputs: FeedInputs, key: str) -> None:
    match = PERSON_KEY.match(key)
    if match is not None and match["name"] not in speakers(Resolution(inputs=inputs, pins={})):
        raise CodedValueError(
            f"{match['name']} is not a speaker on this episode", code="feed_field_unknown"
        )
