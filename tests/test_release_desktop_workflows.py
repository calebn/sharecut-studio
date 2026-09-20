"""Release-desktop reusable workflow: workflow_call inputs/secrets, no secret log leaks."""

from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / ".github/workflows/release-desktop-build.yml"

REQUIRED_SECRETS = (
    "SOURCE_REPOSITORY_SSH_KEY",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_P8",
    "WINDOWS_SIGN_CERT_PFX_B64",
    "WINDOWS_SIGN_CERT_PASSWORD",
)


def _load(path: Path) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    # PyYAML 1.1 treats `on` as boolean True; GitHub Actions keys are strings.
    if True in data and "on" not in data:
        data["on"] = data.pop(True)
    return data


def test_reusable_workflow_declares_call_inputs_and_secrets() -> None:
    data = _load(BUILD)
    assert data["name"] == "release-desktop-build"
    call = data["on"]["workflow_call"]
    inputs = call["inputs"]
    assert inputs["version"]["type"] == "string"
    assert inputs["sign"]["type"] == "boolean"
    assert inputs["sign"]["default"] is False
    assert inputs["distribution_profile_json"]["type"] == "string"
    assert inputs["distribution_profile_json"]["default"] == ""
    assert inputs["extension_artifact_name"] == {
        "description": "Private artifact containing an extension wheel (empty = no extension runtime)",
        "type": "string",
        "required": False,
        "default": "",
    }
    assert inputs["extension_wheel_sha256"] == {
        "description": "SHA-256 of the private extension wheel (required with extension artifact)",
        "type": "string",
        "required": False,
        "default": "",
    }
    secrets = call["secrets"]
    for name in REQUIRED_SECRETS:
        assert name in secrets
        assert secrets[name].get("required") is not True
    assert "APPLE_CERTIFICATE" in secrets
    assert "APPLE_CERTIFICATE_PASSWORD" in secrets
    assert not any(name.startswith("PODCAST_OBJECT_STORE_") for name in secrets)
    job = data["jobs"]["bundle"]
    oses = {row["os"] for row in job["strategy"]["matrix"]["include"]}
    assert oses == {"ubuntu-22.04", "windows-latest", "macos-15-intel"}
    assert {row["triple"] for row in job["strategy"]["matrix"]["include"]} == {
        "x86_64-unknown-linux-gnu",
        "x86_64-pc-windows-msvc",
        "x86_64-apple-darwin",
    }
    assert job["environment"] == (
        "${{ needs.verify-source.outputs.trusted == 'true' && inputs.sign && "
        "matrix.bundle != 'appimage' && 'desktop-signing' || '' }}"
    )
    assert job["needs"] == ["verify-source", "prepare-extension-runtime"]
    assert "inputs.extension_artifact_name == ''" in job["if"]
    steps = {step.get("name") for step in job["steps"] if "name" in step}
    assert "Resolve signing flags" in steps
    assert "Require signing when requested" in steps
    assert "Configure distribution profile" in steps
    assert "Import Apple signing material" in steps
    assert "Sign Windows sidecar" in steps
    assert "Sign Windows NSIS installer" in steps
    assert "Verify Apple signature" in steps
    assert "Clean up Apple keychain" in steps
    assert "Clean up Windows signing material" in steps
    assert "Signing summary" in steps


