from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import cast

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.distribution import (
    DistributionProfileError,
    compact_product_name,
    distribution_profile_from_mapping,
    load_distribution_profile,
    runtime_distribution_metadata,
    tauri_distribution_overlay,
)
from podcast_mcp.services.config_check import ConfigMode, run_config_checks

ROOT = Path(__file__).resolve().parents[1]


def _valid_profile() -> dict[str, object]:
    return {
        "version": 1,
        "product_name": "Example Studio",
        "bundle_identifier": "test.example.studio",
        "deep_link_schemes": ["example-studio"],
        "allowed_https_share_origins": ["https://share.example.test"],
        "support_url": "https://support.example.test",
        "privacy_url": "https://www.example.test/privacy",
        "repository_url": "https://code.example.test/repo",
        "release_manifest_url": "https://download.example.test/latest.json",
        "bootstrap_cdn_base": None,
    }


def test_development_profile_generates_checked_in_tauri_identity() -> None:
    profile = load_distribution_profile()
    overlay = tauri_distribution_overlay(profile)
    tauri = json.loads(
        (ROOT / "gui" / "desktop" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )
    assert tauri["productName"] == overlay["productName"]
    assert tauri["identifier"] == overlay["identifier"]
    assert tauri["plugins"]["deep-link"] == overlay["plugins"]["deep-link"]


def test_runtime_distribution_metadata_accepts_only_public_https_values() -> None:
    metadata = runtime_distribution_metadata(
        {
            "PODCAST_DISTRIBUTION_SUPPORT_URL": "https://support.example.test/help",
            "PODCAST_DISTRIBUTION_PRIVACY_URL": "http://privacy.example.test",
            "PODCAST_DISTRIBUTION_REPOSITORY_URL": "https://127.0.0.1/repository",
            "PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL": "https://downloads.example.test/latest.json",
        }
    )
    assert metadata.support_url == "https://support.example.test/help"
    assert metadata.privacy_url == "https://github.com/calebn/sharecut-studio/blob/main/PRIVACY.md"
    assert metadata.repository_url == "https://github.com/calebn/sharecut-studio"
    assert metadata.release_manifest_url == "https://downloads.example.test/latest.json"


def test_runtime_distribution_metadata_falls_closed_for_missing_or_invalid_release_url() -> None:
    metadata = runtime_distribution_metadata(
        {"PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL": "http://downloads.example.test"}
    )
    assert metadata.release_manifest_url is None


def test_distribution_profile_normalizes_urls_used_by_overlay_and_runtime_metadata() -> None:
    raw = _valid_profile()
    raw["allowed_https_share_origins"] = [" HTTPS://Share.Example.Test/ "]
    raw["support_url"] = " HTTPS://Support.Example.Test/help/ "
    raw["privacy_url"] = "HTTPS://WWW.Example.Test/privacy/"
    raw["repository_url"] = "HTTPS://Code.Example.Test/repo/"
    raw["release_manifest_url"] = "HTTPS://Download.Example.Test/latest.json/"

    profile = distribution_profile_from_mapping(raw)
    overlay = tauri_distribution_overlay(profile)

    assert profile.allowed_https_share_origins == ("https://share.example.test",)
    assert overlay["plugins"]["deep-link"]["mobile"][0]["host"] == "share.example.test"
    assert profile.support_url == "https://support.example.test/help"
    assert profile.privacy_url == "https://www.example.test/privacy"
    assert profile.repository_url == "https://code.example.test/repo"
    assert profile.release_manifest_url == "https://download.example.test/latest.json"


def test_rust_distribution_constants_use_the_validated_normalized_profile(tmp_path: Path) -> None:
    raw = _valid_profile()
    raw["allowed_https_share_origins"] = [" HTTPS://Share.Example.Test/ "]
    raw["support_url"] = " HTTPS://Support.Example.Test/help/ "
    raw["privacy_url"] = "HTTPS://WWW.Example.Test/privacy/"
    raw["repository_url"] = "HTTPS://Code.Example.Test/repo/"
    raw["release_manifest_url"] = "HTTPS://Download.Example.Test/latest.json/"
    profile_path = tmp_path / "distribution.json"
    profile_path.write_text(json.dumps(raw), encoding="utf-8")
    target_dir = tmp_path / "target"
    env = os.environ | {
        "PODCAST_DISTRIBUTION_PROFILE": str(profile_path),
        "CARGO_TARGET_DIR": str(target_dir),
    }

    completed = subprocess.run(
        [
            "cargo",
            "check",
            "--manifest-path",
            "gui/desktop/src-tauri/Cargo.toml",
            "--no-default-features",
        ],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    generated = next(target_dir.glob("debug/build/sharecut-*/out/distribution.rs"))
    constants = generated.read_text(encoding="utf-8")

    assert 'ALLOWED_HTTPS_SHARE_ORIGINS: &[&str] = &["https://share.example.test"]' in constants
    assert 'SUPPORT_URL: &str = "https://support.example.test/help"' in constants
    assert 'PRIVACY_URL: &str = "https://www.example.test/privacy"' in constants
    assert 'REPOSITORY_URL: &str = "https://code.example.test/repo"' in constants
    assert (
        'RELEASE_MANIFEST_URL: Option<&str> = Some("https://download.example.test/latest.json")'
        in constants
    )


@pytest.mark.parametrize(
    "value",
    [
        "https://[2001:db8::1",
        "https://example.test:99999/path",
        "https://example.test\uff0fpath",
    ],
)
def test_distribution_profile_converts_url_parser_failures_to_validation_errors(value: str) -> None:
    raw = _valid_profile()
    raw["support_url"] = value

    with pytest.raises(DistributionProfileError, match="absolute HTTPS URL"):
        distribution_profile_from_mapping(raw)


def test_runtime_distribution_metadata_falls_back_when_url_parsing_fails() -> None:
    metadata = runtime_distribution_metadata(
        {
            "PODCAST_DISTRIBUTION_SUPPORT_URL": "https://[2001:db8::1",
            "PODCAST_DISTRIBUTION_PRIVACY_URL": "https://example.test:99999/privacy",
            "PODCAST_DISTRIBUTION_REPOSITORY_URL": "https://example.test\uff0frepository",
        }
    )

    assert metadata.support_url == "https://github.com/calebn/sharecut-studio/issues"
    assert metadata.privacy_url == "https://github.com/calebn/sharecut-studio/blob/main/PRIVACY.md"
    assert metadata.repository_url == "https://github.com/calebn/sharecut-studio"


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("allowed_https_share_origins", ["http://share.example.test"], "absolute HTTPS"),
        ("allowed_https_share_origins", ["https://share.example.test/path"], "without port"),
        ("allowed_https_share_origins", ["https://share.example.test:8443"], "without port"),
        ("allowed_https_share_origins", ["https://share.example.test?x=1"], "query"),
        ("deep_link_schemes", ["https"], "invalid custom"),
        ("bundle_identifier", "one-part", "reverse-DNS"),
        ("product_name", "Injected\nName", "control characters"),
    ],
)
def test_distribution_profile_rejects_unsafe_identity(
    field: str, value: object, message: str
) -> None:
    raw = _valid_profile()
    raw[field] = value
    with pytest.raises(DistributionProfileError, match=message):
        distribution_profile_from_mapping(raw)


