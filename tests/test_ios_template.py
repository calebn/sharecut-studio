"""The committed iOS project template and overlay carry what the embedded engine needs."""

from __future__ import annotations

import json
import re
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
    assert "CODE_SIGN_IDENTITY" not in TEMPLATE
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


def test_the_failure_sentence_does_not_repeat_the_retry_control() -> None:
    lifecycle = (TAURI / "src/lifecycle.rs").read_text(encoding="utf-8")
    assert 'Self::StartError(_) => "ShareCut couldn\'t start on this device."' in lifecycle
    assert 'Self::StartTimedOut => "ShareCut took too long to start."' in lifecycle
    assert 'Try again."' not in lifecycle