def test_extension_wheel_freeze_isolated_from_signing_jobs() -> None:
    data = _load(BUILD)
    prepare = data["jobs"]["prepare-extension-runtime"]
    bundle = data["jobs"]["bundle"]

    assert prepare["if"] == "inputs.extension_artifact_name != ''"
    assert prepare["needs"] == "verify-source"
    assert prepare["permissions"] == {}
    assert "environment" not in prepare
    prepare_checkout = prepare["steps"][0]
    assert prepare_checkout["with"]["ssh-key"] == "${{ secrets.SOURCE_REPOSITORY_SSH_KEY }}"
    assert prepare_checkout["with"]["persist-credentials"] is False
    assert "secrets." not in str(prepare["steps"][1:])
    assert {row["os"] for row in prepare["strategy"]["matrix"]["include"]} == {
        "ubuntu-22.04",
        "windows-latest",
        "macos-15-intel",
    }

    prepare_steps = prepare["steps"]
    prepare_names = [step.get("name") for step in prepare_steps]
    download = next(
        step for step in prepare_steps if step.get("name") == "Download private extension wheel"
    )
    verify = next(
        step
        for step in prepare_steps
        if step.get("name") == "Verify private extension wheel integrity"
    )
    freeze = next(
        step
        for step in prepare_steps
        if step.get("name") == "Freeze extension sidecar without credentials"
    )
    assert download["with"]["name"] == "${{ inputs.extension_artifact_name }}"
    assert verify["env"]["EXPECTED_EXTENSION_WHEEL_SHA256"] == (
        "${{ inputs.extension_wheel_sha256 }}"
    )
    assert "hashlib.sha256" in verify["run"]
    assert "hmac.compare_digest" in verify["run"]
    assert "exactly one top-level wheel" in verify["run"]
    assert ".iterdir()" in verify["run"]
    assert "nested_wheels" in verify["run"]
    assert "--extension-wheels-dir" in freeze["run"]
    assert "--no-deps" in (ROOT / "scripts" / "build_sidecar.py").read_text(encoding="utf-8")
    assert (
        prepare_names.index("Verify private extension wheel integrity")
        < prepare_names.index("Freeze extension sidecar without credentials")
        < prepare_names.index("Upload prepared extension sidecar")
    )
    stage = next(
        step for step in prepare_steps if step.get("name") == "Stage prepared extension sidecar"
    )
    upload = next(
        step for step in prepare_steps if step.get("name") == "Upload prepared extension sidecar"
    )
    assert 'archive_root="$RUNNER_TEMP"' in stage["run"]
    assert 'archive_root="$(cygpath -u "$RUNNER_TEMP")"' in stage["run"]
    assert 'tar -C "$stage" -cf "$archive" .' in stage["run"]
    assert "extension-entry-points.json" in stage["run"]
    assert "distributions(path=[str(site_packages)])" in stage["run"]
    assert upload["with"]["path"].endswith("prepared-extension-sidecar.tar")

    bundle_names = [step.get("name") for step in bundle["steps"]]
    assert bundle["needs"] == ["verify-source", "prepare-extension-runtime"]
    assert "needs.prepare-extension-runtime.result == 'success'" in bundle["if"]
    assert bundle_names.index("Download prepared extension sidecar") < bundle_names.index(
        "Import Apple signing material"
    )
    restored = next(
        step
        for step in bundle["steps"]
        if step.get("name") == "Download prepared extension sidecar"
    )
    assert restored["with"]["name"] == "prepared-extension-sidecar-${{ matrix.bundle }}"
    assert restored["if"] == "inputs.extension_artifact_name != ''"
    assert restored["with"]["path"] == "${{ runner.temp }}/prepared-extension-sidecar"
    extract = next(
        step for step in bundle["steps"] if step.get("name") == "Restore prepared extension sidecar"
    )
    verify_runtime = next(
        step for step in bundle["steps"] if step.get("name") == "Verify prepared extension runtime"
    )
    assert 'archive_root="$RUNNER_TEMP"' in extract["run"]
    assert 'archive_root="$(cygpath -u "$RUNNER_TEMP")"' in extract["run"]
    assert (
        'archive="${archive_root}/prepared-extension-sidecar/prepared-extension-sidecar.tar"'
        in extract["run"]
    )
    assert 'tar -C gui/desktop/binaries -xf "$archive"' in extract["run"]
    assert ".freeze-complete" in verify_runtime["run"]
    assert "extension-entry-points.json" in verify_runtime["run"]
    assert "distributions(path=[str(site_packages)])" in verify_runtime["run"]
    assert '"$python" -c' not in verify_runtime["run"]
    assert (
        bundle_names.index("Restore prepared extension sidecar")
        < bundle_names.index("Verify prepared extension runtime")
        < bundle_names.index("Import Apple signing material")
    )
    no_extension_freeze = next(
        step for step in bundle["steps"] if step.get("name") == "Freeze sidecar"
    )
    assert "inputs.extension_artifact_name == ''" in no_extension_freeze["if"]
    resign = next(
        step for step in bundle["steps"] if step.get("name") == "Sign prepared macOS runtime"
    )
    assert "--codesign-only" in resign["run"]
    assert "inputs.extension_artifact_name != ''" in resign["if"]
    assert (
        bundle_names.index("Import Apple signing material")
        < bundle_names.index("Sign prepared macOS runtime")
        < bundle_names.index("Tauri bundle (macOS Intel app)")
    )


