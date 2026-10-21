"""Set and check the object-store bucket's CORS rule from the terminal (#1760).

The upload key in ``relay.yaml`` reads and writes objects only, so it cannot read or set bucket
CORS. ``podcast relay bucket-setup`` uses a separate admin credential for that one call: from the
environment, from ``relay-admin.yaml`` next to ``relay.yaml`` (mode 0600), or typed at a prompt.
The admin credential never reaches the runtime upload config.

Setting the rule is idempotent and only ever adds: a bucket that already allows the relay origin
is left untouched, and any other rule on the bucket is kept as it is.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any, Literal

from podcast_mcp import settings
from podcast_mcp.config.runtime import ObjectStoreConfig, default_relay_config_path
from podcast_mcp.services.media.object_store_cors import (
    CorsProbe,
    Fetcher,
    cors_rule,
    probe_guest_cors,
)

ADMIN_ID_ENV = "PODCAST_OBJECT_STORE_ADMIN_ACCESS_KEY_ID"
ADMIN_SECRET_ENV = "PODCAST_OBJECT_STORE_ADMIN_SECRET_ACCESS_KEY"
ADMIN_FILENAME = "relay-admin.yaml"
_ADMIN_YAML_KEYS = frozenset({"access_key_id", "secret_access_key"})

_NEEDED_METHODS = frozenset({"GET", "HEAD"})
_NEEDED_EXPOSE = frozenset({"content-range", "content-length", "accept-ranges"})
_PROBE_KEY = "review/.cors-probe"


class BucketSetupError(RuntimeError):
    """The bucket could not be read or changed; the message says what to do next."""


@dataclass(frozen=True)
class AdminCredentials:
    """An object-store key that may read and set bucket CORS (not the upload key)."""

    access_key_id: str
    secret_access_key: str = field(repr=False)


@dataclass(frozen=True)
class CorsPlan:
    """What ``bucket-setup`` would write: the full rule list, and whether it differs."""

    rules: list[dict[str, Any]]
    kept: int
    changed: bool


@dataclass(frozen=True)
class BucketCorsResult:
    bucket: str
    origin: str
    state: Literal["already_set", "added", "would_add"]
    kept: int
    missing_expose: list[str] = field(default_factory=list)


def admin_config_path(relay_config_path: Path | None = None) -> Path:
    """``relay-admin.yaml`` lives next to ``relay.yaml`` and is never read by the GUI."""
    return (relay_config_path or default_relay_config_path()).with_name(ADMIN_FILENAME)


def load_admin_credentials(
    *,
    environ: Mapping[str, str] | None = None,
    path: Path | None = None,
    relay_config_path: Path | None = None,
) -> AdminCredentials | None:
    """Admin credentials from the environment, else ``relay-admin.yaml``; ``None`` if neither."""
    if path is not None:  # an explicit file beats the environment
        if not path.is_file():
            raise BucketSetupError(f"{path} does not exist")
        return _read_admin_file(path)
    env = settings.environ() if environ is None else environ
    key_id = env.get(ADMIN_ID_ENV, "").strip()
    secret = env.get(ADMIN_SECRET_ENV, "").strip()
    if key_id or secret:
        if not (key_id and secret):
            raise BucketSetupError(f"Set both {ADMIN_ID_ENV} and {ADMIN_SECRET_ENV}, or neither.")
        return AdminCredentials(key_id, secret)
    file_path = admin_config_path(relay_config_path)
    if not file_path.is_file():
        return None
    return _read_admin_file(file_path)


def _read_admin_file(path: Path) -> AdminCredentials:
    if os.name == "posix" and path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise BucketSetupError(f"{path} is readable by other users. Run: chmod 600 {path}")
    import yaml

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise BucketSetupError(f"Could not read {path}: {type(exc).__name__}") from exc
    if not isinstance(raw, dict):
        raise BucketSetupError(f"{path} must be a YAML mapping")
    for key in raw:
        if key not in _ADMIN_YAML_KEYS:
            raise BucketSetupError(f"{path}: unknown key {key!r}")
    key_id = str(raw.get("access_key_id") or "").strip()
    secret = str(raw.get("secret_access_key") or "").strip()
    if not (key_id and secret):
        raise BucketSetupError(f"{path} needs access_key_id and secret_access_key")
    return AdminCredentials(key_id, secret)


def _origin_allowed(rule: Mapping[str, Any], origin: str) -> bool:
    for allowed in rule.get("AllowedOrigins") or []:
        if allowed == origin or (("*" in allowed) and fnmatchcase(origin, allowed)):
            return True
    return False


def rule_covers(rule: Mapping[str, Any], origin: str) -> bool:
    """Whether one bucket rule already lets guests on ``origin`` read ranged media."""
    if not _origin_allowed(rule, origin):
        return False
    methods = {str(m).upper() for m in rule.get("AllowedMethods") or []}
    headers = {str(h).lower() for h in rule.get("AllowedHeaders") or []}
    return methods >= _NEEDED_METHODS and bool(headers & {"range", "*"})


def cors_covers(rules: list[dict[str, Any]] | None, origin: str) -> bool:
    """Whether any rule lets ``origin`` GET and HEAD with a ``Range`` header.

    S3 takes the first rule that matches origin, method and headers together.
    """
    return any(rule_covers(rule, origin) for rule in rules or [])


def missing_expose_headers(rules: list[dict[str, Any]] | None, origin: str) -> list[str]:
    """Range headers the covering rule does not expose; reported, never rewritten."""
    for rule in rules or []:
        if rule_covers(rule, origin):
            have = {str(h).lower() for h in rule.get("ExposeHeaders") or []}
            return sorted(_NEEDED_EXPOSE - have)
    return []


def plan_cors(existing: list[dict[str, Any]] | None, origin: str) -> CorsPlan:
    """Keep every existing rule; put ours first only if no rule serves ``origin`` yet."""
    current = list(existing or [])
    if cors_covers(current, origin):
        return CorsPlan(current, len(current), False)
    return CorsPlan([*cors_rule(origin), *current], len(current), True)


def _error_code(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return str((response.get("Error") or {}).get("Code") or "")
    return ""


def _denied(bucket: str, action: str, exc: Exception) -> BucketSetupError:
    return BucketSetupError(
        f"The key was refused {action} on bucket {bucket}. The upload key in relay.yaml cannot "
        f"do this; use an admin key ({ADMIN_FILENAME} or {ADMIN_ID_ENV}). "
        f"See docs/host-online-relay.md, Object-store bucket setup. ({_error_code(exc)})"
    )


def read_bucket_cors(client: Any, bucket: str) -> list[dict[str, Any]] | None:
    """The bucket's CORS rules, or ``None`` when it has none."""
    try:
        return list(client.get_bucket_cors(Bucket=bucket).get("CORSRules") or [])
    except Exception as exc:
        code = _error_code(exc)
        if code in {"NoSuchCORSConfiguration", "NoSuchCORS"}:
            return None
        if code in {"AccessDenied", "403", "Forbidden"}:
            raise _denied(bucket, "reading CORS", exc) from exc
        raise BucketSetupError(f"Could not read CORS on bucket {bucket}: {exc}") from exc


