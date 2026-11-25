from __future__ import annotations

import json
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
    note_relay_does_not_enroll,
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


def test_ready_relay_config_needs_a_host_token_or_a_named_relay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", "https://relay.example.test")
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")
    ready = ready_relay_config()
    assert ready is not None
    assert ready.host_token == "tok"

    monkeypatch.delenv("PODCAST_RELAY_HOST_TOKEN")
    assert ready_relay_config() is None

    monkeypatch.setenv("PODCAST_RELAY_URL", "wss://relay.example.test/tunnel")
    named = ready_relay_config()
    assert named is not None
    assert (named.relay_url, named.host_token) == ("wss://relay.example.test/tunnel", "")

    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")
    both = ready_relay_config()
    assert both is not None
    assert (both.relay_url, both.host_token) == ("wss://relay.example.test/tunnel", "tok")


def test_a_named_relay_that_does_not_enroll_is_not_ready_without_a_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PODCAST_RELAY_URL", "wss://relay.example.test/tunnel")
    monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", "https://relay.example.test")
    assert ready_relay_config() is not None

    note_relay_does_not_enroll("wss://relay.example.test/tunnel")

    assert ready_relay_config() is None
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")
    assert ready_relay_config() is not None


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


def _fake(label: str) -> str:
    """A distinct eight-plus character stand-in, built at runtime so no source line
    holds a literal that a credential scanner would flag."""
    return "-".join(("fixture", label, "v1"))


_NUMERIC_LIMIT_SUFFIXES = ("_RPM", "_BURST", "_CONCURRENT")
_SECRET_WORDS = frozenset(
    {"TOKEN", "TOKENS", "SECRET", "SECRETS", "PASSWORD", "KEY", "KEYS", "CREDENTIAL", "CREDENTIALS"}
)


