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
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from scripts import version_policy
from scripts.ios.provisioning import ProfileFacts, concerns, facts_problems, safe_name
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
PROFILE_NAME, CERTIFICATE_NAME = "APPLE_PROVISIONING_PROFILE", "APPLE_SIGNING_CERTIFICATE"
SECRET_NAMES = (*TEAM_SECRETS, *KEY_SECRETS, KEY_PATH_NAME, PROFILE_NAME, CERTIFICATE_NAME)
PROVISIONING_SOURCE = "private file, environment or installed profiles"
DEFAULT_CERTIFICATE = "Apple Distribution"
CERTIFICATE = re.compile(r"^[A-Za-z0-9 .,_:()'-]{1,100}$")
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
    key: AscKey | None
    provisioning: Provisioning | None = None


@dataclass(frozen=True)
class Provisioning:
    profile: Secret
    certificate: str


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
    """``NAME=value`` lines from the private file; never echoes a value. A path that is not there
    holds no values and is no problem here: the caller says where the file was expected."""
    if absent(path):
        return {}, []
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
    values, problems = read_private_file(location, checkout)
    values.update({name: environ[name] for name in SECRET_NAMES if environ.get(name)})
    if absent(location) and any(name not in values for name in needs):
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


def resolve_provisioning(
    values: Mapping[str, str],
    profiles: Sequence[ProfileFacts],
    team: str,
    bundle: str,
    now: datetime,
    unreadable: int = 0,
) -> tuple[Provisioning | None, list[InputProblem]]:
    """A named profile never falls back; unnamed, one usable profile is used and none for this app
    keeps the automatic path. Anything else refuses with counts and reasons, never a name."""
    certificate = values.get(CERTIFICATE_NAME) or DEFAULT_CERTIFICATE
    if not CERTIFICATE.fullmatch(certificate):
        return None, [
            InputProblem(
                CERTIFICATE_NAME, PROVISIONING_SOURCE, "has characters a certificate name never has"
            )
        ]
    explicit = values.get(PROFILE_NAME, "")
    if explicit:
        return resolve_named(explicit, certificate, profiles, team, bundle, now)
    candidates = [facts for facts in profiles if concerns(facts, bundle)]
    if not candidates:
        if profiles or not unreadable:
            return None, []
        why = (
            f"{unreadable} profile file(s) could not be read (is `security` available?); "
            "the build stops rather than guess, because automatic signing with the API key "
            "cannot create a profile"
        )
        return None, [InputProblem("provisioning profile", PROVISIONING_SOURCE, why)]
    usable = [f for f in candidates if not facts_problems(f, team, bundle, now)]
    if len(usable) == 1:
        return Provisioning(Secret(usable[0].name, "provisioning-profile"), certificate), []
    if usable:
        why = (
            f"{len(usable)} valid App Store profiles are installed for {bundle}; keep one, or set "
            f"{PROFILE_NAME} when their names differ"
        )
    else:
        why = (
            f"{len(candidates)} installed profile(s) for {bundle} cannot sign an App Store export: "
            f"{reason_counts(candidates, team, bundle, now)}. The build stops instead of using "
            "automatic signing, which cannot create a profile with the API key; install a valid "
            f"App Store profile or set {PROFILE_NAME} to one"
        )
    return None, [InputProblem("provisioning profile", PROVISIONING_SOURCE, why)]


def resolve_named(
    explicit: str,
    certificate: str,
    profiles: Sequence[ProfileFacts],
    team: str,
    bundle: str,
    now: datetime,
) -> tuple[Provisioning | None, list[InputProblem]]:
    named = [facts for facts in profiles if facts.name == explicit]
    if not safe_name(explicit):
        why = "has characters outside letters, digits, space and . _ -"
    elif not named:
        why = "names no installed profile"
    elif len(named) > 1:
        why = f"{len(named)} installed profiles carry that name; remove the extra ones"
    elif reasons := facts_problems(named[0], team, bundle, now):
        why = (
            f"names a profile that cannot sign an App Store export for {bundle}: "
            f"{', '.join(reasons)}"
        )
    else:
        return Provisioning(Secret(explicit, "provisioning-profile"), certificate), []
    return None, [InputProblem(PROFILE_NAME, PROVISIONING_SOURCE, why)]


def reason_counts(profiles: Sequence[ProfileFacts], team: str, bundle: str, now: datetime) -> str:
    counts = Counter(r for facts in profiles for r in facts_problems(facts, team, bundle, now))
    return ", ".join(f"{count} {reason}" for reason, count in sorted(counts.items()))


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
    home: Path | None = None,
    profiles: Sequence[ProfileFacts] = (),
    unreadable_profiles: int = 0,
) -> BuildInputs:
    problems = list(file_problems)
    identity, found = load_identity(environ)
    problems += found
    version, found = marketing_version(root)
    problems += found
    team: Secret | None = None
    key: AscKey | None = None
    provisioning: Provisioning | None = None
    if signing is Signing.APP_STORE:
        team, found = resolve_team(values)
        problems += found
        key, found = resolve_asc_key(values, home or Path.home(), root)
        problems += found
        if team is not None and identity is not None:
            provisioning, found = resolve_provisioning(
                values,
                profiles,
                values[TEAM_NAME],
                identity.bundle_identifier,
                now,
                unreadable_profiles,
            )
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
    return BuildInputs(identity, version, number, signing, team, checkout, key, provisioning)