def test_distribution_profile_rejects_secret_shaped_fields() -> None:
    raw = _valid_profile()
    raw["signing_password"] = "never-commit-me"
    with pytest.raises(DistributionProfileError, match="looks like a secret") as caught:
        distribution_profile_from_mapping(raw)
    assert "never-commit-me" not in str(caught.value)


def test_tauri_overlay_preserves_exact_hosts_and_custom_schemes() -> None:
    overlay = tauri_distribution_overlay(distribution_profile_from_mapping(_valid_profile()))
    deep = overlay["plugins"]["deep-link"]
    assert deep["desktop"]["schemes"] == ["example-studio"]
    assert deep["mobile"][0]["host"] == "share.example.test"
    assert deep["mobile"][0]["pathPrefix"] == ["/r/", "/rec/"]


def test_compact_product_name_is_shared_build_and_release_identity() -> None:
    profile = distribution_profile_from_mapping(_valid_profile())
    assert compact_product_name(profile) == "ExampleStudio"


def test_generator_check_only_uses_the_same_validator(tmp_path: Path) -> None:
    path = tmp_path / "distribution.json"
    path.write_text(json.dumps(_valid_profile()), encoding="utf-8")
    script = ROOT / "scripts" / "generate_distribution_config.py"
    valid = subprocess.run(
        [sys.executable, str(script), "--profile", str(path), "--check-only"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert valid.returncode == 0
    raw = _valid_profile()
    raw["host_token"] = "must-not-leak"
    path.write_text(json.dumps(raw), encoding="utf-8")
    invalid = subprocess.run(
        [sys.executable, str(script), "--profile", str(path), "--check-only"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert invalid.returncode != 0
    assert "looks like a secret" in invalid.stderr
    assert "must-not-leak" not in invalid.stderr


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("version", 2, "version must be 1"),
        ("product_name", "", "1-64 characters"),
        ("deep_link_schemes", "example", "must be an array"),
        ("allowed_https_share_origins", "https://share.example.test", "must be an array"),
        ("support_url", "https://user@example.test", "user information"),
        ("privacy_url", "https://127.0.0.1/privacy", "public host"),
    ],
)
def test_distribution_profile_rejects_malformed_fields(
    field: str, value: object, message: str
) -> None:
    raw = _valid_profile()
    raw[field] = value
    with pytest.raises(DistributionProfileError, match=message):
        distribution_profile_from_mapping(raw)


def test_distribution_profile_rejects_unknown_fields_and_orphan_scheme() -> None:
    raw = _valid_profile()
    raw["unexpected"] = True
    with pytest.raises(DistributionProfileError, match="unknown distribution profile fields"):
        distribution_profile_from_mapping(raw)

    raw = _valid_profile()
    raw["allowed_https_share_origins"] = []
    with pytest.raises(DistributionProfileError, match="require at least one"):
        distribution_profile_from_mapping(raw)


def test_load_distribution_profile_rejects_invalid_json_shapes(tmp_path: Path) -> None:
    path = tmp_path / "distribution.json"
    path.write_text("{", encoding="utf-8")
    with pytest.raises(DistributionProfileError, match="cannot parse"):
        load_distribution_profile(path)
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(DistributionProfileError, match="must be a JSON object"):
        load_distribution_profile(path)


def test_config_check_modes_and_secret_redaction(tmp_path: Path) -> None:
    runner = CliRunner()
    local = runner.invoke(app, ["config", "check", "--mode", "local"])
    assert local.exit_code == 0
    assert "needs no relay" in local.output

    relay = tmp_path / "relay.yaml"
    relay.write_text(
        "relay_url: wss://relay.example.test/tunnel\npublic_base_url: https://share.example.test\n",
        encoding="utf-8",
    )
    missing = runner.invoke(
        app,
        ["config", "check", "--mode", "self-hosted", "--relay-config", str(relay)],
    )
    assert missing.exit_code == 1
    assert "requires PODCAST_RELAY_HOST_TOKEN" in missing.output

    relay.write_text(relay.read_text(encoding="utf-8") + "host_token: hidden-value\n")
    valid = runner.invoke(
        app,
        ["config", "check", "--mode", "self-hosted", "--relay-config", str(relay)],
    )
    assert valid.exit_code == 0
    assert "hidden-value" not in valid.output
    assert "credentials redacted" not in valid.output


def test_local_config_check_does_not_require_checkout_distribution_profile(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Installed wheels do not include the contributor development profile."""
    monkeypatch.setattr(
        "podcast_mcp.distribution.default_distribution_profile_path",
        lambda: tmp_path / "config" / "distribution.dev.json",
    )

    report = run_config_checks("local")

    assert report.passed is True
    assert any("not required for local mode" in check.message for check in report.checks)


def test_config_check_treats_all_loopback_relay_addresses_as_local(tmp_path: Path) -> None:
    relay = tmp_path / "relay.yaml"
    relay.write_text("relay_url: ws://127.0.0.2:8080/tunnel\n", encoding="utf-8")

    report = run_config_checks("self-hosted", relay_config=relay)

    assert report.passed is True
    assert any("loopback development" in check.message for check in report.checks)


def test_distributor_mode_requires_release_manifest(tmp_path: Path) -> None:
    raw = _valid_profile()
    raw["release_manifest_url"] = None
    path = tmp_path / "distribution.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    result = CliRunner().invoke(
        app,
        [
            "config",
            "check",
            "--mode",
            "distributor",
            "--distribution-profile",
            str(path),
        ],
    )
    assert result.exit_code == 1
    assert "release_manifest_url" in result.output


def test_config_check_reports_invalid_files_without_secrets(tmp_path: Path) -> None:
    invalid_profile = tmp_path / "distribution.json"
    invalid_profile.write_text("{", encoding="utf-8")
    local = run_config_checks("local", distribution_profile=invalid_profile)
    assert local.passed is False
    assert any("development profile" in check.message for check in local.checks)

    invalid_relay = tmp_path / "relay.yaml"
    invalid_relay.write_text("host_token: hidden\nrelay_url: http://bad.example\n")
    hosted = run_config_checks("self-hosted", relay_config=invalid_relay)
    assert hosted.passed is False
    assert all("hidden" not in check.message for check in hosted.checks)

    distributor = run_config_checks("distributor", distribution_profile=invalid_profile)
    assert distributor.passed is False
    assert any("cannot parse distribution profile" in check.message for check in distributor.checks)


def test_config_check_reports_object_store_and_distributor_cdn(tmp_path: Path) -> None:
    relay = tmp_path / "relay.yaml"
    relay.write_text(
        "relay_url: wss://relay.example.test/tunnel\n"
        "host_token: host-secret\n"
        "public_base_url: https://share.example.test\n"
        "object_store:\n"
        "  endpoint_url: https://s3.example.test\n"
        "  region: region-1\n"
        "  bucket: media\n"
        "  access_key_id: key\n"
        "  secret_access_key: secret\n",
        encoding="utf-8",
    )
    hosted = run_config_checks("self-hosted", relay_config=relay)
    assert hosted.passed is True
    assert any("credentials redacted" in check.message for check in hosted.checks)

    raw = _valid_profile()
    raw["bootstrap_cdn_base"] = "https://cdn.example.test/assets"
    profile = tmp_path / "distribution.json"
    profile.write_text(json.dumps(raw), encoding="utf-8")
    distributor = run_config_checks("distributor", distribution_profile=profile)
    assert distributor.passed is True
    assert any("bootstrap CDN configured" in check.message for check in distributor.checks)


def test_config_check_rejects_distributor_without_origins_and_unknown_mode(tmp_path: Path) -> None:
    raw = _valid_profile()
    raw["deep_link_schemes"] = []
    raw["allowed_https_share_origins"] = []
    profile = tmp_path / "distribution.json"
    profile.write_text(json.dumps(raw), encoding="utf-8")
    distributor = run_config_checks("distributor", distribution_profile=profile)
    assert distributor.passed is False
    assert any("exact allowed HTTPS share origin" in check.message for check in distributor.checks)

    with pytest.raises(ValueError, match="unsupported config mode"):
        run_config_checks(cast(ConfigMode, "unknown"))
