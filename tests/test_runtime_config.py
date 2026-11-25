from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp import settings
from podcast_mcp.config.runtime import (
    SECRET_ENV_NAMES,
    RelayConfig,
    RuntimeConfigError,
    configured_secrets,
    default_relay_config_path,
    load_host_runtime_config,
    load_object_store_config,
    load_relay_config,
    persisted_relay_host_id,
    ready_relay_config,
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
    import podcast_mcp.config.runtime as rc

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
    import podcast_mcp.config.runtime as rc

    cfg = tmp_path / "relay.yaml"

    def _lose_race(path, *_a, **_k):
        Path(path).write_text("winner-id\n", encoding="utf-8")
        raise FileExistsError(path)

    monkeypatch.setattr(rc.os, "open", _lose_race)
    assert persisted_relay_host_id(cfg) == "winner-id"


def test_ready_relay_config_requires_host_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_RELAY_URL", "wss://relay.example.test/tunnel")
    monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", "https://relay.example.test")

    assert ready_relay_config() is None

    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")
    ready = ready_relay_config()
    assert ready is not None
    assert (ready.relay_url, ready.host_token) == ("wss://relay.example.test/tunnel", "tok")


def test_ready_relay_config_overrides_local_gui_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")

    ready = ready_relay_config(local_gui_url="http://127.0.0.1:43123")

    assert ready is not None
    assert ready.local_gui_url == "http://127.0.0.1:43123"


def test_ready_relay_config_is_none_for_an_invalid_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")
    monkeypatch.setenv("PODCAST_RELAY_URL", "ws://relay.example.test/tunnel")

    assert ready_relay_config() is None


def test_ready_relay_config_none_writes_no_host_id_file() -> None:
    assert ready_relay_config() is None
    assert not relay_host_id_path().exists()


def test_relay_config_repr_omits_host_token() -> None:
    cfg = RelayConfig(host_token="s3cret-token", host_id="h1")

    assert "s3cret-token" not in repr(cfg)


@pytest.mark.parametrize("value", ["http://share.example.test", "http://10.0.0.5:8080"])
def test_public_base_url_requires_https_off_loopback(tmp_path: Path, value: str) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(f"public_base_url: {value}\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="public_base_url must use https"):
        load_relay_config(path, environ={})


@pytest.mark.parametrize("value", ["http://127.0.0.1:9123", "http://localhost", "http://[::1]:80"])
def test_public_base_url_allows_http_on_loopback(tmp_path: Path, value: str) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(f"public_base_url: {value}\n", encoding="utf-8")
    expected = {"http://[::1]:80": "http://[::1]"}.get(value, value)
    assert load_relay_config(path, environ={}).public_base_url == expected


def test_public_base_url_accepts_https_off_loopback(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text("public_base_url: https://share.example.test\n", encoding="utf-8")
    assert load_relay_config(path, environ={}).public_base_url == "https://share.example.test"


@pytest.mark.parametrize("value", ["https://gui.example.test", "http://10.0.0.5:8765"])
def test_local_gui_url_rejects_non_loopback_hosts(tmp_path: Path, value: str) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(f"local_gui_url: {value}\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="local_gui_url must"):
        load_relay_config(path, environ={})


@pytest.mark.parametrize(
    ("field", "env_name", "yaml_value", "env_value", "explicit_value"),
    [
        ("host_token", "PODCAST_RELAY_HOST_TOKEN", "yaml-token", "env-token", "explicit-token"),
        (
            "public_base_url",
            "PODCAST_RELAY_PUBLIC_BASE_URL",
            "https://yaml.example.test",
            "https://env.example.test",
            "https://explicit.example.test",
        ),
        (
            "local_gui_url",
            "PODCAST_RELAY_LOCAL_GUI_URL",
            "http://127.0.0.1:1111",
            "http://127.0.0.1:2222",
            "http://127.0.0.1:3333",
        ),
    ],
)
def test_runtime_precedence_is_explicit_then_env_then_yaml_per_field(
    tmp_path: Path,
    field: str,
    env_name: str,
    yaml_value: str,
    env_value: str,
    explicit_value: str,
) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(f"{field}: {yaml_value}\n", encoding="utf-8")

    def loaded(env: dict[str, str], **explicit: str) -> str:
        relay = load_host_runtime_config(path, environ=env, **explicit).relay
        return str(getattr(relay, field))

    assert loaded({}) == yaml_value
    assert loaded({env_name: env_value}) == env_value
    assert loaded({env_name: env_value}, **{field: explicit_value}) == explicit_value
    assert loaded({}, **{field: explicit_value}) == explicit_value


def test_object_store_env_overrides_yaml_for_every_field(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(
        "object_store:\n"
        "  endpoint_url: https://yaml-s3.example.test\n"
        "  region: yaml-region\n"
        "  bucket: yaml-bucket\n"
        "  access_key_id: yaml-access-key\n"
        "  secret_access_key: yaml-secret-key\n"
        "  cdn_endpoint: https://yaml-cdn.example.test\n",
        encoding="utf-8",
    )
    env = {
        "PODCAST_OBJECT_STORE_ENDPOINT_URL": "https://env-s3.example.test",
        "PODCAST_OBJECT_STORE_REGION": "env-region",
        "PODCAST_OBJECT_STORE_BUCKET": "env-bucket",
        "PODCAST_OBJECT_STORE_ACCESS_KEY_ID": "env-access-key",
        "PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY": "env-secret-key",
        "PODCAST_OBJECT_STORE_CDN_ENDPOINT": "https://env-cdn.example.test",
    }
    yaml_only = load_object_store_config(path, environ={})
    assert yaml_only is not None
    assert yaml_only.bucket == "yaml-bucket"
    assert yaml_only.secret_access_key == "yaml-secret-key"
    overridden = load_object_store_config(path, environ=env)
    assert overridden is not None
    assert overridden.endpoint_url == "https://env-s3.example.test"
    assert overridden.region == "env-region"
    assert overridden.bucket == "env-bucket"
    assert overridden.access_key_id == "env-access-key"
    assert overridden.secret_access_key == "env-secret-key"
    assert overridden.cdn_endpoint == "https://env-cdn.example.test"


def test_configured_secrets_reads_env_and_yaml_without_writing(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text(
        "host_token: yaml-host-token-1\n"
        "object_store:\n"
        "  access_key_id: yaml-access-key-1\n"
        "  secret_access_key: yaml-secret-key-1\n",
        encoding="utf-8",
    )
    env = {
        "PODCAST_RELAY_HOST_TOKEN": "env-host-token-1",
        "PODCAST_OBJECT_STORE_ADMIN_SECRET_ACCESS_KEY": "env-admin-secret-1",
        "PODCAST_SESSION_TOKEN": "env-session-token-1",
        "PODCAST_SIDECAR_BOOT_TOKEN": "  env-boot-token-1  ",
        "PODCAST_REPORT_GITHUB_TOKEN": "short",
    }
    found = configured_secrets(path, environ=env)
    assert set(found) == {
        "yaml-host-token-1",
        "yaml-access-key-1",
        "yaml-secret-key-1",
        "env-host-token-1",
        "env-admin-secret-1",
        "env-session-token-1",
        "env-boot-token-1",
    }
    assert [p.name for p in tmp_path.iterdir()] == ["relay.yaml"]


@pytest.mark.parametrize("content", [b"host_token: [unclosed\n", b"\xff\xfe\x00bad", b"- a\n- b\n"])
def test_configured_secrets_survives_an_unreadable_config(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "relay.yaml"
    path.write_bytes(content)
    env = {"PODCAST_RELAY_HOST_TOKEN": "env-host-token-1"}
    assert configured_secrets(path, environ=env) == ("env-host-token-1",)
    assert configured_secrets(tmp_path / "missing.yaml", environ={}) == ()
    assert not (tmp_path / "relay_host_id").exists()


def test_configured_secrets_ignores_a_malformed_object_store_block(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_text("host_token: yaml-host-token-1\nobject_store: nope\n", encoding="utf-8")
    assert configured_secrets(path, environ={}) == ("yaml-host-token-1",)


def test_secret_env_names_are_declared_settings() -> None:
    declared = {variable.name for variable in settings.VARIABLES}
    assert set(SECRET_ENV_NAMES) <= declared
