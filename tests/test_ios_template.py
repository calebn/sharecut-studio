"""The committed iOS project template and overlay carry what the embedded engine needs."""

from __future__ import annotations

import json
import os
import plistlib
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "gui/desktop/src-tauri"
TEMPLATE = (TAURI / "ios/project.yml").read_text(encoding="utf-8")
OVERLAY = json.loads((TAURI / "tauri.ios.conf.json").read_text(encoding="utf-8"))


def test_python_xcframework_is_linked_embedded_and_signed() -> None:
    assert (
        "      - framework: ../../ios-payload/Python.xcframework\n"
        "        embed: true\n"
        "        codeSign: true\n"
        "        link: true\n"
    ) in TEMPLATE


def test_the_payload_folder_is_a_bundle_resource_outside_gen() -> None:
    assert (
        "      - path: ../../ios-payload/app_packages\n"
        "        buildPhase: resources\n"
        "        type: folder\n"
    ) in TEMPLATE


def test_every_binary_module_becomes_a_framework_after_the_build() -> None:
    assert "install_python ../../ios-payload/Python.xcframework app_packages" in TEMPLATE
    assert TEMPLATE.count("postBuildScripts:") == 1
    assert "ENABLE_USER_SCRIPT_SANDBOXING: NO" in TEMPLATE


def test_the_plist_lets_files_show_projects_and_loopback_work() -> None:
    for line in (
        "UIFileSharingEnabled: true",
        "LSSupportsOpeningDocumentsInPlace: true",
        "NSAllowsLocalNetworking: true",
    ):
        assert line in TEMPLATE


def test_the_template_never_names_a_team_or_certificate() -> None:
    assert "DEVELOPMENT_TEAM: {{apple.development-team}}" in TEMPLATE
    assert not re.search(r"DEVELOPMENT_TEAM:\s*[A-Z0-9]{10}\b", TEMPLATE)
    assert not re.search(r"(?<!EXPANDED_)CODE_SIGN_IDENTITY", TEMPLATE)
    assert "PROVISIONING_PROFILE" not in TEMPLATE


def test_the_overlay_has_no_sidecar_and_runs_the_payload_script() -> None:
    assert OVERLAY["bundle"]["externalBin"] is None
    assert OVERLAY["bundle"]["resources"] is None
    assert OVERLAY["bundle"]["iOS"] == {
        "minimumSystemVersion": "17.0",
        "template": "src-tauri/ios/project.yml",
    }
    assert OVERLAY["build"]["beforeBuildCommand"] == (
        "uv run --project ../.. --no-sync python ../../scripts/ios/build_payload.py --ensure"
    )
    assert "developmentTeam" not in OVERLAY["bundle"]["iOS"]


def test_the_splash_paints_one_canvas_over_the_whole_screen() -> None:
    splash = (TAURI.parent / "splash/index.html").read_text(encoding="utf-8")
    assert "viewport-fit=cover" in splash
    assert "      html {\n        background: var(--color-bg-canvas);\n      }\n" in splash
    assert "min-height: 100vh;\n        min-height: 100dvh;" in splash
    assert "max(var(--s1), env(safe-area-inset-bottom))" in splash


def test_the_retry_control_is_never_displayed_while_hidden() -> None:
    splash = (TAURI.parent / "splash/index.html").read_text(encoding="utf-8")
    assert '<a id="retry" class="retry" href="sharecut-retry:" hidden>' in splash
    style = re.search(r"<style>(.*?)</style>", splash, re.S)
    assert style is not None
    rules = re.findall(r"([^{}]+)\{([^{}]*)\}", style.group(1))
    displaying = [sel.strip() for sel, body in rules if "display:" in body and "retry" in sel]
    assert displaying == [".retry:not([hidden])"]


def test_the_simulator_script_ensures_the_payload_before_the_xcode_project_is_generated(
    tmp_path: Path,
) -> None:
    root = tmp_path / "checkout"
    script = root / "scripts/ios/ios_sim.sh"
    script.parent.mkdir(parents=True)
    shutil.copy(ROOT / "scripts/ios/ios_sim.sh", script)
    for module in ("gui/web", "gui/desktop"):
        (root / module / "node_modules").mkdir(parents=True)
    calls = tmp_path / "calls.log"
    fakes = tmp_path / "fakes"
    fakes.mkdir()
    for tool in ("uv", "npm"):
        shim = fakes / tool
        shim.write_text(f'#!/bin/sh\necho "{tool} $*" >> {calls}\necho "{fakes}"\n')
        shim.chmod(0o755)
    env = {**os.environ, "PATH": f"{fakes}{os.pathsep}{os.environ['PATH']}"}
    subprocess.run(["bash", str(script), "build"], env=env, check=True, capture_output=True)
    steps = calls.read_text().splitlines()
    ensure = next(i for i, s in enumerate(steps) if "build_payload.py --ensure" in s)
    init = next(i for i, s in enumerate(steps) if "ios init" in s)
    build = next(i for i, s in enumerate(steps) if "ios build" in s)
    assert ensure < init < build
    assert all("--sdk iphonesimulator" in s for s in steps if "build_payload.py" in s)


def test_a_release_build_keeps_builder_paths_out_of_the_rust_library() -> None:
    assert (
        '          if [ "${CONFIGURATION:?}" = release ]; then\n'
        '            eval "$(python3 "$PROJECT_DIR/../../../../../scripts/ios/private_paths.py" rust-env)"\n'
        "          fi\n"
    ) in TEMPLATE
    assert TEMPLATE.index("private_paths.py") < TEMPLATE.index("{{ shell-escape tauri-binary }}")


def test_an_unsigned_build_signs_the_python_frameworks_ad_hoc() -> None:
    assert (
        '          if [ -z "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then '
        "export EXPANDED_CODE_SIGN_IDENTITY=-; fi\n"
    ) in TEMPLATE


def test_the_plist_declares_the_name_under_the_icon_and_no_non_exempt_encryption() -> None:
    assert "        CFBundleDisplayName: ShareCut\n" in TEMPLATE
    assert "        ITSAppUsesNonExemptEncryption: false\n" in TEMPLATE
    assert OVERLAY["bundle"]["iOS"]["minimumSystemVersion"] == "17.0"


def test_the_plist_asks_for_no_microphone_until_recording_exists() -> None:
    assert (
        '          /usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" '
        '"$CODESIGNING_FOLDER_PATH/Info.plist" 2>/dev/null || true\n'
    ) in TEMPLATE
    assert "NSMicrophoneUsageDescription:" not in TEMPLATE


def test_the_privacy_manifest_ships_as_a_bundle_resource() -> None:
    assert (
        "      - path: ../../ios/PrivacyInfo.xcprivacy\n        buildPhase: resources\n"
    ) in TEMPLATE


def test_the_privacy_manifest_declares_the_required_reason_apis_the_binaries_call() -> None:
    manifest = plistlib.loads((TAURI / "ios/PrivacyInfo.xcprivacy").read_bytes())
    assert manifest == {
        "NSPrivacyTracking": False,
        "NSPrivacyTrackingDomains": [],
        "NSPrivacyCollectedDataTypes": [],
        "NSPrivacyAccessedAPITypes": [
            {
                "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
                "NSPrivacyAccessedAPITypeReasons": ["C617.1"],
            },
            {
                "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategorySystemBootTime",
                "NSPrivacyAccessedAPITypeReasons": ["35F9.1"],
            },
            {
                "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryDiskSpace",
                "NSPrivacyAccessedAPITypeReasons": ["E174.1"],
            },
        ],
    }
