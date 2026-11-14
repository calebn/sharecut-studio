"""Everything a release needs from outside the code, resolved once into frozen values.

Every problem is collected and reported together, so one run tells the owner all that is missing.
The team, key id, issuer and key path come from a private ``0600`` file outside the repository
(or the environment) and are wrapped in ``Secret`` here, before anything else sees them.
"""

from __future__ import annotations

import enum
import os
import re
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from scripts import version_policy
from scripts.ios.release_secrets import Secret

from podcast_mcp.config.distribution import (
    DistributionProfileError,
    icon_name,
    load_distribution_profile,
)

PROFILE_VARIABLE = "PODCAST_DISTRIBUTION_PROFILE"
FILE_VARIABLE = "SHARECUT_IOS_RELEASE_ENV"
TEAM_NAME, KEY_ID_NAME, ISSUER_NAME, KEY_PATH_NAME = (
    "APPLE_DEVELOPMENT_TEAM",
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_PATH",
)
TEAM_SECRETS = (TEAM_NAME,)
KEY_SECRETS = (KEY_ID_NAME, ISSUER_NAME)
SECRET_NAMES = (*TEAM_SECRETS, *KEY_SECRETS, KEY_PATH_NAME)
PLACEHOLDER_TEAM = "AAAAAAAAAA"
DEV_IDENTIFIER = "studio.sharecut.dev"
TEN = re.compile(r"^[A-Z0-9]{10}$")
UUID = re.compile(r"^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$")


@dataclass(frozen=True, order=True)
class BuildNumber:
    """CFBundleVersion: ``year . month*100+day . hour*10000+minute*100+second`` in UTC.

    ``2026.1114.153045``. Component-wise numeric order is time order, three integers is what App
    Store Connect accepts, and no component has a leading zero.
    """

    year: int
    month_day: int
    time_of_day: int

    @classmethod
    def at(cls, moment: datetime) -> BuildNumber:
        if moment.tzinfo is None:
            raise ValueError("a build number needs a timezone-aware time")
        utc = moment.astimezone(UTC)
        return cls(
            utc.year,
            utc.month * 100 + utc.day,
            utc.hour * 10000 + utc.minute * 100 + utc.second,
        )

    @classmethod
    def parse(cls, text: str) -> BuildNumber:
        parts = text.split(".")
        if len(parts) != 3 or not all(re.fullmatch(r"0|[1-9]\d*", part) for part in parts):
            raise ValueError(f"{text!r} is not three dot-separated integers")
        return cls(*(int(part) for part in parts))

    def __str__(self) -> str:
        return f"{self.year}.{self.month_day}.{self.time_of_day}"


class Signing(enum.Enum):
    APP_STORE = "app-store"
    NONE = "none"


@dataclass(frozen=True)
class Identity:
    bundle_identifier: str
    name: str


@dataclass(frozen=True)
class Checkout:
    commit: str
    dirty: bool


@dataclass(frozen=True)
class BuildInputs:
    identity: Identity
    marketing_version: str
    build_number: BuildNumber
    signing: Signing
    team: Secret | None
    checkout: Checkout


@dataclass(frozen=True)
class AscKey:
    key_id: Secret
    issuer: Secret
    key_path: Secret


@dataclass(frozen=True)
class InputProblem:
    name: str
    source: str
    why: str


class InputError(Exception):
    def __init__(self, problems: Sequence[InputProblem]) -> None:
        self.problems = tuple(problems)
        super().__init__(
            f"{len(self.problems)} inputs are missing or wrong; nothing was run\n"
            + "\n".join(f"  {p.name} ({p.source}): {p.why}" for p in self.problems)
        )


def absent(path: Path) -> bool:
    return not path.exists() and not path.is_symlink()


def read_private_file(path: Path, checkout: Path) -> tuple[dict[str, str], list[InputProblem]]:
    """``NAME=value`` lines from the private file; never echoes a value."""
    source = "private file"
    try:
        info = path.lstat()
    except OSError:
        return {}, [InputProblem(str(path.name), source, "cannot be read")]
    problems = []
    if not stat.S_ISREG(info.st_mode):
        problems.append("is not a regular file")
    if info.st_mode & 0o077:
        problems.append("is readable by others; run chmod 600 on it")
    if info.st_uid != os.getuid():
        problems.append("is owned by another user")
    if path.resolve().is_relative_to(checkout.resolve()):
        problems.append("is inside the repository")
    if problems:
        return {}, [InputProblem(path.name, source, why) for why in problems]
    values: dict[str, str] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        name, equals, value = text.partition("=")
        name = name.strip()
        if not equals or name not in SECRET_NAMES:
            problems.append(
                InputProblem(
                    f"{path.name} line {number}", source, "is not NAME=value for a known name"
                )
            )
            continue
        values[name] = value.strip().strip("'\"")
    return values, problems


def private_values(
    environ: Mapping[str, str], checkout: Path, home: Path, needs: Sequence[str] = ()
) -> tuple[dict[str, str], list[InputProblem]]:
    """The private file's values, overridden by the environment. When the file is absent and a
    name in *needs* is still unset, the one problem is where the file was expected."""
    named = environ.get(FILE_VARIABLE)
    location = Path(named or home / ".config" / "sharecut" / "ios-release.env")
    missing = absent(location)
    values, problems = ({}, []) if missing else read_private_file(location, checkout)
    values.update({name: environ[name] for name in SECRET_NAMES if environ.get(name)})
    if missing and any(name not in values for name in needs):
        source, why = (
            ("private file", "does not exist")
            if named
            else (
                "default private file",
                f"does not exist; create it there with mode 0600 or set {FILE_VARIABLE}",
            )
        )
        problems.append(InputProblem(str(location), source, why))
    return values, problems


