"""Why a model download failed, classified once and worded without paths, URLs or env vars."""

from __future__ import annotations

import errno
import urllib.error
from typing import Literal

from podcast_mcp.engines.models.whisper import WhisperPinMismatchError
from podcast_mcp.engines.models.word_aligner import WordAlignerPinMismatchError
from podcast_mcp.util.asset_sources import AssetIntegrityError, AssetSourceError
from podcast_mcp.util.coded_error import CodedError

FailureKind = Literal["http", "pin_mismatch", "network", "disk"]

_PLAIN = {
    "http_missing": "The download server doesn't have {label}.",
    "http_denied": "The download server refused access to {label}.",
    "http_busy": "The download server is busy. Try again in a few minutes.",
    "http_server": "The download server had a problem. Try again later.",
    "http_other": "The download server couldn't provide {label}.",
    "pin_mismatch": "{label} downloaded but isn't the expected version. Run: {fix}",
    "network": "Couldn't reach the download server. Check your internet connection and try again.",
    "offline": "Downloads are turned off on this machine.",
    "disk_full": "There isn't enough free disk space to save {label}.",
    "disk_denied": "{label} can't be saved because the download folder isn't writable.",
}
_DISK_FULL = frozenset({errno.ENOSPC, errno.EDQUOT})
_DISK_DENIED = frozenset({errno.EACCES, errno.EROFS})


class InstallFailure(CodedError):
    """A model download that failed for a known reason; ``plain`` is safe to show anyone."""

    code = "install_failed"

    def __init__(self, kind: FailureKind, status: int | None, plain: str) -> None:
        super().__init__(plain)
        self.kind = kind
        self.status = status
        self.plain = plain


def unexpected_text(label: str) -> str:
    """What anyone is told when the cause is not a known one; the cause stays in the log."""
    return f"{label} could not be installed."


def _http_key(status: int) -> str:
    if status in (401, 403):
        return "http_denied"
    if status in (404, 410):
        return "http_missing"
    if status == 429:
        return "http_busy"
    return "http_server" if status >= 500 else "http_other"


def _is_pin_text(message: str) -> bool:
    """A pinned download whose size or sha256 is not the pin (the RNNoise size tripwire)."""
    text = message.lower()
    return "size mismatch" in text or "sha256 mismatch" in text or "sha mismatch" in text


def _reason(exc: BaseException) -> tuple[FailureKind, int | None, str] | None:
    from huggingface_hub import constants
    from huggingface_hub.errors import (
        DryRunError,
        HfHubHTTPError,
        HTTPError,
        LocalEntryNotFoundError,
        OfflineModeIsEnabled,
    )

    if isinstance(exc, AssetSourceError) and exc.attempts:
        if any(isinstance(a, AssetIntegrityError) for a in exc.attempts):
            return "pin_mismatch", None, "pin_mismatch"
        last = exc.attempts[-1]
        found = _reason(last)
        if found is None and isinstance(last, AssetSourceError):
            return "network", None, "network"
        return found
    if isinstance(exc, AssetIntegrityError | WhisperPinMismatchError | WordAlignerPinMismatchError):
        return "pin_mismatch", None, "pin_mismatch"
    if isinstance(exc, AssetSourceError) and _is_pin_text(str(exc)):
        return "pin_mismatch", None, "pin_mismatch"
    if isinstance(exc, HfHubHTTPError):
        return "http", exc.response.status_code, _http_key(exc.response.status_code)
    if isinstance(exc, urllib.error.HTTPError):
        return "http", exc.code, _http_key(exc.code)
    if isinstance(exc, OfflineModeIsEnabled | DryRunError | LocalEntryNotFoundError):
        return "network", None, "offline" if constants.HF_HUB_OFFLINE else "network"
    if isinstance(
        exc,
        urllib.error.URLError | TimeoutError | ConnectionError | HTTPError,
    ):
        return "network", None, "network"
    if isinstance(exc, OSError) and exc.errno in _DISK_FULL | _DISK_DENIED:
        return "disk", None, "disk_full" if exc.errno in _DISK_FULL else "disk_denied"
    return None


def classify(exc: BaseException, *, label: str, fix: str) -> InstallFailure | None:
    """The typed failure for a known cause, or None for anything unexpected (a bug to re-raise).

    ``fix`` is the command a ``pin_mismatch`` tells the user to run. A refused redirect in a
    URL attempt (``AssetSourceError``) is the source being unreachable, so it reads as
    ``network``; a ``ValueError`` is not classified.
    """
    found = _reason(exc)
    if found is None:
        return None
    kind, status, key = found
    return InstallFailure(kind, status, _PLAIN[key].format(label=label, fix=fix))
