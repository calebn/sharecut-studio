"""Provider-neutral S3-compatible object-store client."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TypeAlias

from podcast_mcp.runtime_config import ObjectStoreConfig, load_object_store_config


class ObjectStoreClient:
    """Thin S3-compatible boto3 wrapper for upload, presign, and delete."""

    def __init__(self, cfg: ObjectStoreConfig) -> None:
        self._cfg = cfg
        try:
            import boto3  # type: ignore[import-untyped]
            from botocore.client import Config  # type: ignore[import-untyped]
        except ImportError as exc:
            raise RuntimeError(
                "boto3 is required for object-store media; "
                "install with: pip install 'podcast-mcp[object-store]'"
            ) from exc
        self._client = boto3.client(
            "s3",
            endpoint_url=cfg.endpoint_url,
            region_name=cfg.region,
            aws_access_key_id=cfg.access_key_id,
            aws_secret_access_key=cfg.secret_access_key,
            config=Config(signature_version="s3v4"),
        )

    @property
    def bucket(self) -> str:
        return self._cfg.bucket

    def object_exists(self, object_key: str) -> bool:
        """Return True if ``object_key`` is already in the bucket."""
        try:
            self._client.head_object(Bucket=self._cfg.bucket, Key=object_key)
        except Exception as exc:
            if _is_missing_key_error(exc):
                return False
            raise
        return True

    def upload_file(
        self,
        local_path: Path,
        object_key: str,
        *,
        content_type: str = "audio/mpeg",
        acl: str = "private",
    ) -> None:
        extra = {"ContentType": content_type, "ACL": acl}
        self._client.upload_file(
            str(local_path),
            self._cfg.bucket,
            object_key,
            ExtraArgs=extra,
        )

    def presigned_get_url(self, object_key: str, *, expires_in: int) -> str:
        url = self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._cfg.bucket, "Key": object_key},
            ExpiresIn=max(1, int(expires_in)),
        )
        if self._cfg.cdn_endpoint and isinstance(url, str):
            from urllib.parse import urlparse, urlunparse

            parsed = urlparse(url)
            cdn = urlparse(self._cfg.cdn_endpoint)
            url = urlunparse(
                (
                    cdn.scheme or parsed.scheme,
                    cdn.netloc or parsed.netloc,
                    parsed.path,
                    "",
                    parsed.query,
                    "",
                )
            )
        return str(url)

    def delete_object(self, object_key: str) -> None:
        self._client.delete_object(Bucket=self._cfg.bucket, Key=object_key)


def _is_missing_key_error(exc: BaseException) -> bool:
    """True for S3-compatible ``head_object`` 404 / NoSuchKey responses."""
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return False
    err = response.get("Error") or {}
    code = str(err.get("Code") or "") if isinstance(err, dict) else ""
    metadata = response.get("ResponseMetadata") or {}
    status = metadata.get("HTTPStatusCode") if isinstance(metadata, dict) else None
    return code in {"404", "NoSuchKey", "NotFound"} or status == 404


ObjectStoreClientInput: TypeAlias = ObjectStoreConfig | ObjectStoreClient | None


def resolve_object_store_client(
    value: ObjectStoreClientInput,
    *,
    config_loader: Callable[[], ObjectStoreConfig | None] = load_object_store_config,
    client_factory: Callable[[ObjectStoreConfig], ObjectStoreClient] = ObjectStoreClient,
) -> ObjectStoreClient | None:
    """Return an existing client, construct one from config, or disable object storage."""
    if value is None:
        config = config_loader()
        return client_factory(config) if config is not None else None
    if isinstance(value, ObjectStoreConfig):
        return client_factory(value)
    return value


__all__ = [
    "ObjectStoreClient",
    "ObjectStoreClientInput",
    "ObjectStoreConfig",
    "load_object_store_config",
    "resolve_object_store_client",
]
