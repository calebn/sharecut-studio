from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.runtime_config import (
    RelayConfig,
    RuntimeConfigError,
    default_relay_config_path,
    load_host_runtime_config,
    load_object_store_config,
    load_relay_config,
    persisted_relay_host_id,
    relay_host_id_path,
)


def test_runtime_precedence_explicit_env_yaml_default(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(
        "relay_url: wss://yaml.example.test/tunnel\n"
        "host_token: yaml-token\n"
        "public_base_url: https://yaml.example.test\n",
        encoding="utf-8",
    )
    env = {
        "PODCAST_RELAY_URL": "wss://env.example.test/tunnel",
        "PODCAST_RELAY_HOST_TOKEN": "env-token",
    }
    config = load_host_runtime_config(
        path,
        relay_url="wss://explicit.example.test/tunnel",
        environ=env,
    )
    assert config.relay.relay_url == "wss://explicit.example.test/tunnel"
    assert config.relay.host_token == "env-token"
    assert config.relay.public_base_url == "https://yaml.example.test"
    assert config.relay.local_gui_url == "http://127.0.0.1:8765"


def test_runtime_env_can_clear_yaml_token(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text("host_token: yaml-token\n", encoding="utf-8")
    config = load_host_runtime_config(path, environ={"PODCAST_RELAY_HOST_TOKEN": ""})
    assert config.relay.host_token == ""


def test_runtime_rejects_insecure_remote_and_bad_tunnel_path(tmp_path: Path) -> None:
    insecure = tmp_path / "insecure.yaml"
    insecure.write_text("relay_url: ws://relay.example.test/tunnel\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="must use wss"):
        load_host_runtime_config(insecure, environ={})
    bad_path = tmp_path / "bad-path.yaml"
    bad_path.write_text("relay_url: wss://relay.example.test/not-tunnel\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="path must be /tunnel"):
        load_host_runtime_config(bad_path, environ={})


def test_object_store_is_optional_and_provider_neutral(tmp_path: Path) -> None:
    empty = load_host_runtime_config(tmp_path / "missing.yaml", environ={})
    assert empty.object_store is None
    path = tmp_path / "relay.yaml"
    path.write_text(
        "object_store:\n"
        "  endpoint_url: https://s3.example.test\n"
        "  region: region-1\n"
        "  bucket: media\n"
        "  access_key_id: key\n"
        "  secret_access_key: secret\n",
        encoding="utf-8",
    )
    loaded = load_host_runtime_config(path, environ={})
    assert loaded.object_store is not None
    assert loaded.object_store.bucket == "media"


def test_object_store_env_overrides_yaml_per_field(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(
        "object_store:\n"
        "  endpoint_url: https://s3.example.test\n"
        "  region: old-region\n"
        "  bucket: media\n"
        "  access_key_id: key\n"
        "  secret_access_key: secret\n",
        encoding="utf-8",
    )
    loaded = load_host_runtime_config(
        path,
        environ={"PODCAST_OBJECT_STORE_REGION": "new-region"},
    )
    assert loaded.object_store is not None
    assert loaded.object_store.region == "new-region"


def test_runtime_errors_never_echo_secret_values(tmp_path: Path) -> None:
    secret = "must-not-appear"
    path = tmp_path / "relay.yaml"
    path.write_text(
        f"object_store:\n  secret_access_key: {secret}\n",
        encoding="utf-8",
    )
    with pytest.raises(RuntimeConfigError) as caught:
        load_host_runtime_config(path, environ={})
    assert secret not in str(caught.value)


def test_runtime_rejects_unsafe_urls_and_shapes(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text("- not-a-mapping\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="must contain a YAML mapping"):
        load_host_runtime_config(path, environ={})

    path.write_text("public_base_url: https://user@example.test\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="must not contain user information"):
        load_host_runtime_config(path, environ={})

    path.write_text("public_base_url: https://example.test/?token=x\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="query or fragment"):
        load_host_runtime_config(path, environ={})

    path.write_text("local_gui_url: https://gui.example.test\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="loopback host"):
        load_host_runtime_config(path, environ={})

    path.write_text("object_store: value\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="must be a YAML mapping"):
        load_host_runtime_config(path, environ={})

    path.write_text("relay_url: wss:///tunnel\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="absolute URL"):
        load_host_runtime_config(path, environ={})


def test_runtime_yaml_parse_error_never_echoes_the_source_or_secret(tmp_path: Path) -> None:
    secret = "do-not-echo-this-secret"
    path = tmp_path / "relay.yaml"
    path.write_text(f"object_store: [{secret}\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError) as caught:
        load_object_store_config(path, environ={})
    message = str(caught.value)
    assert str(path) in message
    assert " at line " in message and ", column " in message
    assert secret not in message
    assert "object_store:" not in message


def test_runtime_loaders_validate_only_their_own_sections(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(
        "relay_url: not-a-url\n"
        "object_store:\n"
        "  endpoint_url: https://s3.example.test\n"
        "  region: region-1\n"
        "  bucket: media\n"
        "  access_key_id: key\n"
        "  secret_access_key: secret\n",
        encoding="utf-8",
    )
    assert load_object_store_config(path, environ={}) is not None
    with pytest.raises(RuntimeConfigError, match="relay_url must be an absolute URL"):
        load_relay_config(path, environ={})

    path.write_text(
        "object_store:\n  bucket: incomplete\n",
        encoding="utf-8",
    )
    assert load_relay_config(path, environ={}).relay_url == "ws://127.0.0.1:8080/tunnel"
    with pytest.raises(RuntimeConfigError, match="object_store is incomplete"):
        load_host_runtime_config(path, environ={})


def test_runtime_public_base_url_is_an_exact_normalized_origin(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text("public_base_url: https://Share.Example.test:9443/\n", encoding="utf-8")
    assert load_relay_config(path, environ={}).public_base_url == "https://share.example.test:9443"

    path.write_text("public_base_url: https://share.example.test/prefix\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="origin without a path"):
        load_relay_config(path, environ={})


@pytest.mark.parametrize(
    "key,value",
    [
        ("public_base_url", "https://[::1"),
        ("public_base_url", "https://localhost:99999"),
        ("local_gui_url", "http://localhost\uff0fpath"),
    ],
)
def test_runtime_converts_url_parser_failures_to_config_errors(
    tmp_path: Path, key: str, value: str
) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(f"{key}: {value}\n", encoding="utf-8")

    with pytest.raises(RuntimeConfigError, match="absolute URL with a valid host and port"):
        load_relay_config(path, environ={})


def test_runtime_rejects_unknown_yaml_keys(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text("unexpected: value\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="unknown top-level key 'unexpected'"):
        load_relay_config(path, environ={})

    path.write_text("object_store:\n  unexpected: value\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="unknown object_store key 'unexpected'"):
        load_object_store_config(path, environ={})


def test_localhost_is_an_allowed_local_gui_host(tmp_path: Path) -> None:
    loaded = load_host_runtime_config(
        tmp_path / "missing.yaml",
        local_gui_url="http://localhost:9000",
        environ={},
    )
    assert loaded.relay.local_gui_url == "http://localhost:9000"


def test_object_store_cdn_is_validated_and_normalized(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(
        "object_store:\n"
        "  endpoint_url: https://s3.example.test/\n"
        "  region: region-1\n"
        "  bucket: media\n"
        "  access_key_id: key\n"
        "  secret_access_key: secret\n"
        "  cdn_endpoint: https://media.example.test/\n",
        encoding="utf-8",
    )
    loaded = load_host_runtime_config(path, environ={})
    assert loaded.object_store is not None
    assert loaded.object_store.endpoint_url == "https://s3.example.test"
    assert loaded.object_store.cdn_endpoint == "https://media.example.test"

    path.write_text(path.read_text().replace("https://media", "http://media"))
    with pytest.raises(RuntimeConfigError, match="must use https"):
        load_host_runtime_config(path, environ={})


def test_default_relay_path_honors_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_RELAY_CONFIG", "~/custom-relay.yaml")
    assert default_relay_config_path() == Path.home() / "custom-relay.yaml"


def test_relay_host_id_precedence_env_yaml_persisted(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    persisted = load_relay_config(path, environ={}).host_id
    id_file = tmp_path / "relay_host_id"
    assert id_file.read_text(encoding="utf-8").strip() == persisted
    assert id_file.stat().st_mode & 0o777 == 0o600
    # Stable across loads (i.e. process restarts) - not a fresh uuid each time.
    assert load_relay_config(path, environ={}).host_id == persisted
    assert load_relay_config(path, environ={"PODCAST_RELAY_HOST_ID": ""}).host_id == persisted
    path.write_text("host_id: yaml-host\n", encoding="utf-8")
    assert load_relay_config(path, environ={}).host_id == "yaml-host"
    env = {"PODCAST_RELAY_HOST_ID": "env-host"}
    assert load_host_runtime_config(path, environ=env).relay.host_id == "env-host"


def test_relay_host_id_rejects_token_map_separators(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    for bad in ("host:1", "a,b", "has space"):
        with pytest.raises(RuntimeConfigError, match="host_id"):
            load_relay_config(path, environ={"PODCAST_RELAY_HOST_ID": bad})


def test_default_relay_config_uses_persisted_host_id() -> None:
    # conftest points PODCAST_RELAY_CONFIG at tmp_path/relay.yaml
    first = RelayConfig()
    assert RelayConfig().host_id == first.host_id
    assert relay_host_id_path() == default_relay_config_path().with_name("relay_host_id")
    assert relay_host_id_path().read_text(encoding="utf-8").strip() == first.host_id


def test_persisted_host_id_unwritable_falls_back_to_ephemeral(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import podcast_mcp.runtime_config as rc

    def _deny(*_a, **_k):
        raise PermissionError("read-only")

    monkeypatch.setattr(rc.os, "open", _deny)
    cfg = tmp_path / "ro" / "relay.yaml"
    a = persisted_relay_host_id(cfg)
    assert a
    assert not relay_host_id_path(cfg).exists()


def test_persisted_host_id_uses_winner_of_create_race(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import podcast_mcp.runtime_config as rc

    cfg = tmp_path / "relay.yaml"

    def _lose_race(path, *_a, **_k):
        Path(path).write_text("winner-id\n", encoding="utf-8")
        raise FileExistsError(path)

    monkeypatch.setattr(rc.os, "open", _lose_race)
    assert persisted_relay_host_id(cfg) == "winner-id"
