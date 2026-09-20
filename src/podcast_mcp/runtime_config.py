"""Validated host runtime configuration for self-hosted collaboration.

Runtime settings belong to the machine running Sharecut.  They are deliberately
separate from the build-time desktop distribution profile.
"""

from __future__ import annotations

import ipaddress
import os
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
    host_id: str = field(default_factory=lambda: uuid.uuid4().hex)


@dataclass(frozen=True)
class HostRuntimeConfig:
    relay: RelayConfig
    object_store: ObjectStoreConfig | None = None


_RELAY_ENV = {
    "relay_url": "PODCAST_RELAY_URL",
    "host_token": "PODCAST_RELAY_HOST_TOKEN",
    "public_base_url": "PODCAST_RELAY_PUBLIC_BASE_URL",
    "local_gui_url": "PODCAST_RELAY_LOCAL_GUI_URL",
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
