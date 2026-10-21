"""`podcast relay bucket-setup` / `bucket-check`: admin-key CORS for the object store (#1760)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.services.media import bucket_setup as bs
from podcast_mcp.services.media.object_store_cors import cors_rule

ORIGIN = "https://share.example.test"
BUCKET = "example-bucket"
runner = CliRunner()


class _Denied(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    """A bucket with a CORS list; `forget` makes the store drop writes (read-back check)."""

    def __init__(self, rules: list[dict[str, Any]] | None = None, *, deny: str = "") -> None:
        self.rules = rules
        self.deny = deny
        self.forget = False
        self.puts: list[list[dict[str, Any]]] = []

    def get_bucket_cors(self, *, Bucket: str) -> dict[str, Any]:
        assert Bucket == BUCKET
        if self.deny == "get":
            raise _Denied("AccessDenied")
        if self.rules is None:
            raise _Denied("NoSuchCORSConfiguration")
        return {"CORSRules": self.rules}

    def put_bucket_cors(self, *, Bucket: str, CORSConfiguration: dict[str, Any]) -> None:
        if self.deny == "put":
            raise _Denied("AccessDenied")
        self.puts.append(CORSConfiguration["CORSRules"])
        if not self.forget:
            self.rules = CORSConfiguration["CORSRules"]


OTHER_RULE = {
    "AllowedOrigins": ["https://other.example.test"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 60,
}


def test_empty_bucket_gets_our_rule() -> None:
    s3 = FakeS3(None)
    result = bs.setup_bucket_cors(s3, BUCKET, ORIGIN)
    assert result.state == "added"
    assert s3.rules == cors_rule(ORIGIN)


def test_second_run_changes_nothing() -> None:
    s3 = FakeS3(None)
    bs.setup_bucket_cors(s3, BUCKET, ORIGIN)
    again = bs.setup_bucket_cors(s3, BUCKET, ORIGIN)
    assert again.state == "already_set"
    assert len(s3.puts) == 1


def test_a_live_rule_that_already_serves_the_origin_is_never_rewritten() -> None:
    live = [{**cors_rule(ORIGIN)[0], "ID": "live", "MaxAgeSeconds": 7200}]
    s3 = FakeS3(list(live))
    assert bs.setup_bucket_cors(s3, BUCKET, ORIGIN).state == "already_set"
    assert s3.puts == []
    assert s3.rules == live


def test_a_wildcard_rule_that_serves_the_origin_counts() -> None:
    rule = {**cors_rule(ORIGIN)[0], "AllowedOrigins": ["*"]}
    assert bs.setup_bucket_cors(FakeS3([rule]), BUCKET, ORIGIN).state == "already_set"


def test_other_rules_are_kept_intact_and_in_order() -> None:
    s3 = FakeS3([dict(OTHER_RULE)])
    result = bs.setup_bucket_cors(s3, BUCKET, ORIGIN)
    assert result.state == "added"
    assert result.kept == 1
    assert s3.rules == [*cors_rule(ORIGIN), OTHER_RULE]


def test_a_rule_for_the_origin_that_is_too_narrow_is_not_enough() -> None:
    narrow = {**cors_rule(ORIGIN)[0], "AllowedMethods": ["GET"]}
    s3 = FakeS3([narrow])
    assert bs.setup_bucket_cors(s3, BUCKET, ORIGIN).state == "added"
    assert s3.rules == [*cors_rule(ORIGIN), narrow]
    assert bs.setup_bucket_cors(s3, BUCKET, ORIGIN).state == "already_set"


def test_dry_run_writes_nothing() -> None:
    s3 = FakeS3([dict(OTHER_RULE)])
    result = bs.setup_bucket_cors(s3, BUCKET, ORIGIN, dry_run=True)
    assert result.state == "would_add"
    assert s3.puts == []


def test_a_write_the_store_dropped_is_reported() -> None:
    s3 = FakeS3(None)
    s3.forget = True
    with pytest.raises(bs.BucketSetupError, match="reading it back"):
        bs.setup_bucket_cors(s3, BUCKET, ORIGIN)


@pytest.mark.parametrize("deny", ["get", "put"])
def test_the_upload_key_is_told_it_is_not_enough(deny: str) -> None:
    with pytest.raises(bs.BucketSetupError, match="admin key"):
        bs.setup_bucket_cors(FakeS3(None, deny=deny), BUCKET, ORIGIN)


def test_credentials_from_env_win_and_must_be_complete(tmp_path: Path) -> None:
    env = {bs.ADMIN_ID_ENV: "id", bs.ADMIN_SECRET_ENV: "secret"}
    relay_yaml = tmp_path / "relay.yaml"
    creds = bs.load_admin_credentials(environ=env, relay_config_path=relay_yaml)
    assert creds == bs.AdminCredentials("id", "secret")
    assert "secret" not in repr(creds)
    with pytest.raises(bs.BucketSetupError, match="both"):
        bs.load_admin_credentials(environ={bs.ADMIN_ID_ENV: "id"}, relay_config_path=relay_yaml)


def test_env_beats_the_default_file_but_an_explicit_file_beats_env(tmp_path: Path) -> None:
    _admin_file(tmp_path, text="access_key_id: file-id\nsecret_access_key: file-secret\n")
    env = {bs.ADMIN_ID_ENV: "env-id", bs.ADMIN_SECRET_ENV: "env-secret"}
    relay_yaml = tmp_path / "relay.yaml"
    assert bs.load_admin_credentials(environ=env, relay_config_path=relay_yaml) == (
        bs.AdminCredentials("env-id", "env-secret")
    )
    explicit = tmp_path / "relay-admin.yaml"
    assert bs.load_admin_credentials(environ=env, path=explicit) == (
        bs.AdminCredentials("file-id", "file-secret")
    )
    with pytest.raises(bs.BucketSetupError, match="does not exist"):
        bs.load_admin_credentials(environ=env, path=tmp_path / "missing.yaml")


def test_no_credentials_is_none(tmp_path: Path) -> None:
    assert bs.load_admin_credentials(environ={}, relay_config_path=tmp_path / "relay.yaml") is None


def _admin_file(tmp_path: Path, mode: int = 0o600, text: str | None = None) -> Path:
    path = tmp_path / "relay-admin.yaml"
    path.write_text(text or "access_key_id: id\nsecret_access_key: secret\n", encoding="utf-8")
    path.chmod(mode)
    return path


def test_credentials_from_file_next_to_relay_yaml(tmp_path: Path) -> None:
    _admin_file(tmp_path)
    creds = bs.load_admin_credentials(environ={}, relay_config_path=tmp_path / "relay.yaml")
    assert creds == bs.AdminCredentials("id", "secret")


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
def test_a_group_readable_admin_file_is_refused(tmp_path: Path) -> None:
    path = _admin_file(tmp_path, 0o640)
    with pytest.raises(bs.BucketSetupError, match="chmod 600"):
        bs.load_admin_credentials(environ={}, path=path)


def test_unknown_or_missing_keys_in_the_admin_file_are_refused(tmp_path: Path) -> None:
    path = _admin_file(tmp_path, text="access_key_id: id\nbucket: x\n")
    with pytest.raises(bs.BucketSetupError, match="unknown key"):
        bs.load_admin_credentials(environ={}, path=path)
    path = _admin_file(tmp_path, text="access_key_id: id\n")
    with pytest.raises(bs.BucketSetupError, match="needs access_key_id"):
        bs.load_admin_credentials(environ={}, path=path)


# --- CLI ------------------------------------------------------------------------------------


@pytest.fixture
def relay_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for name in (bs.ADMIN_ID_ENV, bs.ADMIN_SECRET_ENV):
        monkeypatch.delenv(name, raising=False)
    path = tmp_path / "relay.yaml"
    path.write_text(
        f"public_base_url: {ORIGIN}\n"
        "object_store:\n"
        "  endpoint_url: https://sfo3.example.test\n"
        "  region: sfo3\n"
        f"  bucket: {BUCKET}\n"
        "  access_key_id: upload-id\n"
        "  secret_access_key: upload-secret\n",
        encoding="utf-8",
    )
    return path


def _use(monkeypatch: pytest.MonkeyPatch, s3: FakeS3) -> list[bs.AdminCredentials]:
    seen: list[bs.AdminCredentials] = []

    def factory(cfg: Any, creds: bs.AdminCredentials) -> FakeS3:
        seen.append(creds)
        return s3

    monkeypatch.setattr("podcast_mcp.cli.relay.make_admin_client", factory)
    return seen


def test_setup_command_adds_the_rule_then_is_a_no_op(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3 = FakeS3([dict(OTHER_RULE)])
    seen = _use(monkeypatch, s3)
    _admin_file(relay_config.parent)
    args = ["relay", "bucket-setup", "--config", str(relay_config)]
    first = runner.invoke(app, args)
    assert first.exit_code == 0, first.output
    assert "Added a CORS rule" in first.output
    assert "1 other rule kept" in first.output
    second = runner.invoke(app, args)
    assert second.exit_code == 0
    assert "Nothing changed" in second.output
    assert len(s3.puts) == 1
    assert seen[0] == bs.AdminCredentials("id", "secret")
    assert "secret" not in first.output + second.output


def test_setup_command_dry_run(relay_config: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    s3 = FakeS3(None)
    _use(monkeypatch, s3)
    _admin_file(relay_config.parent)
    result = runner.invoke(
        app, ["relay", "bucket-setup", "--config", str(relay_config), "--dry-run"]
    )
    assert result.exit_code == 0
    assert "Would add" in result.output
    assert s3.puts == []


def test_setup_command_without_a_key_says_where_to_put_it(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _use(monkeypatch, FakeS3(None))
    monkeypatch.setattr("podcast_mcp.cli.relay._interactive", lambda: False)
    result = runner.invoke(app, ["relay", "bucket-setup", "--config", str(relay_config)])
    assert result.exit_code == 2
    assert bs.ADMIN_ID_ENV in result.output
    assert "relay-admin.yaml" in result.output


def test_setup_command_refused_key_exits_1(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _use(monkeypatch, FakeS3(None, deny="get"))
    _admin_file(relay_config.parent)
    result = runner.invoke(app, ["relay", "bucket-setup", "--config", str(relay_config)])
    assert result.exit_code == 1
    assert "admin key" in result.output


def test_setup_command_needs_an_object_store(tmp_path: Path) -> None:
    config = tmp_path / "relay.yaml"
    config.write_text("relay_url: wss://relay.example.test/tunnel\n", encoding="utf-8")
    result = runner.invoke(app, ["relay", "bucket-setup", "--config", str(config)])
    assert result.exit_code == 2
    assert "No object store" in result.output


def test_check_with_an_admin_key_reads_the_rules(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3 = FakeS3(cors_rule(ORIGIN))
    _use(monkeypatch, s3)
    _admin_file(relay_config.parent)
    ok = runner.invoke(app, ["relay", "bucket-check", "--config", str(relay_config)])
    assert ok.exit_code == 0
    assert "allows" in ok.output
    s3.rules = [dict(OTHER_RULE)]
    blocked = runner.invoke(app, ["relay", "bucket-check", "--config", str(relay_config)])
    assert blocked.exit_code == 1
    assert "podcast relay bucket-setup" in blocked.output
    assert s3.puts == []


def test_check_without_an_admin_key_asks_as_a_guest(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.media.object_store_cors import CorsProbe

    answers = iter([CorsProbe("ok", ORIGIN), CorsProbe("blocked", ORIGIN, "origin not allowed")])
    monkeypatch.setattr("podcast_mcp.cli.relay.guest_check", lambda cfg, origin: next(answers))
    args = ["relay", "bucket-check", "--config", str(relay_config)]
    assert runner.invoke(app, args).exit_code == 0
    blocked = runner.invoke(app, args)
    assert blocked.exit_code == 1
    assert "origin not allowed" in blocked.output


def test_check_with_an_unreachable_bucket_is_not_a_pass(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.media.object_store_cors import CorsProbe

    monkeypatch.setattr(
        "podcast_mcp.cli.relay.guest_check",
        lambda cfg, origin: CorsProbe("unknown", origin, "object store not reachable"),
    )
    result = runner.invoke(app, ["relay", "bucket-check", "--config", str(relay_config)])
    assert result.exit_code == 1
    assert "Could not reach" in result.output


def test_guest_check_probes_a_presigned_url_with_the_guest_origin() -> None:
    seen: list[tuple[str, str]] = []

    def fetch(url: str, origin: str) -> dict[str, str]:
        seen.append((url, origin))
        return {"access-control-allow-origin": origin}

    cfg = bs.ObjectStoreConfig("https://s.example.test", "r", BUCKET, "i", "s")
    probe = bs.guest_check(
        cfg,
        ORIGIN,
        presign=lambda key, expires_in: f"https://s.example.test/{key}?x=1",
        fetch=fetch,
    )
    assert probe.status == "ok"
    assert seen == [("https://s.example.test/review/.cors-probe?x=1", ORIGIN)]


def test_setup_command_prompts_for_a_key_in_a_terminal(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3 = FakeS3(None)
    seen = _use(monkeypatch, s3)
    monkeypatch.setattr("podcast_mcp.cli.relay._interactive", lambda: True)
    result = runner.invoke(
        app,
        ["relay", "bucket-setup", "--config", str(relay_config)],
        input="typed-id\ntyped-secret\n",
    )
    assert result.exit_code == 0, result.output
    assert seen == [bs.AdminCredentials("typed-id", "typed-secret")]
    assert "typed-secret" not in result.output
    assert not (relay_config.parent / bs.ADMIN_FILENAME).exists()


def test_a_bad_admin_file_stops_the_command(relay_config: Path) -> None:
    _admin_file(relay_config.parent, text="- not\n- a mapping\n")
    result = runner.invoke(app, ["relay", "bucket-setup", "--config", str(relay_config)])
    assert result.exit_code == 2
    assert "YAML mapping" in result.output


def test_an_invalid_relay_config_stops_the_command(tmp_path: Path) -> None:
    config = tmp_path / "relay.yaml"
    config.write_text("relay_url: ws://not-loopback.example.test/tunnel\n", encoding="utf-8")
    result = runner.invoke(app, ["relay", "bucket-check", "--config", str(config)])
    assert result.exit_code == 2
    assert "Invalid relay configuration" in result.output


class _Broken(FakeS3):
    def get_bucket_cors(self, *, Bucket: str) -> dict[str, Any]:
        raise RuntimeError("boom")


def test_other_read_and_write_failures_are_reported() -> None:
    with pytest.raises(bs.BucketSetupError, match="Could not read CORS"):
        bs.setup_bucket_cors(_Broken(None), BUCKET, ORIGIN)

    class _PutBroken(FakeS3):
        def put_bucket_cors(self, **_kw: Any) -> None:
            raise RuntimeError("boom")

    with pytest.raises(bs.BucketSetupError, match="Could not set CORS"):
        bs.setup_bucket_cors(_PutBroken(None), BUCKET, ORIGIN)


def test_admin_client_is_built_for_the_store_endpoint() -> None:
    cfg = bs.ObjectStoreConfig("https://sfo3.example.test", "sfo3", BUCKET, "up", "up-secret")
    client = bs.make_admin_client(cfg, bs.AdminCredentials("adm", "adm-secret"))
    assert client.meta.endpoint_url == "https://sfo3.example.test"


def test_guest_check_defaults_to_the_upload_keys_presigned_url() -> None:
    cfg = bs.ObjectStoreConfig("https://sfo3.example.test", "sfo3", BUCKET, "up", "up-secret")
    seen: list[str] = []

    def fetch(url: str, origin: str) -> dict[str, str]:
        seen.append(url)
        return {"access-control-allow-origin": "*"}

    assert bs.guest_check(cfg, ORIGIN, fetch=fetch).status == "ok"
    assert seen[0].startswith("https://") and "review/.cors-probe" in seen[0]


def test_a_live_rule_with_short_expose_headers_is_left_alone_and_reported() -> None:
    live = [{**cors_rule(ORIGIN)[0], "ExposeHeaders": ["Content-Range"]}]
    s3 = FakeS3(list(live))
    result = bs.setup_bucket_cors(s3, BUCKET, ORIGIN)
    assert result.state == "already_set"
    assert result.missing_expose == ["accept-ranges", "content-length"]
    assert s3.puts == []
    assert s3.rules == live


def test_a_later_rule_that_covers_the_origin_is_enough() -> None:
    first = {**OTHER_RULE, "AllowedOrigins": ["*"], "AllowedMethods": ["PUT"]}
    s3 = FakeS3([first, cors_rule(ORIGIN)[0]])
    assert bs.setup_bucket_cors(s3, BUCKET, ORIGIN).state == "already_set"
    assert s3.puts == []


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
@pytest.mark.parametrize(("mode", "refused"), [(0o604, True), (0o640, True), (0o400, False)])
def test_admin_file_modes(tmp_path: Path, mode: int, refused: bool) -> None:
    path = _admin_file(tmp_path, mode)
    if refused:
        with pytest.raises(bs.BucketSetupError, match="chmod 600"):
            bs.load_admin_credentials(environ={}, path=path)
    else:
        assert bs.load_admin_credentials(environ={}, path=path) is not None


def test_errors_never_carry_the_secret(relay_config: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, FakeS3(None, deny="put"))
    _admin_file(relay_config.parent, text="access_key_id: id\nsecret_access_key: S3CR3T-VALUE\n")
    denied = runner.invoke(app, ["relay", "bucket-setup", "--config", str(relay_config)])
    assert denied.exit_code == 1
    assert "S3CR3T-VALUE" not in denied.output
    _admin_file(relay_config.parent, text="access_key_id: id\nbucket: S3CR3T-VALUE\n")
    bad = runner.invoke(app, ["relay", "bucket-setup", "--config", str(relay_config)])
    assert bad.exit_code == 2
    assert "S3CR3T-VALUE" not in bad.output


def test_prompt_hides_only_the_secret(relay_config: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, FakeS3(None))
    monkeypatch.setattr("podcast_mcp.cli.relay._interactive", lambda: True)
    asked: list[tuple[str, bool]] = []

    def prompt(text: str, hide_input: bool = False, **_kw: Any) -> str:
        asked.append((text, hide_input))
        return "answer"

    monkeypatch.setattr("podcast_mcp.cli.relay.typer.prompt", prompt)
    result = runner.invoke(app, ["relay", "bucket-setup", "--config", str(relay_config)])
    assert result.exit_code == 0, result.output
    assert asked == [("Admin access key id", False), ("Admin secret access key", True)]


def test_admin_keys_are_not_accepted_by_the_runtime_loaders(tmp_path: Path) -> None:
    from podcast_mcp.config.runtime import (
        RuntimeConfigError,
        load_object_store_config,
        load_relay_config,
    )

    top = tmp_path / "top.yaml"
    top.write_text("access_key_id: id\nsecret_access_key: secret\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError):
        load_relay_config(top)
    nested = tmp_path / "nested.yaml"
    nested.write_text(
        "object_store:\n  endpoint_url: https://s.example.test\n  region: r\n  bucket: b\n"
        "  access_key_id: i\n  secret_access_key: s\n  admin_access_key_id: a\n",
        encoding="utf-8",
    )
    with pytest.raises(RuntimeConfigError):
        load_object_store_config(nested)


def test_check_with_env_credentials_and_a_refused_read(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _use(monkeypatch, FakeS3(None, deny="get"))
    monkeypatch.setenv(bs.ADMIN_ID_ENV, "env-id")
    monkeypatch.setenv(bs.ADMIN_SECRET_ENV, "env-secret")
    result = runner.invoke(app, ["relay", "bucket-check", "--config", str(relay_config)])
    assert result.exit_code == 1
    assert seen == [bs.AdminCredentials("env-id", "env-secret")]
    assert "admin key" in result.output


def test_a_blocked_check_prints_the_rule_to_paste(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _use(monkeypatch, FakeS3(None))
    _admin_file(relay_config.parent)
    result = runner.invoke(app, ["relay", "bucket-check", "--config", str(relay_config)])
    assert result.exit_code == 1
    assert '"AllowedMethods":["GET","HEAD"]' in result.output


def test_origin_option_is_normalised_and_checked(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3 = FakeS3(None)
    _use(monkeypatch, s3)
    _admin_file(relay_config.parent)
    base = ["relay", "bucket-setup", "--config", str(relay_config)]
    ok = runner.invoke(app, [*base, "--origin", "https://Share.Example.Test/"])
    assert ok.exit_code == 0, ok.output
    assert s3.rules == cors_rule("https://share.example.test")
    for bad in ("https://share.example.test/app", "*", "https://*.example.test"):
        result = runner.invoke(app, [*base, "--origin", bad])
        assert result.exit_code == 2
        assert "Invalid origin" in result.output
    assert len(s3.puts) == 1


def test_a_loopback_public_base_url_is_refused_unless_origin_is_given(
    tmp_path: Path, relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3 = FakeS3(None)
    _use(monkeypatch, s3)
    _admin_file(relay_config.parent)
    text = relay_config.read_text(encoding="utf-8").replace(f"public_base_url: {ORIGIN}\n", "")
    relay_config.write_text(text, encoding="utf-8")
    base = ["relay", "bucket-setup", "--config", str(relay_config)]
    refused = runner.invoke(app, base)
    assert refused.exit_code == 2
    assert "loopback" in refused.output
    assert s3.puts == []
    assert runner.invoke(app, [*base, "--origin", ORIGIN]).exit_code == 0


def test_the_added_message_and_expose_note(
    relay_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    short = [{**cors_rule(ORIGIN)[0], "ExposeHeaders": []}]
    _use(monkeypatch, FakeS3(short))
    _admin_file(relay_config.parent)
    result = runner.invoke(app, ["relay", "bucket-setup", "--config", str(relay_config)])
    assert result.exit_code == 0
    assert "Nothing changed" in result.output
    assert "does not expose" in result.output