def test_workflows_do_not_echo_secret_expressions() -> None:
    for path in (BUILD,):
        text = path.read_text(encoding="utf-8")
        assert re.search(r"echo.*secrets\.", text) is None
        assert "set +x" in text


def test_signing_hooks_fail_closed_and_keep_artifact_names() -> None:
    text = BUILD.read_text(encoding="utf-8")
    job = _load(BUILD)["jobs"]["bundle"]
    names = [step.get("name") for step in job["steps"] if "name" in step]
    checkout_at = next(
        i
        for i, step in enumerate(job["steps"])
        if str(step.get("uses", "")).startswith("actions/checkout")
    )
    assert job["needs"] == ["verify-source", "prepare-extension-runtime"]
    assert job["steps"][checkout_at]["with"]["ref"] == (
        "${{ needs.verify-source.outputs.source_sha }}"
    )
    assert job["steps"][checkout_at].get("with", {}).get("persist-credentials") is False
    assert names.index("Install desktop CLI") < names.index("Import Apple signing material")
    assert names.index("Import Apple signing material") < names.index("Freeze sidecar")
    assert names.index("Freeze sidecar") < names.index("Tauri bundle (macOS Intel app)")
    assert names.index("Pack Intel DMG") < names.index("Verify Apple signature")
    assert "find-identity" not in text
    assert '/p "$WINDOWS_SIGN_CERT_PASSWORD"' not in text
    assert "steps.signing.outputs.apple == 'yes'" in text
    assert "steps.signing.outputs.windows == 'yes'" in text
    assert "!cancelled()" in text
    assert "sharecut-linux-appimage" in text
    assert "sharecut-windows-nsis" in text
    assert "sharecut-macos-x64-dmg" in text
    assert "name: ${{ matrix.artifact }}" in text
    assert (
        "if: ${{ needs.verify-source.outputs.trusted == 'true' && inputs.sign && "
        "matrix.bundle == 'nsis' && steps.signing.outputs.windows == 'yes' }}" in text
    )
    assert text.count("name: ${{ matrix.artifact }}") == 1
    assert "sign_windows_authenticode.sh" in text
    assert "signed: ${signed}" in text
    assert "signed=attempted" in text
    assert "job.status" in text
    assert "codesign --verify --deep --strict" in text
    assert "security delete-keychain" in text
    assert "APPLE_API_KEY_PATH" in text
    assert "${RUNNER_TEMP}/sharecut-signing.keychain-db" in text
    assert "sharecut-authenticode*.pfx" in text
    assert "sign=true but Apple signing secrets are incomplete" in text
    assert "sign=true but Windows signing secrets are incomplete" in text
    assert "40-character commit SHA" in text
    assert "calebn/sharecut-studio" in text
    assert "matrix.bundle != 'appimage'" in text
    assert "VERSION: ${{ inputs.version }}" in text
    assert "windows payload exe: unsigned" in text
    intel_step = next(s for s in job["steps"] if s.get("name") == "Tauri bundle (macOS Intel app)")
    intel_run = intel_step["run"]
    assert "APPLE_SIGN_ENABLED" in intel_run
    assert 'if [[ "${APPLE_SIGN_ENABLED}" == "yes" ]]; then' in intel_run
    assert '"$PODCAST_DISTRIBUTION_TAURI_CONFIG"' in intel_run
    assert '"$PODCAST_DISTRIBUTION_TAURI_UNSIGNED_CONFIG"' in intel_run
    windows_step = next(s for s in job["steps"] if s.get("name") == "Tauri bundle (Windows NSIS)")
    assert '"$PODCAST_DISTRIBUTION_TAURI_COMPACT_CONFIG"' in windows_step["run"]
    pack_step = next(s for s in job["steps"] if s.get("name") == "Pack Intel DMG")
    assert "bundle/macos/*.app" in pack_step["run"]
    assert "expected exactly one macOS app bundle" in pack_step["run"]
    for step in job["steps"]:
        run = step.get("run") or ""
        assert "${{ inputs.version }}" not in run
        assert "${{ inputs.source_ref }}" not in run
        assert "${{ inputs.source_repository }}" not in run
        assert "${{ inputs.distribution_profile_json }}" not in run


