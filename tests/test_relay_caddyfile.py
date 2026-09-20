"""Caddy relay templates expose only relay endpoints."""

import os
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_caddyfiles_allowlist_relay_prefixes() -> None:
    prod = (ROOT / "deploy/relay/Caddyfile.prod").read_text(encoding="utf-8")
    local = (ROOT / "deploy/relay/Caddyfile.local").read_text(encoding="utf-8")
    assert "/rec/*" in prod
    assert "/api/rec/" in prod
    assert "/rec/" in local
    assert "/api/rec/" in local


def test_caddyfile_prod_has_no_static_site_or_owner_hosts() -> None:
    prod = (ROOT / "deploy/relay/Caddyfile.prod").read_text(encoding="utf-8")
    assert "{$RELAY_DOMAIN}" in prod
    assert "file_server" not in prod
    assert "/var/www" not in prod
    assert "sharecut" not in prod.lower()
    assert "sudo" not in prod.lower()


def test_local_compose_is_a_relay_only_development_stack() -> None:
    compose = (ROOT / "deploy/relay/docker-compose.yml").read_text(encoding="utf-8")
    assert "Caddyfile.local" in compose
    assert "/var/www" not in compose
    assert "PODCAST_RELAY_ALLOW_OPEN_TUNNEL" in compose


def test_production_compose_requires_operator_configuration() -> None:
    compose = (ROOT / "deploy/relay/docker-compose.prod.yml").read_text(encoding="utf-8")
    build_compose = (ROOT / "deploy/relay/docker-compose.build.yml").read_text(encoding="utf-8")
    assert "${RELAY_DOMAIN:?set RELAY_DOMAIN}" in compose
    assert "${RELAY_IMAGE:?set RELAY_IMAGE}" in compose
    assert "${PODCAST_RELAY_HOST_TOKENS:?set PODCAST_RELAY_HOST_TOKENS}" in compose
    assert "dev-host-token" in compose
    assert "at least 32 characters" in compose
    assert "each PODCAST_RELAY_HOST_TOKENS secret must be at least 32 characters" in compose
    assert "file_server" not in compose
    assert "/var/www" not in compose
    assert "${RELAY_IMAGE:?set RELAY_IMAGE}" in build_compose


def _run_production_secret_guard(tokens: str) -> subprocess.CompletedProcess[str]:
    """Run only Compose's shell guard; never start or import the relay application."""
    compose = yaml.safe_load(
        (ROOT / "deploy/relay/docker-compose.prod.yml").read_text(encoding="utf-8")
    )
    command = compose["services"]["podcast-relay"]["command"][0]
    command = command.replace("$$", "$").replace(
        "exec python -m podcast_relay.app", "printf 'guard-passed\\n'"
    )
    return subprocess.run(
        ["sh", "-ec", command],
        check=False,
        capture_output=True,
        env={**os.environ, "PODCAST_RELAY_HOST_TOKENS": tokens},
        text=True,
    )


def test_production_secret_guard_validates_each_effective_secret() -> None:
    valid = "a" * 32
    bound = "host-a:" + "b" * 32
    assert _run_production_secret_guard(f"{valid},{bound}").returncode == 0

    for tokens in (
        "short," + valid,
        "host-a:short," + valid,
        "host-a:          short          ," + valid,
    ):
        result = _run_production_secret_guard(tokens)
        assert result.returncode != 0
        assert "each PODCAST_RELAY_HOST_TOKENS secret" in result.stderr
