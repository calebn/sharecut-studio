"""Caddy relay templates expose only relay endpoints."""

import fnmatch
import os
import subprocess
from pathlib import Path

import yaml
from fastapi.testclient import TestClient
from tests.relay_caddy_logs import ROOT
from tests.relay_enroll import enable_enrollment

from podcast_mcp.util.relay_protocol.enroll import ENROLL_PATH, RENEW_PATH
from podcast_relay.app import create_relay_app
from podcast_relay.notice import CONTINUE_PATH


def test_caddyfiles_allowlist_relay_prefixes() -> None:
    prod = (ROOT / "deploy/relay/Caddyfile.prod").read_text(encoding="utf-8")
    local = (ROOT / "deploy/relay/Caddyfile.local").read_text(encoding="utf-8")
    assert "/rec/*" in prod
    assert "/api/rec/" in prod
    assert "/rec/" in local
    assert "/api/rec/" in local


def test_every_enrollment_path_the_relay_serves_matches_a_caddy_relay_pattern(
    monkeypatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    client = TestClient(create_relay_app())
    served = sorted({ENROLL_PATH, RENEW_PATH, CONTINUE_PATH})
    assert client.get(ENROLL_PATH).status_code == 200
    assert client.post(RENEW_PATH, json={}).status_code != 404
    assert client.post(CONTINUE_PATH).status_code != 404
    for filename in ("Caddyfile.prod", "Caddyfile.local"):
        config = (ROOT / "deploy/relay" / filename).read_text(encoding="utf-8")
        matcher = next(line for line in config.splitlines() if "@relay path" in line)
        patterns = matcher.split("path", 1)[1].split()
        for path in served:
            assert any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns), (
                f"{filename} does not route {path}"
            )


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
    assert "dev-host-token" in compose
    assert "at least 32 characters" in compose
    assert "each PODCAST_RELAY_HOST_TOKENS secret must be at least 32 characters" in compose
    assert "file_server" not in compose
    assert "/var/www" not in compose


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


def test_production_compose_wires_enrollment_and_keeps_legacy_tokens() -> None:
    relay = yaml.safe_load(
        (ROOT / "deploy/relay/docker-compose.prod.yml").read_text(encoding="utf-8")
    )["services"]["podcast-relay"]
    env = relay["environment"]
    for name in (
        "PODCAST_RELAY_SIGNING_KEY",
        "PODCAST_RELAY_MASTER_KEY",
        "PODCAST_RELAY_DENY_FILE",
        "PODCAST_RELAY_USAGE_DB",
    ):
        assert name in env
    assert env["PODCAST_RELAY_HOST_TOKENS"].startswith("${PODCAST_RELAY_HOST_TOKENS:?")
    assert env["PODCAST_RELAY_DENY_FILE"].startswith("${PODCAST_RELAY_DENY_FILE:-/var/lib/")
    assert env["PODCAST_RELAY_USAGE_DB"].startswith("${PODCAST_RELAY_USAGE_DB:-/var/lib/")
    volumes = relay["volumes"]
    assert any(v.startswith("relay_state:/var/lib/sharecut-relay") for v in volumes)
    assert any(v.endswith(":/run/relay-keys:ro") for v in volumes)