def test_prepared_runtime_tar_round_trip_preserves_markers_modes_and_symlinks(
    tmp_path: Path,
) -> None:
    stage = tmp_path / "stage"
    runtime = stage / "sharecut-runtime"
    interpreter = runtime / "venv" / "bin" / "python"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text("#!/bin/sh\n", encoding="utf-8")
    interpreter.chmod(interpreter.stat().st_mode | stat.S_IXUSR)
    (runtime / ".freeze-complete").write_text("ok\n", encoding="utf-8")
    (runtime / ".python-home").write_text("python/cpython-test\n", encoding="utf-8")
    (runtime / "python-link").symlink_to("venv/bin/python")
    archive = tmp_path / "prepared-extension-sidecar.tar"
    restored = tmp_path / "restored"
    restored.mkdir()

    subprocess.run(["tar", "-C", stage, "-cf", archive, "."], check=True)
    subprocess.run(["tar", "-C", restored, "-xf", archive], check=True)

    restored_runtime = restored / "sharecut-runtime"
    assert (restored_runtime / ".freeze-complete").read_text() == "ok\n"
    assert (restored_runtime / ".python-home").is_file()
    assert os.access(restored_runtime / "venv" / "bin" / "python", os.X_OK)
    assert (restored_runtime / "python-link").is_symlink()


def test_signing_secrets_are_only_injected_for_trusted_signed_builds() -> None:
    job = _load(BUILD)["jobs"]["bundle"]
    signing_secret_names = {
        "APPLE_SIGNING_IDENTITY",
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_TEAM_ID",
        "APPLE_API_KEY",
        "APPLE_API_ISSUER",
        "APPLE_API_KEY_P8",
        "WINDOWS_SIGN_CERT_PFX_B64",
        "WINDOWS_SIGN_CERT_PASSWORD",
    }
    trusted_and_signed = "needs.verify-source.outputs.trusted == 'true' && inputs.sign"

    secret_steps = []
    for step in job["steps"]:
        signing_env = set(step.get("env", {})) & signing_secret_names
        if not signing_env:
            continue
        secret_steps.append(step["name"])
        assert trusted_and_signed in step.get("if", "")
        for name in signing_env:
            assert step["env"][name] == f"${{{{ secrets.{name} }}}}"

    assert secret_steps == [
        "Resolve signing flags",
        "Import Apple signing material",
        "Sign Windows sidecar",
        "Sign Windows NSIS installer",
    ]


