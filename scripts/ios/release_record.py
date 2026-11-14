"""The release record, the checkout lock, the private staged copy and the upload guard.

The record holds public facts only and is written with plain ``json``, which raises on a
``Secret``. It can only block an upload (a recorded delivery), never permit one: the guard
re-derives everything from the IPA bytes it is about to send.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from scripts.ios.release_classify import Verdict
from scripts.ios.release_inputs import BuildNumber, Signing

SCHEMA = 1
RECORD_NAME = "release.json"
BLOCKING = {Verdict.OK.value, Verdict.DUPLICATE.value}
TOKEN_HEX = 12


class RecordError(Exception):
    pass


@dataclass
class ReleaseRecord:
    build_number: str
    marketing_version: str
    bundle_identifier: str
    signing: str
    commit: str
    ipa_sha256: str
    ipa_name: str
    checks: dict[str, Any] = field(default_factory=dict)
    validations: list[dict[str, Any]] = field(default_factory=list)
    uploads: list[dict[str, Any]] = field(default_factory=list)

    @property
    def number(self) -> BuildNumber:
        return BuildNumber.parse(self.build_number)

    def token(self) -> str:
        return f"{self.build_number}:{self.ipa_sha256[:TOKEN_HEX]}"

    def delivered(self) -> bool:
        uploaded = any(
            (upload.get("outcome") or {}).get("verdict") in BLOCKING for upload in self.uploads
        )
        duplicated = any(row.get("verdict") == Verdict.DUPLICATE.value for row in self.validations)
        return uploaded or duplicated


def write_record(directory: Path, record: ReleaseRecord) -> None:
    text = json.dumps({"schema": SCHEMA, **record.__dict__}, indent=2, sort_keys=True) + "\n"
    temporary = directory / f".{RECORD_NAME}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
    temporary.replace(directory / RECORD_NAME)


def read_record(directory: Path) -> ReleaseRecord:
    try:
        raw = json.loads((directory / RECORD_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RecordError(f"{directory.name}: no readable {RECORD_NAME}") from error
    if raw.pop("schema", None) != SCHEMA:
        raise RecordError(f"{directory.name}: the record has an unknown schema; build again")
    return ReleaseRecord(**raw)


def complete_records(release_root: Path) -> list[tuple[Path, ReleaseRecord]]:
    """Every finished build; a ``.partial`` directory and anything unreadable is left out."""
    found = []
    for directory in sorted(release_root.glob("*")):
        if directory.suffix == ".partial" or not (directory / RECORD_NAME).is_file():
            continue
        try:
            found.append((directory, read_record(directory)))
        except RecordError:
            continue
    return found


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def newest(release_root: Path, build: str | None = None) -> tuple[Path, ReleaseRecord] | None:
    records = complete_records(release_root)
    if build is not None:
        records = [row for row in records if row[1].build_number == build]
    return max(
        records,
        key=lambda row: (version_key(row[1].marketing_version), row[1].number),
        default=None,
    )


def recorded_numbers(release_root: Path, marketing_version: str) -> list[BuildNumber]:
    return [
        record.number
        for _, record in complete_records(release_root)
        if record.marketing_version == marketing_version
    ]


class LockHeld(Exception):
    pass


@contextmanager
def checkout_lock(release_root: Path) -> Iterator[None]:
    """One release run at a time per checkout: anything that regenerates ``gen/apple`` or writes a
    build directory holds this."""
    release_root.mkdir(parents=True, exist_ok=True)
    with (release_root / ".lock").open("w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LockHeld(
                "another iOS release run is using this checkout; wait for it to finish"
            ) from None
        yield


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def stage_copy(ipa: Path, directory: Path) -> Path:
    """Copy *ipa* into a new private ``0700`` *directory* and return the copy. The copy is what is
    checked and uploaded, so nothing can change between the check and the use."""
    if ipa.is_symlink() or not ipa.is_file():
        raise RecordError("the IPA is not a regular file; symlinks are refused")
    directory.mkdir(mode=0o700)
    copy = directory / "app.ipa"
    shutil.copyfile(ipa, copy)
    copy.chmod(0o600)
    return copy


@dataclass(frozen=True)
class GuardFacts:
    """What the guard learned from the IPA and the checkout, none of it from the record."""

    sha256: str
    signing: Signing
    tree_clean: bool
    head: str
    build_number_in_ipa: str


def upload_preconditions(record: ReleaseRecord, confirm: str, facts: GuardFacts) -> list[str]:
    """Pure. An empty list means the upload may go on to its rechecks and revalidation."""
    expected = f"{facts.build_number_in_ipa}:{facts.sha256[:TOKEN_HEX]}"
    refusals = []
    if confirm != expected:
        refusals.append(
            f"--confirm must be {expected}, the build number and file this run will send"
        )
    if facts.build_number_in_ipa != record.build_number:
        refusals.append("the IPA's build number is not the recorded build")
    if facts.sha256 != record.ipa_sha256:
        refusals.append("the IPA is not the file the build checked (its hash changed)")
    if facts.signing is not Signing.APP_STORE:
        refusals.append("the IPA is not signed for the App Store")
    if not facts.tree_clean:
        refusals.append("the working tree has uncommitted changes")
    if record.commit != facts.head:
        refusals.append("HEAD is not the commit this build was made from")
    if record.delivered():
        refusals.append("this build was already delivered or reported as a duplicate")
    return refusals


def outcome_row(verdict: Verdict, at: str, messages: tuple[str, ...]) -> Mapping[str, object]:
    return {"verdict": verdict.value, "at": at, "messages": list(messages)}
