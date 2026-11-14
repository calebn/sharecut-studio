"""What the tools said, in one sentence each. Pure functions over redacted output."""

from __future__ import annotations

import enum
import json
import re
from dataclasses import dataclass


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


def altool_messages(text: str) -> tuple[str, ...]:
    try:
        document = json.loads(text)
    except json.JSONDecodeError:
        return tuple(line.strip() for line in text.splitlines() if "error" in line.lower())[:5]
    errors = document.get("product-errors") or []
    return tuple(
        str(error.get("message") or error.get("userInfo", {}).get("NSLocalizedDescription") or "")
        for error in errors
    )


def classify_altool(exit_code: int, text: str) -> AppleAnswer:
    messages = altool_messages(text)
    if exit_code == 0 and not messages:
        return AppleAnswer(Verdict.OK)
    haystack = " ".join(messages) or text
    for pattern, verdict in (
        (DUPLICATE, Verdict.DUPLICATE),
        (AUTH, Verdict.AUTH_FAILED),
        (NETWORK, Verdict.UNREACHABLE),
    ):
        if pattern.search(haystack):
            return AppleAnswer(verdict, messages)
    return AppleAnswer(Verdict.REJECTED, messages)


def app_record_exists(text: str, bundle_identifier: str) -> bool:
    try:
        applications = json.loads(text).get("applications") or []
    except json.JSONDecodeError:
        return False
    return any(bundle_identifier in json.dumps(entry) for entry in applications)


SENTENCES = {
    Verdict.REJECTED: "Apple rejected the build:",
    Verdict.AUTH_FAILED: "Apple refused the App Store Connect key. Check the key id, issuer and key file in the private file; the key needs the Developer role.",
    Verdict.UNREACHABLE: "Apple could not be reached; nothing was changed. Check the network and run the same command again.",
    Verdict.DUPLICATE: "Apple reports it already has this build. Check TestFlight; if the build is not there, run build again for a new build number.",
}
