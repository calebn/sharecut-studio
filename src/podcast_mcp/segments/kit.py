"""The show kit: an ordered list of library segments and where each one goes.

``kit.json`` names segments by id (and optionally a pinned version); it holds no audio. The
kit library sits beside the segment library, ``<config>/kits/<id>/v<N>/kit.json``, with the
same conventions: ids derived from the name, versions assigned by the store, one lock, a
version staged in a hidden folder and landed by one rename.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal

from filelock import Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from podcast_mcp import settings
from podcast_mcp.segments.model import (
    MAX_SEGMENT_JSON_BYTES,
    is_segment_id,
    read_capped,
    slug_id_for,
)
from podcast_mcp.segments.position import parse_position
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.file_locks import hold_shared_file_lock

KIT_JSON = "kit.json"
MAX_KIT_ENTRIES = 32
LOCK_WAIT_SEC = 15.0
_VERSION_DIR = re.compile(r"^v([1-9][0-9]*)$")

KitAddStatus = Literal["added", "unchanged", "new_version", "skipped"]


def kit_id_for(name: str) -> str:
    """The id of a kit called ``name`` (same rule as a segment id)."""
    return slug_id_for(name, code="kit_name_invalid", what="kit")


def is_kit_id(value: str) -> bool:
    return is_segment_id(value)


class KitEntry(BaseModel):
    """One segment of a kit: which one, which version, and where it goes."""

    model_config = ConfigDict(extra="forbid")

    segment_id: str
    version: Annotated[int, Field(ge=1)] | None = None
    at: float | Literal["start", "end"]
    note: str | None = None

    @field_validator("version", mode="before")
    @classmethod
    def _whole_version(cls, value: object) -> object:
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("version must be a whole number or null")
        return value

    @field_validator("at", mode="before")
    @classmethod
    def _position(cls, value: object) -> object:
        try:
            return parse_position(value)
        except CodedValueError as exc:
            raise ValueError(str(exc)) from exc

    @model_validator(mode="after")
    def _consistent(self) -> KitEntry:
        if not is_segment_id(self.segment_id):
            raise ValueError(f"{self.segment_id!r} is not a segment id")
        if isinstance(self.at, float) and self.at < 0:
            raise ValueError("a position in seconds cannot be negative")
        return self

    def label(self) -> str:
        pinned = f" v{self.version}" if self.version else ""
        return f"{self.segment_id}{pinned}"

    def where(self) -> str:
        return self.at if isinstance(self.at, str) else f"{self.at:g} s"


class KitFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    id: str
    name: str = Field(min_length=1)
    version: Annotated[int, Field(ge=1)] = 1
    entries: list[KitEntry] = Field(min_length=1, max_length=MAX_KIT_ENTRIES)

    @field_validator("schema_version", mode="before")
    @classmethod
    def _integer_one(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("schema_version must be the integer 1")
        return value

    @model_validator(mode="after")
    def _consistent(self) -> KitFile:
        if not is_kit_id(self.id):
            raise ValueError(f"{self.id!r} is not a kit id")
        return self

    @property
    def content_sha256(self) -> str:
        """Identifies the content: the entries, not the name or version."""
        layout = [entry.model_dump(mode="json") for entry in self.entries]
        text = json.dumps(layout, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_kit(raw: bytes | str) -> KitFile:
    """Read ``kit.json``. Raises ``kit_schema_unsupported`` or ``kit_invalid``."""
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise CodedValueError("kit.json is not valid JSON.", code="kit_invalid") from exc
    if not isinstance(data, dict):
        raise CodedValueError("kit.json must hold one object.", code="kit_invalid")
    version = data.get("schema_version")
    if type(version) is not int or version != 1:
        raise CodedValueError(
            f"This kit uses schema version {version!r}, which this app does not read.",
            code="kit_schema_unsupported",
        )
    try:
        return KitFile.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(part) for part in first["loc"])
        raise CodedValueError(
            f"kit.json is not a kit file: {where + ': ' if where else ''}{first['msg']}.",
            code="kit_invalid",
        ) from exc


def kit_json(kit: KitFile) -> str:
    return json.dumps(kit.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n"


def default_kit_directory() -> Path:
    """``PODCAST_CONFIG_DIR/kits``, beside the segment library."""
    return settings.config_dir() / "kits"


@dataclass(frozen=True)
class KitAddResult:
    status: KitAddStatus
    id: str
    version: int

    def wire(self) -> dict[str, str | int]:
        return {"status": self.status, "id": self.id, "version": self.version}


@dataclass(frozen=True)
class DamagedKit:
    id: str
    version: int
    problem: str
    code: str


@dataclass(frozen=True)
class KitListing:
    kits: Sequence[KitFile]
    damaged: Sequence[DamagedKit]


class KitStore:
    """Kits on this machine, in ``directory`` (``PODCAST_CONFIG_DIR/kits``)."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory if directory is not None else default_kit_directory()

    @contextmanager
    def _lock(self) -> Iterator[None]:
        with ExitStack() as stack:
            try:
                stack.enter_context(
                    hold_shared_file_lock(self.directory / ".kits.lock", timeout=LOCK_WAIT_SEC)
                )
            except Timeout as exc:
                raise CodedValueError(
                    "The kit library is being changed by another program. Try again in a moment.",
                    code="kit_busy",
                ) from exc
            except OSError as exc:
                raise CodedValueError(
                    f"The kit library at {self.directory} cannot be opened: {exc.strerror or exc}.",
                    code="kit_write_failed",
                ) from exc
            yield

    def _ids(self) -> Sequence[str]:
        if not self.directory.is_dir():
            return []
        return sorted(
            path.name
            for path in self.directory.iterdir()
            if path.is_dir() and not path.is_symlink() and is_kit_id(path.name)
        )

    def versions(self, kit_id: str) -> Sequence[int]:
        folder = self.directory / kit_id
        if not is_kit_id(kit_id) or not folder.is_dir():
            return []
        return sorted(
            int(match.group(1))
            for path in folder.iterdir()
            if path.is_dir() and (match := _VERSION_DIR.fullmatch(path.name))
        )

    @staticmethod
    def _unknown(kit_id: str) -> CodedValueError:
        return CodedValueError(f"There is no kit called {kit_id}.", code="kit_unknown")

    def _read(self, folder: Path) -> KitFile:
        raw = read_capped(
            folder / KIT_JSON,
            MAX_SEGMENT_JSON_BYTES,
            what=f"The kit folder {folder.parent.name}/{folder.name} "
            "(remove it and import the kit again)",
            code="kit_unreadable",
        )
        kit = parse_kit(raw)
        if kit.id != folder.parent.name or kit.version != int(folder.name[1:]):
            raise CodedValueError(
                f"The kit folder {folder.parent.name}/{folder.name} says it is "
                f"{kit.id} v{kit.version}. Remove it and import the kit again.",
                code="kit_unreadable",
            )
        return kit

    def get(self, kit_id: str, version: int | None = None) -> KitFile:
        versions = self.versions(kit_id)
        if not versions:
            raise self._unknown(kit_id)
        chosen = versions[-1] if version is None else version
        if chosen not in versions:
            raise CodedValueError(f"The kit {kit_id} has no version {chosen}.", code="kit_unknown")
        return self._read(self.directory / kit_id / f"v{chosen}")

    def scan(self) -> KitListing:
        """The newest version of every kit, and the ones that could not be read."""
        found: list[KitFile] = []
        damaged: list[DamagedKit] = []
        for kit_id in self._ids():
            try:
                versions = self.versions(kit_id)
            except OSError:
                continue
            if not versions:
                continue
            folder = self.directory / kit_id / f"v{versions[-1]}"
            try:
                found.append(self._read(folder))
            except CodedValueError as exc:
                if folder.exists():
                    damaged.append(DamagedKit(kit_id, versions[-1], str(exc), exc.code))
        return KitListing(found, damaged)

    def list(self) -> Sequence[KitFile]:
        return self.scan().kits

    def add(self, kit: KitFile, *, keep_existing: bool = False) -> KitAddResult:
        """Store ``kit`` as the next version of its id, unless a stored version has its entries.

        The id must be the one its name derives. The version number on ``kit`` is ignored.
        With ``keep_existing`` a kit that already has other entries is left as it is and the
        result is ``skipped`` (naming the newest stored version).
        """
        if kit.id != kit_id_for(kit.name):
            raise CodedValueError(
                f"The kit id {kit.id!r} does not match its name {kit.name!r}.", code="kit_invalid"
            )
        with self._lock():
            versions = self.versions(kit.id)
            for version in versions:
                try:
                    stored = self._read(self.directory / kit.id / f"v{version}")
                except CodedValueError:
                    continue
                if stored.content_sha256 == kit.content_sha256:
                    return KitAddResult("unchanged", stored.id, stored.version)
            if versions and keep_existing:
                return KitAddResult("skipped", kit.id, versions[-1])
            number = (versions[-1] if versions else 0) + 1
            stored = kit.model_copy(update={"version": number})
            self._install(stored)
            return KitAddResult("new_version" if versions else "added", stored.id, number)

    def _install(self, kit: KitFile) -> None:
        folder = self.directory / kit.id
        staging: Path | None = None
        try:
            folder.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=folder))
            write_text_atomic(staging / KIT_JSON, kit_json(kit))
            staging.rename(folder / f"v{kit.version}")
        except BaseException as exc:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
            if isinstance(exc, OSError):
                raise CodedValueError(
                    f"The kit could not be written to {self.directory}: {exc.strerror or exc}.",
                    code="kit_write_failed",
                ) from exc
            raise

    def remove(self, kit_id: str) -> None:
        """Delete every version of a kit. The segments it names stay in the library."""
        if not is_kit_id(kit_id):
            raise self._unknown(kit_id)
        with self._lock():
            folder = self.directory / kit_id
            if not folder.is_dir():
                raise self._unknown(kit_id)
            try:
                shutil.rmtree(folder)
            except OSError as exc:
                raise CodedValueError(
                    f"The kit {kit_id} could not be removed: {exc.strerror or exc}.",
                    code="kit_write_failed",
                ) from exc


def kit_wire(kit: KitFile, versions: Sequence[int]) -> dict[str, Any]:
    return {**kit.model_dump(mode="json"), "versions": list(versions)}