def make_admin_client(cfg: ObjectStoreConfig, creds: AdminCredentials) -> Any:
    try:
        import boto3  # type: ignore[import-untyped]
        from botocore.client import Config  # type: ignore[import-untyped]
    except ImportError as exc:
        raise BucketSetupError(
            "boto3 is required; install with: pip install 'podcast-mcp[object-store]'"
        ) from exc
    return boto3.client(
        "s3",
        endpoint_url=cfg.endpoint_url,
        region_name=cfg.region,
        aws_access_key_id=creds.access_key_id,
        aws_secret_access_key=creds.secret_access_key,
        config=Config(signature_version="s3v4"),
    )


def setup_bucket_cors(
    client: Any, bucket: str, origin: str, *, dry_run: bool = False
) -> BucketCorsResult:
    """Make the bucket allow ``origin``; change nothing if it already does."""
    plan = plan_cors(read_bucket_cors(client, bucket), origin)
    if not plan.changed:
        return BucketCorsResult(
            bucket, origin, "already_set", plan.kept, missing_expose_headers(plan.rules, origin)
        )
    if dry_run:
        return BucketCorsResult(bucket, origin, "would_add", plan.kept)
    try:
        client.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRules": plan.rules})
    except Exception as exc:
        if _error_code(exc) in {"AccessDenied", "403", "Forbidden"}:
            raise _denied(bucket, "setting CORS", exc) from exc
        raise BucketSetupError(f"Could not set CORS on bucket {bucket}: {exc}") from exc
    if not cors_covers(read_bucket_cors(client, bucket), origin):
        raise BucketSetupError(
            f"Set CORS on bucket {bucket}, but reading it back does not show a rule for {origin}."
        )
    return BucketCorsResult(bucket, origin, "added", plan.kept)


def check_bucket_cors(client: Any, bucket: str, origin: str) -> bool:
    """Authoritative check with an admin key: does the bucket's own rule serve ``origin``?"""
    return cors_covers(read_bucket_cors(client, bucket), origin)


def guest_check(
    cfg: ObjectStoreConfig,
    origin: str,
    *,
    presign: Any = None,
    fetch: Fetcher | None = None,
) -> CorsProbe:
    """Check with the upload key alone: ask the store the way a guest's browser does."""
    if presign is None:
        from podcast_mcp.util.object_store import ObjectStoreClient

        try:
            presign = ObjectStoreClient(cfg).presigned_get_url
        except RuntimeError as exc:
            raise BucketSetupError(str(exc)) from exc
    return probe_guest_cors(presign(_PROBE_KEY, expires_in=60), origin, fetch=fetch)


__all__ = [
    "ADMIN_FILENAME",
    "ADMIN_ID_ENV",
    "ADMIN_SECRET_ENV",
    "AdminCredentials",
    "BucketCorsResult",
    "BucketSetupError",
    "CorsPlan",
    "admin_config_path",
    "check_bucket_cors",
    "cors_covers",
    "guest_check",
    "load_admin_credentials",
    "make_admin_client",
    "missing_expose_headers",
    "plan_cors",
    "read_bucket_cors",
    "rule_covers",
    "setup_bucket_cors",
]