def _relay_yaml(path: Path, **fields: str) -> Path:
    lines = [f"{key}: {value}" for key, value in fields.items() if key == "host_token"]
    store = {k: v for k, v in fields.items() if k != "host_token"}
    if store:
        lines.append("object_store:")
        lines += [f"  {key}: {value}" for key, value in store.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _expected_secret(name: str, value: str) -> str:
    return value.partition(":")[2] if name == "PODCAST_RELAY_HOST_TOKENS" else value


@pytest.mark.parametrize("name", SECRET_ENV_NAMES)
def test_every_listed_env_name_is_a_configured_secret(tmp_path: Path, name: str) -> None:
    value = "hostid:" + _fake(name.lower()) if name == "PODCAST_RELAY_HOST_TOKENS" else _fake(name)
    found = configured_secrets(tmp_path / "relay.yaml", environ={name: value})
    assert found == (_expected_secret(name, value),)


def test_every_secret_looking_setting_is_listed_or_explicitly_not_secret() -> None:
    # A new *_TOKEN / *_SECRET / *_KEY setting fails here until it joins
    # SECRET_ENV_NAMES (so diagnostics bundles mask it) or is a numeric limit.
    looks_secret = {
        variable.name
        for variable in settings.VARIABLES
        if _SECRET_WORDS & set(variable.name.split("_"))
        or "SECRET" in variable.name
        or "ACCESS_KEY" in variable.name
    }
    unlisted = {
        name
        for name in looks_secret - set(SECRET_ENV_NAMES)
        if not name.endswith(_NUMERIC_LIMIT_SUFFIXES)  # rate and concurrency numbers
    }
    assert not unlisted, f"add to SECRET_ENV_NAMES (or make it a numeric limit): {sorted(unlisted)}"
    assert set(SECRET_ENV_NAMES) <= {variable.name for variable in settings.VARIABLES}


def test_configured_secrets_reads_env_and_yaml_without_writing(tmp_path: Path) -> None:
    host, key_id, key = _fake("yaml-host"), _fake("yaml-keyid"), _fake("yaml-key")
    path = _relay_yaml(
        tmp_path / "relay.yaml", host_token=host, access_key_id=key_id, secret_access_key=key
    )
    env = {
        "PODCAST_RELAY_HOST_TOKEN": _fake("env-host"),
        "PODCAST_SESSION_TOKEN": "  " + _fake("env-session") + "  ",
        "PODCAST_REPORT_GITHUB_TOKEN": "short",
    }
    found = configured_secrets(path, environ=env)
    assert set(found) == {host, key_id, key, _fake("env-host"), _fake("env-session")}
    assert [p.name for p in tmp_path.iterdir()] == ["relay.yaml"]


def test_configured_secrets_length_floor_is_eight_characters(tmp_path: Path) -> None:
    env = {"PODCAST_RELAY_HOST_TOKEN": "x" * 7, "PODCAST_SESSION_TOKEN": "y" * 8}
    assert configured_secrets(tmp_path / "relay.yaml", environ=env) == ("y" * 8,)


@pytest.mark.parametrize("content", [b"host_token: [unclosed\n", b"\xff\xfe\x00bad", b"- a\n- b\n"])
def test_configured_secrets_survives_an_unreadable_config(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "relay.yaml"
    path.write_bytes(content)
    env = {"PODCAST_RELAY_HOST_TOKEN": _fake("env-host")}
    assert configured_secrets(path, environ=env) == (_fake("env-host"),)
    assert configured_secrets(tmp_path / "missing.yaml", environ={}) == ()
    assert not (tmp_path / "relay_host_id").exists()


def test_configured_secrets_reads_what_a_partly_invalid_relay_yaml_still_holds(
    tmp_path: Path,
) -> None:
    host, key = _fake("file-host"), _fake("file-key")
    path = tmp_path / "relay.yaml"
    path.write_text(
        f"host_token: {host}\nobject_store:\n  secret_access_key: '{key}'  # kept\n"
        "  access_key_id: [unclosed\n",
        encoding="utf-8",
    )
    env = {"PODCAST_SESSION_TOKEN": _fake("env-session")}
    assert set(configured_secrets(path, environ=env)) == {host, key, _fake("env-session")}
    assert [p.name for p in tmp_path.iterdir()] == ["relay.yaml"]


def test_configured_secrets_sources_fail_independently(tmp_path: Path) -> None:
    path = tmp_path / "relay.yaml"
    path.write_bytes(b"\xff\xfe\x00")
    admin_key = _fake("admin-key")
    (tmp_path / "relay-admin.yaml").write_text(f"secret_access_key: {admin_key}\n")
    (tmp_path / "oauth.json").write_text("{not json", encoding="utf-8")
    env = {
        "PODCAST_RELAY_HOST_TOKEN": _fake("env-host"),
        "PODCAST_GOOGLE_OAUTH_CLIENT_FILE": str(tmp_path / "oauth.json"),
    }
    assert set(configured_secrets(path, environ=env)) == {_fake("env-host"), admin_key}


def test_configured_secrets_reads_the_admin_yaml_beside_the_relay_config(tmp_path: Path) -> None:
    key_id, key = _fake("admin-keyid"), _fake("admin-key")
    other = tmp_path / "elsewhere"
    other.mkdir()
    (other / "relay-admin.yaml").write_text(
        f"access_key_id: {key_id}\nsecret_access_key: {key}\n", encoding="utf-8"
    )
    assert set(configured_secrets(other / "relay.yaml", environ={})) == {key_id, key}
    assert configured_secrets(tmp_path / "relay.yaml", environ={}) == ()


@pytest.mark.parametrize(
    ("env_name", "shape"),
    [
        ("PODCAST_GOOGLE_OAUTH_CLIENT_FILE", "web"),
        ("PODCAST_GOOGLE_OAUTH_CLIENT_FILE", "flat"),
        ("PODCAST_GITHUB_OAUTH_CLIENT_FILE", "flat"),
    ],
)
def test_configured_secrets_reads_oauth_client_files(
    tmp_path: Path, env_name: str, shape: str
) -> None:
    client_secret = _fake("oauth-client")
    body = {"client_id": "id", "client_secret": client_secret}
    path = tmp_path / "client.json"
    path.write_text(json.dumps({"web": body} if shape == "web" else body), encoding="utf-8")
    assert configured_secrets(tmp_path / "relay.yaml", environ={env_name: str(path)}) == (
        client_secret,
    )


def test_configured_secrets_reads_oauth_client_files_from_the_config_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(tmp_path))
    client_secret = _fake("oauth-default")
    (tmp_path / "github-oauth.json").write_text(
        json.dumps({"client_id": "id", "client_secret": client_secret}), encoding="utf-8"
    )
    assert configured_secrets(tmp_path / "relay.yaml", environ={}) == (client_secret,)


def test_configured_secrets_masks_only_the_secret_half_of_host_token_pairs(
    tmp_path: Path,
) -> None:
    first, second = _fake("pair-one"), _fake("pair-two")
    env = {"PODCAST_RELAY_HOST_TOKENS": f"host-a:{first},host-b:{second},broken"}
    assert set(configured_secrets(tmp_path / "relay.yaml", environ=env)) == {first, second}


def test_configured_secrets_ignores_a_malformed_object_store_block(tmp_path: Path) -> None:
    host = _fake("yaml-host")
    path = tmp_path / "relay.yaml"
    path.write_text(f"host_token: {host}\nobject_store: nope\n", encoding="utf-8")
    assert configured_secrets(path, environ={}) == (host,)
