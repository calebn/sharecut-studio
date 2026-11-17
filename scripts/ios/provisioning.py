"""Installed provisioning profiles: read their facts and judge whether one can sign an App Store
export. Reading goes through an injectable reader so nothing here needs a Mac; the checks are pure.
"""

from __future__ import annotations

import plistlib
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NamedTuple

from scripts.ios.release_run import ToolFailed, capture

SAFE_NAME_CHARACTERS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-"
)
PROFILE_DIRECTORIES = (
    "Library/MobileDevice/Provisioning Profiles",
    "Library/Developer/Xcode/UserData/Provisioning Profiles",
)
TOOL_PATH = "/usr/bin:/bin"


class ProfileFacts(NamedTuple):
    name: str
    team: str
    app_id: str
    expires: datetime
    provisions_all: bool
    devices: int
    get_task_allow: bool


Reader = Callable[[Path], ProfileFacts]


def default_directories(home: Path) -> list[Path]:
    return [home / relative for relative in PROFILE_DIRECTORIES]


def typed(source: dict[str, Any], key: str, kind: type) -> Any:
    value = source.get(key)
    if not isinstance(value, kind):
        raise ValueError(f"{key} is not a {kind.__name__}")
    return value


def read_profile(path: Path, run: Callable[..., str] = capture) -> ProfileFacts:
    decoded = plistlib.loads(
        run(["security", "cms", "-D", "-i", str(path)], path=TOOL_PATH).encode()
    )
    if not isinstance(decoded, dict):
        raise ValueError("a profile is a dictionary")
    entitlements = typed(decoded, "Entitlements", dict)
    teams = typed(decoded, "TeamIdentifier", list)
    if not teams or not isinstance(teams[0], str):
        raise ValueError("TeamIdentifier holds no team")
    expires = typed(decoded, "ExpirationDate", datetime)
    return ProfileFacts(
        name=typed(decoded, "Name", str),
        team=teams[0],
        app_id=typed(entitlements, "application-identifier", str),
        expires=expires.replace(tzinfo=expires.tzinfo or UTC),
        provisions_all=bool(decoded.get("ProvisionsAllDevices")),
        devices=len(decoded.get("ProvisionedDevices") or ()),
        get_task_allow=bool(entitlements.get("get-task-allow")),
    )


def discover(
    directories: Iterable[Path], reader: Reader = read_profile
) -> tuple[list[ProfileFacts], int]:
    """Every readable profile in *directories*, each distinct one once (Xcode keeps copies in
    both places), and how many files could not be read."""
    found: dict[ProfileFacts, None] = {}
    unreadable = 0
    for directory in directories:
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.mobileprovision")):
            try:
                found[reader(path)] = None
            except (
                ToolFailed,
                OSError,
                ValueError,
                KeyError,
                IndexError,
                TypeError,
                AttributeError,
            ):
                unreadable += 1
    return list(found), unreadable


def bundle_of(app_id: str) -> str:
    return app_id.partition(".")[2]


def concerns(facts: ProfileFacts, bundle: str) -> bool:
    """Whether the profile is meant for this app: its bundle part is the identifier or a wildcard
    that covers it. Profiles of other apps are noise, not rejected candidates."""
    own = bundle_of(facts.app_id)
    if own.endswith("*"):
        return bundle.startswith(own[:-1])
    return own == bundle


def safe_name(name: str) -> bool:
    return bool(name) and all(character in SAFE_NAME_CHARACTERS for character in name)


def facts_problems(facts: ProfileFacts, team: str, bundle: str, now: datetime) -> list[str]:
    reasons = []
    if facts.expires <= now:
        reasons.append("expired")
    if facts.get_task_allow:
        reasons.append("development profile (get-task-allow)")
    if facts.provisions_all:
        reasons.append("enterprise profile (provisions all devices)")
    if facts.devices:
        reasons.append("ad hoc profile (lists devices)")
    if facts.team != team:
        reasons.append("another team")
    elif facts.app_id != f"{team}.{bundle}":
        reasons.append("wildcard app id" if facts.app_id.endswith("*") else "another app id")
    if not safe_name(facts.name):
        reasons.append("name outside letters, digits, space and . _ -")
    return reasons
