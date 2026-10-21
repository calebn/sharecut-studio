"""podcast relay - check and set up the object-store bucket that online sharing uses."""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import urlparse

import typer

from podcast_mcp.config.runtime import (
    ObjectStoreConfig,
    RuntimeConfigError,
    is_loopback_host,
    load_object_store_config,
    load_relay_config,
    normalize_exact_origin,
)
from podcast_mcp.services.media import (
    AdminCredentials,
    BucketSetupError,
    admin_config_path,
    check_bucket_cors,
    cors_blocked_message,
    guest_check,
    load_admin_credentials,
    make_admin_client,
    setup_bucket_cors,
)

relay_app = typer.Typer(help="Check and set up the object-store bucket used for online sharing.")

_CONFIG = typer.Option(
    None,
    "--config",
    help="Relay config YAML path (default: ~/.config/podcast_mcp/relay.yaml).",
)
_ORIGIN = typer.Option(
    None,
    "--origin",
    help="Public share origin guests load the page from (default: public_base_url).",
)
_ADMIN_CONFIG = typer.Option(
    None,
    "--admin-config",
    help="Admin key YAML, used instead of the environment "
    "(default: the environment, then relay-admin.yaml next to relay.yaml, mode 0600).",
)


def _fail(message: str, code: int = 1) -> typer.Exit:
    typer.echo(message, err=True)
    return typer.Exit(code)


def _bucket_and_origin(config: Path | None, origin: str | None) -> tuple[ObjectStoreConfig, str]:
    try:
        store = load_object_store_config(config)
        relay = load_relay_config(config)
    except RuntimeConfigError as exc:
        raise _fail(f"Invalid relay configuration: {exc}", 2) from exc
    if store is None:
        raise _fail(
            "No object store is configured. Put an object_store section in relay.yaml "
            "(docs/host-online-relay.md, Object-store bucket setup).",
            2,
        )
    try:
        share_origin = normalize_exact_origin("origin", origin or relay.public_base_url)
    except RuntimeConfigError as exc:
        raise _fail(f"Invalid origin: {exc}", 2) from exc
    if origin is None and is_loopback_host(urlparse(share_origin).hostname):
        raise _fail(
            f"public_base_url is {share_origin} (loopback), not a public share origin. Set "
            "public_base_url in relay.yaml or pass --origin https://your.share.domain.",
            2,
        )
    return store, share_origin


def _interactive() -> bool:
    return sys.stdin.isatty()


def _admin_credentials(
    config: Path | None, admin_config: Path | None, *, prompt: bool
) -> AdminCredentials | None:
    try:
        creds = load_admin_credentials(path=admin_config, relay_config_path=config)
    except BucketSetupError as exc:
        raise _fail(str(exc), 2) from exc
    if creds is not None or not prompt or not _interactive():
        return creds
    typer.echo(
        "No admin key found. The upload key in relay.yaml cannot set bucket CORS; paste an "
        "admin key (it is used for this call only and not saved).",
        err=True,
    )
    key_id = typer.prompt("Admin access key id").strip()
    secret = typer.prompt("Admin secret access key", hide_input=True).strip()
    return AdminCredentials(key_id, secret) if key_id and secret else None


@relay_app.command("bucket-check")
def bucket_check_cmd(
    config: Path | None = _CONFIG,
    origin: str | None = _ORIGIN,
    admin_config: Path | None = _ADMIN_CONFIG,
) -> None:
    """Report whether the bucket lets guests on the public origin read media.

    With an admin key (environment or relay-admin.yaml) this reads the bucket's CORS rules.
    Without one it asks the bucket the way a guest's browser does, using the upload key.
    """
    store, share_origin = _bucket_and_origin(config, origin)
    creds = _admin_credentials(config, admin_config, prompt=False)
    try:
        if creds is not None:
            ok = check_bucket_cors(make_admin_client(store, creds), store.bucket, share_origin)
            how = "bucket CORS rules"
            detail = ""
        else:
            probe = guest_check(store, share_origin)
            if probe.status == "unknown":
                raise _fail(f"Could not reach bucket {store.bucket}: {probe.detail}.")
            ok = probe.status == "ok"
            how = "a guest's request, origin only; use an admin key to check the whole rule"
            detail = probe.detail
    except BucketSetupError as exc:
        raise _fail(str(exc)) from exc
    if ok:
        typer.echo(f"Bucket {store.bucket} allows {share_origin} ({how}).")
        return
    suffix = f" ({detail})" if detail else ""
    typer.echo(
        f"Bucket {store.bucket} does not allow {share_origin}{suffix}.\n"
        "Fix it with: podcast relay bucket-setup\n\n" + cors_blocked_message(share_origin),
        err=True,
    )
    raise typer.Exit(1)


@relay_app.command("bucket-setup")
def bucket_setup_cmd(
    config: Path | None = _CONFIG,
    origin: str | None = _ORIGIN,
    admin_config: Path | None = _ADMIN_CONFIG,
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Show what would change; do not write to the bucket."
    ),
) -> None:
    """Add the CORS rule guests need to the bucket. Safe to run again.

    A bucket that already allows the public origin is left as it is, and any other rule on the
    bucket is kept. Uses an admin key: PODCAST_OBJECT_STORE_ADMIN_ACCESS_KEY_ID and
    PODCAST_OBJECT_STORE_ADMIN_SECRET_ACCESS_KEY, or relay-admin.yaml next to relay.yaml
    (mode 0600), or a prompt when run in a terminal.
    """
    store, share_origin = _bucket_and_origin(config, origin)
    creds = _admin_credentials(config, admin_config, prompt=True)
    if creds is None:
        raise _fail(
            "No admin key. Set PODCAST_OBJECT_STORE_ADMIN_ACCESS_KEY_ID and "
            "PODCAST_OBJECT_STORE_ADMIN_SECRET_ACCESS_KEY, or create "
            f"{admin_config or admin_config_path(config)} (mode 0600) with access_key_id and "
            "secret_access_key. See docs/host-online-relay.md, Object-store bucket setup.",
            2,
        )
    try:
        result = setup_bucket_cors(
            make_admin_client(store, creds), store.bucket, share_origin, dry_run=dry_run
        )
    except BucketSetupError as exc:
        raise _fail(str(exc)) from exc
    others = f"{result.kept} other rule{'s' if result.kept != 1 else ''} kept"
    if result.state == "already_set":
        typer.echo(f"Bucket {result.bucket} already allows {result.origin}. Nothing changed.")
        if result.missing_expose:
            typer.echo(
                "Its rule does not expose "
                + ", ".join(result.missing_expose)
                + ", which the guest player reads for ranged media; it was left as is.",
                err=True,
            )
    elif result.state == "would_add":
        typer.echo(
            f"Would add a CORS rule for {result.origin} to bucket {result.bucket} ({others})."
        )
    else:
        typer.echo(
            f"Added a CORS rule for {result.origin} to bucket {result.bucket} ({others}). "
            "Verified by reading it back."
        )
