"""What the tools said, in one sentence each. Pure functions over redacted output."""

from __future__ import annotations

import enum
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import islice

from scripts.ios.release_run import OUTPUT_LIMIT


class Failure(enum.Enum):
    INPUT = 3
    SIGNING = 4
    HYGIENE = 5
    APPLE_REJECTED = 6
    DUPLICATE_BUILD = 7
    TOOL = 8
    LOCKED = 9
    GUARD = 10


SIGNING_HINTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"no accounts|no account for team|add an account", re.I),
        "Xcode has no signed-in account for this team. Open Xcode > Settings > Accounts, add the Apple ID, and run again.",
    ),
    (
        re.compile(r"maximum number of .*certificates|already have a current .*certificate", re.I),
        "The team has reached its limit of distribution certificates. Revoke an unused one in the developer account, then run again.",
    ),
    (
        re.compile(r"private key.*(not installed|missing|not found)|missing private key", re.I),
        "A distribution certificate exists but its private key is on another Mac. Export it from that Mac or revoke the certificate, then run again.",
    ),
    (
        re.compile(
            r"not (?:allowed|permitted) to create|forbidden|insufficient permissions|does not have permission",
            re.I,
        ),
        "The account's role cannot create certificates or profiles. Sign in to Xcode with an Admin or App Manager Apple ID.",
    ),
    (
        re.compile(r"license agreement|agreement .*(?:updated|accept)", re.I),
        "A developer agreement is waiting to be accepted at developer.apple.com. Accept it, then run again.",
    ),
    (
        re.compile(r"no devices|doesn't include any devices|no registered devices", re.I),
        "The team has no registered device, and automatic signing needs one. Register an iPhone in the developer account or connect it once.",
    ),
    (
        re.compile(
            r"no signing certificate|no profiles for|requires a provisioning profile|provisioning profile .*doesn't",
            re.I,
        ),
        "Xcode could not make a signing certificate or App Store profile for this identifier and team. Open the project's Signing settings once in Xcode, or check the identifier is registered.",
    ),
)


def signing_hint(tail: str) -> str | None:
    return next((sentence for pattern, sentence in SIGNING_HINTS if pattern.search(tail)), None)


class Verdict(enum.Enum):
    OK = "ok"
    REJECTED = "rejected"
    DUPLICATE = "apple_reports_duplicate"
    AUTH_FAILED = "auth_failed"
    UNREACHABLE = "unreachable"


@dataclass(frozen=True)
class AppleAnswer:
    verdict: Verdict
    messages: tuple[str, ...] = ()


DUPLICATE = re.compile(
    r"redundant binary upload|already been (?:used|uploaded)|bundle version must be higher|build version .* already",
    re.I,
)
AUTH = re.compile(
    r"\b40[13]\b|unauthori[sz]ed|invalid (?:api )?(?:key|issuer)|authentication (?:failed|credentials)",
    re.I,
)
NETWORK = re.compile(
    r"could not connect|network|timed out|offline|unreachable|connection (?:was )?(?:lost|reset)",
    re.I,
)


TRANSPORT = re.compile(
    NETWORK.pattern
    + r"|\bssl\b|\btls\b|handshake|broken pipe|unexpected eof|could not resolve|nodename nor servname"
    r"|name or service not known|\bdns\b|proxy|bad gateway|service unavailable|gateway time-?out"
    r"|nsurlerrordomain|nsposixerrordomain|nscocoaerrordomain|secure connection"
    r"|host(?:name)? could not be found|cannot (?:connect to|find) host|connection (?:refused|closed)"
    r"|socket (?:was )?closed|internal server error|temporarily unavailable"
    r"|\b(?:http(?:/\d(?:\.\d)?)?|status(?: code)?|server error|error code)\W{0,3}5\d\d\b",
    re.I,
)

APPLE_SERVICE_DOMAIN = r"(?:ITunes|ContentDelivery|AppStoreConnect)\w*"
APPLE_ANSWER_SHAPES = (
    re.compile(r"\bITMS-\d+\b"),
    re.compile(rf"Error Domain={APPLE_SERVICE_DOMAIN}"),
)
APPLE_DOMAIN_FIELD = re.compile(APPLE_SERVICE_DOMAIN)
APPLE_API_CODE = re.compile(
    r"(?:ENTITY_ERROR|ENTITY_UNPROCESSABLE|STATE_ERROR|PARAMETER_ERROR|NOT_AUTHORIZED"
    r"|FORBIDDEN|UNAUTHORIZED|RESOURCE_NOT_FOUND|CONFLICT)(?:[._][A-Za-z0-9_.]+)?"
)


OBJECT_LINE = re.compile(r"^\{", re.M)
JSON_LOOKING = re.compile(r"\s*[\[\]{}\"]")
MESSAGE_LINES = 5
MESSAGE_WIDTH = 200


def altool_document(text: str) -> dict[str, object] | None:
    """The JSON object altool printed, or None. It starts at the first line that begins with ``{``
    and the output from there to the end must parse as that one object, so a truncated object, text
    after it, a second object or a nested ``{`` is no document. altool's stderr is merged into the
    output, so lines before the object are tolerated when none of them looks like JSON. One parse
    and a cap at the captured tail (which was cut at its head) keep the cost linear."""
    if len(text) >= OUTPUT_LIMIT:
        return None
    start = OBJECT_LINE.search(text)
    if start is None or any(
        JSON_LOOKING.match(line) for line in text[: start.start()].splitlines()
    ):
        return None
    try:
        document = json.loads(text[start.start() :])
    except (ValueError, RecursionError):
        return None
    return document if isinstance(document, dict) else None


