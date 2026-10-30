"""The show store: one YAML file per show, edited under a lock.

A show is the facts every episode of a podcast shares: its channel facts as pins, the
host roster, the hosting address and the episode-number ledger. ``<directory>/<id>.yaml``
holds one. Every change is a read-modify-write under a file lock and lands by atomic
replace, so two writers (a CLI call and the Studio app, or two exports) never lose each
other's update and a reader never sees half a file.

The project stores only the show's id (``EpisodeProject.feed.show_id``). Nothing here
knows about episodes except the ledger, which maps an episode's guid to its number.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable, Iterator, Sequence
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import TypeVar

import yaml
from filelock import Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from podcast_mcp import settings
from podcast_mcp.feed.model import Person, ShowId, ShowSummary, usable_ledger
from podcast_mcp.models.feed import Pin, PinAuthor
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.file_locks import hold_shared_file_lock

T = TypeVar("T")

TITLE_KEY = "channel.title"
LOCK_WAIT_SEC = 15.0
_SLUG_MAX = 64
_VALID_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class ShowFile(BaseModel):
    """What ``<id>.yaml`` holds. It is also the profile the resolver reads."""

    model_config = ConfigDict(extra="forbid")

    id: ShowId
    pins: dict[str, Pin] = Field(default_factory=dict)
    roster: list[Person] = Field(default_factory=list)
    media_url: str | None = None
    ledger: dict[str, int] = Field(default_factory=dict)


def show_id_for(name: str) -> ShowId:
    """The file-safe id a show name spells: ASCII letters and digits joined by single hyphens."""
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", folded.lower()).strip("-")[:_SLUG_MAX].strip("-")
    if not slug:
        raise CodedValueError(
            "A show needs a name with letters or digits in it.", code="feed_show_name_invalid"
        )
    return slug


def default_directory() -> Path:
    """``PODCAST_CONFIG_DIR/shows``, with the config directory defaulting as the app's own does."""
    return settings.config_dir() / "shows"


def _checked_id(show_id: str) -> ShowId:
    if not _VALID_ID.fullmatch(show_id) or len(show_id) > _SLUG_MAX:
        raise CodedValueError(f"{show_id!r} is not a show id.", code="feed_show_unknown")
    return show_id


class ShowStore:
    """Shows on this machine, in ``directory`` (``PODCAST_CONFIG_DIR/shows``)."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def _path(self, show_id: ShowId) -> Path:
        return self.directory / f"{show_id}.yaml"

    @contextmanager
    def _lock(self, show_id: ShowId) -> Iterator[None]:
        with ExitStack() as stack:
            try:
                stack.enter_context(
                    hold_shared_file_lock(
                        self.directory / f".{show_id}.lock", timeout=LOCK_WAIT_SEC
                    )
                )
            except Timeout as exc:
                raise CodedValueError(
                    f"The show {show_id} is being changed by another program. Try again in a moment.",
                    code="feed_show_busy",
                ) from exc
            yield

    def _ids(self) -> list[ShowId]:
        if not self.directory.is_dir():
            return []
        return sorted(
            path.stem
            for path in self.directory.glob("*.yaml")
            if not path.name.startswith(".") and _VALID_ID.fullmatch(path.stem)
        )

    def _read(self, show_id: ShowId) -> ShowFile | None:
        path = self._path(show_id)
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise self._unreadable(path, "it cannot be read") from exc
        try:
            show = ShowFile.model_validate(yaml.safe_load(text) or {})
        except (yaml.YAMLError, ValidationError) as exc:
            raise self._unreadable(path, "it is not a show file") from exc
        if show.id != show_id:
            raise self._unreadable(path, f"it says it is {show.id!r}")
        return show

    @staticmethod
    def _unreadable(path: Path, why: str) -> CodedValueError:
        return CodedValueError(
            f"The show file {path.name} cannot be used: {why}. Fix or remove it.",
            code="feed_show_unreadable",
        )

    def _write(self, show: ShowFile) -> None:
        text = yaml.safe_dump(
            show.model_dump(mode="json"), sort_keys=False, allow_unicode=True, width=100
        )
        write_text_atomic(self._path(show.id), text, creation_mode=0o600)

    def shows(self) -> Sequence[ShowSummary]:
        """Every show that can be read, by id. A file that cannot be read is in ``problems``."""
        found: list[ShowSummary] = []
        for show_id in self._ids():
            try:
                show = self._read(show_id)
            except CodedValueError:
                continue
            title = show.pins.get(TITLE_KEY) if show else None
            found.append(ShowSummary(show_id, str(title.value) if title else show_id))
        return found

    def problems(self) -> list[str]:
        """One sentence for each show file that cannot be used, naming the file."""
        found: list[str] = []
        for show_id in self._ids():
            try:
                self._read(show_id)
            except CodedValueError as exc:
                found.append(str(exc))
        return found

    def profile(self, show_id: ShowId) -> ShowFile | None:
        if not _VALID_ID.fullmatch(show_id):
            return None
        return self._read(show_id)

    def create(self, name: str, by: PinAuthor = "person") -> ShowFile:
        """Make the show ``name`` spells, titled ``name`` by ``by``. An existing show is never replaced."""
        show_id = show_id_for(name)
        with self._lock(show_id):
            if self._path(show_id).exists():
                raise CodedValueError(
                    f"There is already a show called {show_id}.", code="feed_show_exists"
                )
            show = ShowFile(id=show_id, pins={TITLE_KEY: Pin(value=name.strip(), by=by)})
            self._write(show)
            return show

    def update(self, show_id: ShowId, change: Callable[[ShowFile], T]) -> T:
        """Read the show, let ``change`` edit it and save the result, all under the show's lock.

        Nothing is written when ``change`` raises or leaves the show as it was.
        """
        _checked_id(show_id)
        with self._lock(show_id):
            show = self._read(show_id)
            if show is None:
                raise CodedValueError(
                    f"There is no show called {show_id}.", code="feed_show_unknown"
                )
            before = show.model_dump(mode="json")
            result = change(show)
            if show.model_dump(mode="json") != before:
                self._write(show)
            return result

    def number_for(self, show_id: ShowId, guid: str, *, pinned: int | None = None) -> int:
        """The episode number ``guid`` holds in this show, assigned once.

        A new episode takes ``pinned`` when no other episode holds it, else the last number
        plus one. Zero, negative and repeated numbers in a hand-edited ledger are ignored.
        """

        def assign(show: ShowFile) -> int:
            usable = usable_ledger(show.ledger)
            if guid in usable:
                return usable[guid]
            taken = set(usable.values())
            number = pinned if pinned and pinned > 0 and pinned not in taken else None
            show.ledger[guid] = number or max(taken, default=0) + 1
            return show.ledger[guid]

        return self.update(show_id, assign)
