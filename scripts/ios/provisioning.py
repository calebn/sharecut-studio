"""Installed provisioning profiles: read their facts and judge whether one can sign an App Store
export. Reading goes through an injectable reader so nothing here needs a Mac; the checks are pure.
"""

from __future__ import annotations

import plistlib
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NamedTuple
from xml.parsers.expat import ExpatError

from scripts.ios.release_run import ToolFailed, capture_limited

SAFE_NAME_CHARACTERS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._:-"
)
PROFILE_NAME_RULE = (
    "at least two characters after trimming, using letters, digits, space and . _ : -"
)
PROFILE_DIRECTORIES = (
    "Library/MobileDevice/Provisioning Profiles",
    "Library/Developer/Xcode/UserData/Provisioning Profiles",
)
TOOL_PATH = "/usr/bin:/bin"
CMS_TIMEOUT = 10.0
CMS_OUTPUT_LIMIT = 4 << 20


class ProfileFacts(NamedTuple):
    name: str
    team: str
    app_id: str
    expires: datetime
    provisions_all: bool
    devices: int
    get_task_allow: bool
    platforms: tuple[str, ...]


Reader = Callable[[Path], ProfileFacts]


def typed(source: dict[str, Any], key: str, kind: type) -> Any:
    value = source.get(key)
    if not isinstance(value, kind):
        raise ValueError(f"{key} is not a {kind.__name__}")
    return value


def read_profile(path: Path, run: Callable[..., str] = capture_limited) -> ProfileFacts:
    decoded = plistlib.loads(
        run(
            ["security", "cms", "-D", "-i", str(path)],
            path=TOOL_PATH,
            timeout=CMS_TIMEOUT,
            limit=CMS_OUTPUT_LIMIT,
        ).encode()
    )
    if not isinstance(decoded, dict):
        raise ValueError("a profile is a dictionary")
    entitlements = typed(decoded, "Entitlements", dict)
    teams = typed(decoded, "TeamIdentifier", list)
    if not teams or not isinstance(teams[0], str):
        raise ValueError("TeamIdentifier holds no team")
    expires = typed(decoded, "ExpirationDate", datetime)
    platforms = typed(decoded, "Platform", list)
    if not platforms or not all(isinstance(platform, str) for platform in platforms):
        raise ValueError("Platform holds no platform names")
    return ProfileFacts(
        name=typed(decoded, "Name", str),
        team=teams[0],
        app_id=typed(entitlements, "application-identifier", str),
        expires=expires.replace(tzinfo=expires.tzinfo or UTC),
        provisions_all=bool(decoded.get("ProvisionsAllDevices")),
        devices=len(decoded.get("ProvisionedDevices") or ()),
        get_task_allow=bool(entitlements.get("get-task-allow")),
        platforms=tuple(platforms),
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
                if not path.is_file():
                    unreadable += 1
                    continue
                found[reader(path)] = None
            except (
                ToolFailed,
                OSError,
                ValueError,
                KeyError,
                IndexError,
                TypeError,
                AttributeError,
                ExpatError,
                RecursionError,
            ):
                unreadable += 1
    return list(found), unreadable


def bundle_of(app_id: str) -> str:
    return app_id.partition(".")[2]


def concerns(facts: ProfileFacts, bundle: str) -> bool:
    """Whether the profile explicitly targets this app for distribution."""
    return not facts.get_task_allow and bundle_of(facts.app_id) == bundle


def safe_name(name: str) -> bool:
    return len(name.strip()) >= 2 and all(character in SAFE_NAME_CHARACTERS for character in name)


def facts_problems(facts: ProfileFacts, team: str, bundle: str, now: datetime) -> list[str]:
    reasons = []
    if "iOS" not in facts.platforms:
        reasons.append("does not support iOS")
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
        reasons.append(f"name needs {PROFILE_NAME_RULE}")
    return reasons
