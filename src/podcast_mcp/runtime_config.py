"""Validated host runtime configuration for self-hosted collaboration.

Runtime settings belong to the machine running Sharecut.  They are deliberately
separate from the build-time desktop distribution profile.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yaml

DEFAULT_RELAY_URL = "ws://127.0.0.1:8080/tunnel"
DEFAULT_PUBLIC_BASE_URL = "http://127.0.0.1:8080"
DEFAULT_LOCAL_GUI_URL = "http://127.0.0.1:8765"
RELAY_HOST_ID_FILENAME = "relay_host_id"

# host_id is the ``host_id:`` prefix in PODCAST_RELAY_HOST_TOKENS, so it must not
# contain the ``:`` / ``,`` separators that map is parsed with.
_HOST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

log = logging.getLogger(__name__)


class RuntimeConfigError(ValueError):
    """A runtime config file or override is unsafe or malformed."""


@dataclass(frozen=True)
class ObjectStoreConfig:
    """S3-compatible object storage used as an optional media bypass."""

    endpoint_url: str
    region: str
    bucket: str
    access_key_id: str
    secret_access_key: str
    cdn_endpoint: str | None = None


@dataclass
class RelayConfig:
    relay_url: str = DEFAULT_RELAY_URL
    host_token: str = ""
    public_base_url: str = DEFAULT_PUBLIC_BASE_URL
    local_gui_url: str = DEFAULT_LOCAL_GUI_URL
    # Stable per-install identity (see persisted_relay_host_id); a fresh uuid per
    # process would never match a ``host_id:secret`` entry on the relay.
    host_id: str = field(default_factory=lambda: persisted_relay_host_id())


@dataclass(frozen=True)
class HostRuntimeConfig:
    relay: RelayConfig
    object_store: ObjectStoreConfig | None = None


_RELAY_ENV = {
    "relay_url": "PODCAST_RELAY_URL",
    "host_token": "PODCAST_RELAY_HOST_TOKEN",
    "public_base_url": "PODCAST_RELAY_PUBLIC_BASE_URL",
    "local_gui_url": "PODCAST_RELAY_LOCAL_GUI_URL",
    "host_id": "PODCAST_RELAY_HOST_ID",
}

_OBJECT_STORE_ENV = {
    "endpoint_url": "PODCAST_OBJECT_STORE_ENDPOINT_URL",
    "region": "PODCAST_OBJECT_STORE_REGION",
    "bucket": "PODCAST_OBJECT_STORE_BUCKET",
    "access_key_id": "PODCAST_OBJECT_STORE_ACCESS_KEY_ID",
    "secret_access_key": "PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY",
    "cdn_endpoint": "PODCAST_OBJECT_STORE_CDN_ENDPOINT",
}

_RELAY_YAML_KEYS = frozenset(_RELAY_ENV)
_OBJECT_STORE_YAML_KEYS = frozenset(_OBJECT_STORE_ENV)
_TOP_LEVEL_YAML_KEYS = _RELAY_YAML_KEYS | {"object_store"}


def default_relay_config_path() -> Path:
    override = os.environ.get("PODCAST_RELAY_CONFIG", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "podcast_mcp" / "relay.yaml"


def relay_host_id_path(config_path: Path | None = None) -> Path:
    """Per-install relay host identity file, stored next to ``relay.yaml``."""
    return (config_path or default_relay_config_path()).with_name(RELAY_HOST_ID_FILENAME)


def persisted_relay_host_id(config_path: Path | None = None) -> str:
    """Return this install's relay ``host_id``, minting a uuid once on first use.

    Used when neither ``PODCAST_RELAY_HOST_ID`` nor the ``host_id`` YAML key is
    set, so a restarted host presents the same identity (and keeps its relay
    token bindings / ``host_id:secret`` mapping).
    """
    path = relay_host_id_path(config_path)
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except OSError:
        existing = ""
    if existing:
        return existing
    minted = uuid.uuid4().hex
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # Another process minted it first; use theirs.
        return path.read_text(encoding="utf-8").strip() or minted
    except OSError:
        log.warning(
            "Cannot persist relay host_id at %s; using an ephemeral id. "
            "Set PODCAST_RELAY_HOST_ID for a stable identity.",
            path,
        )
        return minted
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(minted + "\n")
    return minted


def _read_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except OSError as exc:
        raise RuntimeConfigError(f"cannot read relay config {path}") from exc
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None) or getattr(exc, "context_mark", None)
        location = ""
        if mark is not None:
            location = f" at line {mark.line + 1}, column {mark.column + 1}"
        raise RuntimeConfigError(f"cannot parse relay config {path}{location}") from exc
    if not isinstance(loaded, dict):
        raise RuntimeConfigError(f"relay config {path} must contain a YAML mapping")
    return loaded


def _unknown_key_error(scope: str, key: object) -> RuntimeConfigError:
    if isinstance(key, str):
        return RuntimeConfigError(f"unknown {scope} key {key!r}")
    return RuntimeConfigError(f"unknown {scope} key")


def _validate_top_level_keys(file_cfg: Mapping[str, Any]) -> None:
    for key in file_cfg:
        if key not in _TOP_LEVEL_YAML_KEYS:
            raise _unknown_key_error("top-level", key)


def _validate_object_store_keys(raw: Mapping[str, Any]) -> None:
    for key in raw:
        if key not in _OBJECT_STORE_YAML_KEYS:
            raise _unknown_key_error("object_store", key)


def _clean(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _select(
    name: str,
    *,
    explicit: str | None,
    environ: Mapping[str, str],
    file_cfg: Mapping[str, Any],
    default: str,
) -> str:
    if explicit is not None:
        return explicit.strip()
    env_name = _RELAY_ENV[name]
    if env_name in environ:
        return environ[env_name].strip()
    if name in file_cfg:
        return _clean(file_cfg[name])
    return default


def is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _validate_url(
    name: str,
    value: str,
    *,
    secure_scheme: str,
    loopback_scheme: str,
    required_path: str | None = None,
    exact_origin: bool = False,
) -> str:
    try:
        parsed = urlparse(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise RuntimeConfigError(
            f"{name} must be an absolute URL with a valid host and port"
        ) from exc
    if parsed.username or parsed.password:
        raise RuntimeConfigError(f"{name} must not contain user information")
    if not host:
        raise RuntimeConfigError(f"{name} must be an absolute URL")
    loopback = is_loopback_host(host)
    allowed = parsed.scheme == secure_scheme or (loopback and parsed.scheme == loopback_scheme)
    if not allowed:
        raise RuntimeConfigError(
            f"{name} must use {secure_scheme} (or {loopback_scheme} on loopback)"
        )
    if parsed.query or parsed.fragment:
        raise RuntimeConfigError(f"{name} must not contain a query or fragment")
    if exact_origin and parsed.path not in {"", "/"}:
        raise RuntimeConfigError(f"{name} must be an origin without a path")
    if required_path is not None and parsed.path.rstrip("/") != required_path.rstrip("/"):
        raise RuntimeConfigError(f"{name} path must be {required_path}")
    if exact_origin:
        normalized_host = f"[{host.lower()}]" if ":" in host else host.lower()
        normalized_port = f":{port}" if port is not None else ""
        return f"{parsed.scheme.lower()}://{normalized_host}{normalized_port}"
    return value.rstrip("/") if required_path is None else value


def validate_relay_config(config: RelayConfig) -> RelayConfig:
    relay_url = _validate_url(
        "relay_url",
        config.relay_url,
        secure_scheme="wss",
        loopback_scheme="ws",
        required_path="/tunnel",
    )
    public_base_url = _validate_url(
        "public_base_url",
        config.public_base_url,
        secure_scheme="https",
        loopback_scheme="http",
        exact_origin=True,
    )
    local_gui_url = _validate_url(
        "local_gui_url",
        config.local_gui_url,
        secure_scheme="https",
        loopback_scheme="http",
    )
    local_host = urlparse(local_gui_url).hostname
    if not is_loopback_host(local_host):
        raise RuntimeConfigError("local_gui_url must use a loopback host")
    if not _HOST_ID_RE.match(config.host_id):
        raise RuntimeConfigError(
            "host_id must be 1-128 characters of letters, digits, '.', '_' or '-'"
        )
    return RelayConfig(
        relay_url=relay_url,
        host_token=config.host_token,
        public_base_url=public_base_url,
        local_gui_url=local_gui_url,
        host_id=config.host_id,
    )


def _object_store_value(
    name: str,
    raw: Mapping[str, Any],
    environ: Mapping[str, str],
) -> str:
    env_name = _OBJECT_STORE_ENV[name]
    if env_name in environ:
        return environ[env_name].strip()
    return _clean(raw.get(name))


def _load_object_store(
    file_cfg: Mapping[str, Any],
    environ: Mapping[str, str],
) -> ObjectStoreConfig | None:
    raw = file_cfg.get("object_store")
    if raw is not None and not isinstance(raw, dict):
        raise RuntimeConfigError("object_store must be a YAML mapping")
    raw = raw or {}
    _validate_object_store_keys(raw)
    values = {name: _object_store_value(name, raw, environ) for name in _OBJECT_STORE_ENV}
    if not any(values.values()):
        return None
    required = ("endpoint_url", "region", "bucket", "access_key_id", "secret_access_key")
    missing = [name for name in required if not values[name]]
    if missing:
        raise RuntimeConfigError(
            "object_store is incomplete; missing " + ", ".join(sorted(missing))
        )
    endpoint = _validate_url(
        "object_store.endpoint_url",
        values["endpoint_url"],
        secure_scheme="https",
        loopback_scheme="http",
    )
    cdn = values["cdn_endpoint"]
    if cdn:
        cdn = _validate_url(
            "object_store.cdn_endpoint",
            cdn,
            secure_scheme="https",
            loopback_scheme="http",
        )
    return ObjectStoreConfig(
        endpoint_url=endpoint,
        region=values["region"],
        bucket=values["bucket"],
        access_key_id=values["access_key_id"],
        secret_access_key=values["secret_access_key"],
        cdn_endpoint=cdn or None,
    )


def _load_relay_config(
    file_cfg: Mapping[str, Any],
    *,
    config_path: Path,
    relay_url: str | None,
    host_token: str | None,
    public_base_url: str | None,
    local_gui_url: str | None,
    environ: Mapping[str, str],
) -> RelayConfig:
    return validate_relay_config(
        RelayConfig(
            relay_url=_select(
                "relay_url",
                explicit=relay_url,
                environ=environ,
                file_cfg=file_cfg,
                default=DEFAULT_RELAY_URL,
            ),
            host_token=_select(
                "host_token",
                explicit=host_token,
                environ=environ,
                file_cfg=file_cfg,
                default="",
            ),
            public_base_url=_select(
                "public_base_url",
                explicit=public_base_url,
                environ=environ,
                file_cfg=file_cfg,
                default=DEFAULT_PUBLIC_BASE_URL,
            ),
            local_gui_url=_select(
                "local_gui_url",
                explicit=local_gui_url,
                environ=environ,
                file_cfg=file_cfg,
                default=DEFAULT_LOCAL_GUI_URL,
            ),
            host_id=_select(
                "host_id",
                explicit=None,
                environ=environ,
                file_cfg=file_cfg,
                default="",
            )
            or persisted_relay_host_id(config_path),
        )
    )


def load_relay_config(
    config_path: Path | None = None,
    *,
    relay_url: str | None = None,
    host_token: str | None = None,
    public_base_url: str | None = None,
    local_gui_url: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> RelayConfig:
    """Load relay settings without requiring optional object-store settings to validate."""
    env = os.environ if environ is None else environ
    path = config_path or default_relay_config_path()
    file_cfg = _read_mapping(path)
    _validate_top_level_keys(file_cfg)
    return _load_relay_config(
        file_cfg,
        config_path=path,
        relay_url=relay_url,
        host_token=host_token,
        public_base_url=public_base_url,
        local_gui_url=local_gui_url,
        environ=env,
    )


def load_host_runtime_config(
    config_path: Path | None = None,
    *,
    relay_url: str | None = None,
    host_token: str | None = None,
    public_base_url: str | None = None,
    local_gui_url: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> HostRuntimeConfig:
    """Load host config with explicit relay overrides, then env, YAML, and defaults."""
    env = os.environ if environ is None else environ
    path = config_path or default_relay_config_path()
    file_cfg = _read_mapping(path)
    _validate_top_level_keys(file_cfg)
    relay = _load_relay_config(
        file_cfg,
        config_path=path,
        relay_url=relay_url,
        host_token=host_token,
        public_base_url=public_base_url,
        local_gui_url=local_gui_url,
        environ=env,
    )
    object_store = _load_object_store(file_cfg, env)
    return HostRuntimeConfig(relay=relay, object_store=object_store)


def load_object_store_config(
    config_path: Path | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> ObjectStoreConfig | None:
    """Load optional object-store settings without validating relay settings."""
    env = os.environ if environ is None else environ
    path = config_path or default_relay_config_path()
    file_cfg = _read_mapping(path)
    _validate_top_level_keys(file_cfg)
    return _load_object_store(file_cfg, env)
