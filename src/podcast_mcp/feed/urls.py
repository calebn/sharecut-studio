"""Hosted file addresses: the one place a media template turns a file name into a URL."""

from __future__ import annotations

import re
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlsplit

AUDIO_MIME = {".mp3": "audio/mpeg", ".m4a": "audio/x-m4a"}
TRANSCRIPT_MIME = {"SRT": "application/x-subrip", "VTT": "text/vtt"}
CHAPTERS_MIME = "application/json+chapters"
# The Podcast Index namespace id every podcast:guid is a UUIDv5 under.
PODCAST_GUID_NAMESPACE = uuid.UUID("ead4c236-bf58-58c6-a2c6-a6b28d128cb6")

_SLOT = "{file}"
_ASCII = re.compile(r"[\x21-\x7e]+")


def check_https_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.netloc or not _ASCII.fullmatch(value):
        raise ValueError("must be an https address, using plain letters and numbers")
    return value


ART_EXTENSIONS = (".jpg", ".jpeg", ".png")


def is_local_art(value: str) -> bool:
    return not value.lower().startswith(("https://", "http://"))


def check_art_ref(value: str) -> str:
    """An https address, or a .jpg or .png file on this machine (kept as an absolute path)."""
    if not is_local_art(value):
        return check_https_url(value)
    path = Path(value).expanduser().resolve()
    if path.suffix.lower() not in ART_EXTENSIONS or not path.is_file():
        raise ValueError("must be an https address or an existing .jpg or .png file")
    return str(path)


def art_extension(value: str) -> str:
    """The extension the exported copy of an art file takes: ``.jpg`` or ``.png``."""
    suffix = Path(value).suffix.lower()
    return ".jpg" if suffix == ".jpeg" else suffix


def check_media_template(value: str) -> str:
    if value.count(_SLOT) != 1:
        raise ValueError("must have exactly one place for the file name")
    check_https_url(value.replace(_SLOT, "file"))
    return value


def hosted_url(template: str, file: str) -> str:
    return template.replace(_SLOT, quote(file, safe="._-"))


def audio_mime(file: str) -> str | None:
    return AUDIO_MIME.get(PurePosixPath(file).suffix.lower())


def podcast_guid(feed_url: str) -> str:
    """UUIDv5 of the feed address without scheme and trailing slashes, as the namespace specifies."""
    bare = urlsplit(feed_url)
    name = (bare.netloc + bare.path + (f"?{bare.query}" if bare.query else "")).rstrip("/")
    return str(uuid.uuid5(PODCAST_GUID_NAMESPACE, name))


def stem_of(file: str) -> str:
    return PurePosixPath(file).stem