def product_errors(document: dict[str, object] | None) -> tuple[dict[str, object], ...]:
    raw = document.get("product-errors") if document else None
    return tuple(error for error in raw if isinstance(error, dict)) if isinstance(raw, list) else ()


def error_info(error: dict[str, object]) -> dict[str, object]:
    info = error.get("userInfo")
    return info if isinstance(info, dict) else {}


def clip(lines: Iterable[str]) -> tuple[str, ...]:
    return tuple(line[:MESSAGE_WIDTH] for line in islice(lines, MESSAGE_LINES))


def altool_messages(text: str, document: dict[str, object] | None) -> tuple[str, ...]:
    if document is None:
        return clip(line.strip() for line in text.splitlines() if "error" in line.lower())
    return clip(
        str(error.get("message") or error_info(error).get("NSLocalizedDescription") or "")
        for error in product_errors(document)
    )


def error_text(error: dict[str, object]) -> str:
    values = (*error.values(), *error_info(error).values())
    return " ".join(value for value in values if isinstance(value, str))


def apple_shaped(error: dict[str, object]) -> bool:
    """An allow-list, because a proxy or the OS can print JSON in the same shape."""
    info = error_info(error)
    text = error_text(error)
    code = error.get("code")
    domains = (error.get("domain"), info.get("domain"))
    return (
        any(pattern.search(text) for pattern in APPLE_ANSWER_SHAPES)
        or (isinstance(code, str) and APPLE_API_CODE.fullmatch(code) is not None)
        or any(isinstance(d, str) and APPLE_DOMAIN_FIELD.match(d) for d in domains)
    )


def error_haystack(text: str, document: dict[str, object] | None) -> str:
    return " ".join(error_text(error) for error in product_errors(document)).strip() or text


def no_answer(exit_code: int, text: str) -> AppleAnswer:
    seen = clip(line.strip() for line in text.splitlines() if line.strip())
    return AppleAnswer(Verdict.UNREACHABLE, (f"altool exited {exit_code} without an answer", *seen))


def classify_upload(exit_code: int, text: str) -> AppleAnswer:
    """Closing an attempt lifts the block on a second upload, so only Apple's own answer closes it
    and every doubt stays UNREACHABLE: transport wording anywhere in the output beats an exit-0
    object and an Apple-shaped error alike, except a duplicate, which blocks anyway."""
    document = altool_document(text)
    if not (document and document.get("product-errors")):
        return (
            AppleAnswer(Verdict.OK)
            if exit_code == 0 and document and not TRANSPORT.search(text)
            else no_answer(exit_code, text)
        )
    messages = altool_messages(text, document)
    haystack = error_haystack(text, document)
    if DUPLICATE.search(haystack):
        return AppleAnswer(Verdict.DUPLICATE, messages)
    if TRANSPORT.search(text) or not any(apple_shaped(e) for e in product_errors(document)):
        return no_answer(exit_code, text)
    return AppleAnswer(Verdict.AUTH_FAILED if AUTH.search(haystack) else Verdict.REJECTED, messages)


def classify_altool(exit_code: int, text: str) -> AppleAnswer:
    """The reading for steps that change nothing at Apple (validate, app record lookup)."""
    document = altool_document(text)
    messages = altool_messages(text, document)
    if exit_code == 0 and not messages:
        return AppleAnswer(Verdict.OK)
    haystack = error_haystack(text, document)
    for pattern, verdict in (
        (DUPLICATE, Verdict.DUPLICATE),
        (AUTH, Verdict.AUTH_FAILED),
        (NETWORK, Verdict.UNREACHABLE),
    ):
        if pattern.search(haystack):
            return AppleAnswer(verdict, messages)
    return AppleAnswer(Verdict.REJECTED, messages)


def app_record_exists(text: str, bundle_identifier: str) -> bool:
    applications = (altool_document(text) or {}).get("applications")
    return isinstance(applications, list) and any(
        bundle_identifier in json.dumps(entry) for entry in applications
    )


SENTENCES = {
    Verdict.AUTH_FAILED: "Apple refused the App Store Connect key. Check the key id, issuer and key file in the private file; the key needs the Developer role.",
    Verdict.UNREACHABLE: "Apple could not be reached; nothing was changed. Check the network and run the same command again.",
    Verdict.DUPLICATE: "Apple reports it already has this build. Check TestFlight; if the build is not there, run build again for a new build number.",
}


def sentence(answer: AppleAnswer) -> str:
    if answer.verdict is not Verdict.REJECTED:
        return SENTENCES[answer.verdict]
    detail = " ".join(message for message in answer.messages if message.strip())
    return (
        f"Apple rejected the build: {detail}"
        if detail
        else "Apple rejected the build and gave no readable reason; the step's log in the build's logs folder has what altool printed."
    )


UPLOAD_UNREACHABLE = (
    "Apple may or may not have received the build; check TestFlight for that build number, "
    "and run upload again with --retry-unknown-upload only if it is not there."
)