def resolve_team(values: Mapping[str, str]) -> tuple[Secret | None, list[InputProblem]]:
    source = "private file or environment"
    team = values.get(TEAM_NAME, "")
    if not team:
        return None, [InputProblem(TEAM_NAME, source, "missing")]
    if team == PLACEHOLDER_TEAM:
        return None, [InputProblem(TEAM_NAME, source, "is the Simulator placeholder")]
    if not TEN.fullmatch(team):
        return None, [InputProblem(TEAM_NAME, source, "is not 10 capital letters or digits")]
    return Secret(team, "team"), []


def resolve_asc_key(
    values: Mapping[str, str], home: Path, checkout: Path
) -> tuple[AscKey | None, list[InputProblem]]:
    source = "private file or environment"
    problems = [
        InputProblem(name, source, "missing") for name in KEY_SECRETS if not values.get(name)
    ]
    key_id, issuer = values.get(KEY_ID_NAME, ""), values.get(ISSUER_NAME, "")
    if key_id and not TEN.fullmatch(key_id):
        problems.append(InputProblem(KEY_ID_NAME, source, "is not 10 capital letters or digits"))
    if issuer and not UUID.fullmatch(issuer):
        problems.append(InputProblem(ISSUER_NAME, source, "is not a UUID"))
    path_text = values.get(KEY_PATH_NAME) or (
        str(home / ".appstoreconnect" / "private_keys" / f"AuthKey_{key_id}.p8") if key_id else ""
    )
    if path_text:
        problems += key_file_problems(Path(path_text), checkout)
    if problems:
        return None, problems
    key = AscKey(Secret(key_id, "key-id"), Secret(issuer, "issuer"), Secret(path_text, "key-path"))
    return key, []


def key_file_problems(path: Path, checkout: Path) -> list[InputProblem]:
    """The key file is checked by its metadata only; the tool never opens it."""
    name, source = KEY_PATH_NAME, "private file or environment"
    try:
        info = path.lstat()
    except OSError:
        return [InputProblem(name, source, "the key file does not exist")]
    problems = []
    if not stat.S_ISREG(info.st_mode):
        problems.append("is not a regular file")
    if info.st_mode & 0o077:
        problems.append("is readable by others; run chmod 600 on it")
    if path.resolve().is_relative_to(checkout.resolve()):
        problems.append("is inside the repository")
    return [InputProblem(name, source, why) for why in problems]


def load_identity(environ: Mapping[str, str]) -> tuple[Identity | None, list[InputProblem]]:
    where = PROFILE_VARIABLE
    named = environ.get(where)
    if not named:
        return None, [
            InputProblem(
                where, "environment", "missing; the checked-in dev profile cannot make a release"
            )
        ]
    try:
        profile = load_distribution_profile(Path(named))
    except DistributionProfileError as error:
        return None, [InputProblem(where, "environment", str(error)[:200])]
    problems = []
    if profile.bundle_identifier == DEV_IDENTIFIER:
        problems.append(
            InputProblem(
                "bundle_identifier", "distribution profile", "is the development identifier"
            )
        )
    name = icon_name(profile)
    if len(name) > 15:
        problems.append(
            InputProblem(
                "short_name",
                "distribution profile",
                f"missing and product_name is {len(name)} characters; the name under the icon allows 15",
            )
        )
    if problems:
        return None, problems
    return Identity(profile.bundle_identifier, name), []


def marketing_version(root: Path) -> tuple[str | None, list[InputProblem]]:
    found = version_policy.versions(root)
    issues = version_policy.problems(found)
    if issues:
        return None, [InputProblem("version", "version policy", issues[0].splitlines()[0])]
    return next(iter(found.values())), []


def resolve_build_inputs(
    *,
    environ: Mapping[str, str],
    values: Mapping[str, str],
    file_problems: Sequence[InputProblem],
    root: Path,
    now: datetime,
    signing: Signing,
    checkout: Checkout,
    recorded: Sequence[BuildNumber],
    toolchain_problem: InputProblem | None = None,
) -> BuildInputs:
    problems = list(file_problems)
    identity, found = load_identity(environ)
    problems += found
    version, found = marketing_version(root)
    problems += found
    team: Secret | None = None
    if signing is Signing.APP_STORE:
        team, found = resolve_team(values)
        problems += found
        if checkout.dirty:
            problems.append(
                InputProblem(
                    "working tree", "git", "has uncommitted changes; upload would refuse this build"
                )
            )
    if toolchain_problem:
        problems.append(toolchain_problem)
    number = BuildNumber.at(now)
    if recorded and number <= max(recorded):
        problems.append(
            InputProblem(
                "clock",
                "build number",
                f"{number} is not newer than recorded build {max(recorded)} for this version; fix the clock or bump the version",
            )
        )
    if problems or identity is None or version is None:
        raise InputError(problems)
    return BuildInputs(identity, version, number, signing, team, checkout)