def test_source_trust_is_verified_before_any_repo_code_or_secrets() -> None:
    data = _load(BUILD)
    verify = data["jobs"]["verify-source"]
    assert verify["permissions"] == {"contents": "read"}
    assert verify["outputs"] == {
        "source_repository": "${{ steps.source.outputs.repository }}",
        "source_sha": "${{ steps.verify.outputs.source_sha }}",
        "trusted": "${{ steps.verify.outputs.trusted }}",
    }

    steps = verify["steps"]
    names = [step.get("name") for step in steps]
    coordinates_at = names.index("Validate source coordinates")
    checkout_at = names.index("Checkout candidate source")
    trust_at = names.index("Verify source reachable from protected main")
    assert coordinates_at < checkout_at < trust_at
    checkout = steps[checkout_at]
    assert checkout["uses"] == "actions/checkout@v6"
    assert checkout["with"]["fetch-depth"] == 0
    assert checkout["with"]["persist-credentials"] is False
    assert checkout["with"]["ssh-key"] == "${{ secrets.SOURCE_REPOSITORY_SSH_KEY }}"

    trust = steps[trust_at]
    trust_run = trust["run"]
    assert "git show-ref --verify --quiet refs/remotes/origin/main" in trust_run
    assert "git fetch" not in trust_run
    assert 'git merge-base --is-ancestor "$candidate" origin/main' in trust_run
    assert "trusted=false" in trust_run
    assert "printf 'trusted=%s\\n' \"$trusted\"" in trust_run
    assert "scripts/" not in trust_run
    assert "npm " not in trust_run
    assert "uv " not in trust_run
    assert "secrets." not in str(steps[checkout_at + 1 :])

    bundle = data["jobs"]["bundle"]
    assert bundle["needs"] == ["verify-source", "prepare-extension-runtime"]
    assert "needs.verify-source.outputs.trusted == 'true'" in bundle["environment"]
    signing_guard = bundle["steps"][0]
    assert signing_guard["name"] == "Require trusted source for signing"
    assert signing_guard["if"] == (
        "${{ inputs.sign && needs.verify-source.outputs.trusted != 'true' }}"
    )
    assert "source commit reachable from protected main" in signing_guard["run"]
    bundle_checkout = bundle["steps"][1]
    assert bundle_checkout["uses"] == "actions/checkout@v6"
    assert bundle_checkout["with"]["ref"] == ("${{ needs.verify-source.outputs.source_sha }}")
    assert bundle_checkout["with"]["repository"] == (
        "${{ needs.verify-source.outputs.source_repository }}"
    )
    assert bundle_checkout["with"]["ssh-key"] == "${{ secrets.SOURCE_REPOSITORY_SSH_KEY }}"

    assert "upload-cdn" not in data["jobs"]


def test_distribution_profile_input_is_validated_before_build() -> None:
    job = _load(BUILD)["jobs"]["bundle"]
    configure = next(
        step for step in job["steps"] if step.get("name") == "Configure distribution profile"
    )
    assert configure["env"]["DISTRIBUTION_PROFILE_JSON"] == (
        "${{ inputs.distribution_profile_json }}"
    )
    run = configure["run"]
    assert "set +x" in run
    assert "generate_distribution_config.py" in run
    assert "--check-only" not in run
    assert '--output "$overlay"' in run
    assert '--output "$compact_overlay"' in run
    assert "--compact-product-name" in run
    assert '["signingIdentity"] = None' in run
    assert "PODCAST_DISTRIBUTION_PROFILE=" in run
    assert "PODCAST_DISTRIBUTION_TAURI_CONFIG=" in run
    assert "PODCAST_DISTRIBUTION_TAURI_COMPACT_CONFIG=" in run
    assert "PODCAST_DISTRIBUTION_TAURI_UNSIGNED_CONFIG=" in run


def test_windows_authenticode_script_signs_by_thumbprint() -> None:
    script = ROOT / "scripts/sign_windows_authenticode.sh"
    text = script.read_text(encoding="utf-8")
    assert script.stat().st_mode & 0o111
    assert "Import-PfxCertificate" in text
    assert "/fd sha256" in text
    assert "/tr http://timestamp.digicert.com" in text
    assert "/td sha256" in text
    assert "/sha1" in text
    assert "verify /pa" in text
    assert '/p "$WINDOWS_SIGN_CERT_PASSWORD"' not in text
    assert "Remove-Item" in text
    assert "--verify" in text
    assert "trap cleanup EXIT" in text
    assert "trap cleanup EXIT" in text.split("printf '%s' \"$WINDOWS_SIGN_CERT_PFX_B64\"")[0]


def test_public_reusable_workflow_has_no_hosted_release_operations() -> None:
    text = BUILD.read_text(encoding="utf-8")
    data = _load(BUILD)
    assert set(data["jobs"]) == {"verify-source", "prepare-extension-runtime", "bundle"}
    assert "PODCAST_OBJECT_STORE_" not in text
    assert "upload_release" not in text
    assert "deploy/download" not in text
    assert "peter-evans/create-pull-request" not in text
    assert "contents: write" not in text
    assert "pull-requests: write" not in text
