"""The committed iOS project template and overlay carry what the embedded engine needs."""

from __future__ import annotations

import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
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


def test_nested_framework_plists_are_fixed_and_resigned_after_install_python() -> None:
    install = TEMPLATE.index("install_python ../../ios-payload")
    fix = TEMPLATE.index('python3 -I "$FW_TOOL" fix "$CODESIGNING_FOLDER_PATH"')
    assert install < fix < TEMPLATE.index("/usr/bin/codesign --force --sign", fix)
    assert "scripts/ios/framework_plists.py" in TEMPLATE
    assert "for FW in $GENERATED; do" in TEMPLATE
    assert "--preserve-metadata=identifier" not in TEMPLATE


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


def test_the_plist_declares_no_non_exempt_encryption_and_the_name_comes_from_the_profile() -> None:
    assert "        ITSAppUsesNonExemptEncryption: false\n" in TEMPLATE
    assert "CFBundleDisplayName" not in TEMPLATE
    assert "      PRODUCT_NAME: {{app.stylized-name}}\n" in TEMPLATE
    assert OVERLAY["bundle"]["iOS"]["minimumSystemVersion"] == "17.0"


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


def phase_script() -> str:
    start = TEMPLATE.index("      - script: |\n          set -e\n")
    end = TEMPLATE.index("        name: Process Python libraries")
    lines = TEMPLATE[start:end].splitlines()[1:]
    return "\n".join(line[10:] for line in lines) + "\n"


def run_phase(tmp_path: Path, plists: dict[str, dict[str, object]], valid: set[str]):
    gen = tmp_path / "gui/desktop/src-tauri/gen/apple"
    gen.mkdir(parents=True)
    build = tmp_path / "gui/desktop/src-tauri/ios-payload/Python.xcframework/build"
    build.mkdir(parents=True)
    (build / "utils.sh").write_text("install_python() { :; }\n", encoding="utf-8")
    tool = tmp_path / "scripts/ios"
    tool.mkdir(parents=True)
    (tool / "framework_plists.py").symlink_to(ROOT / "scripts/ios/framework_plists.py")
    app = tmp_path / "ShareCut.app"
    app.mkdir()
    (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "studio.sharecut.app"}))
    for name, plist in plists.items():
        folder = app / "Frameworks" / f"{name}.framework"
        folder.mkdir(parents=True)
        (folder / name).write_bytes(b"x")
        (folder / "Info.plist").write_bytes(plistlib.dumps(plist))
    log = tmp_path / "codesign.log"
    stub = tmp_path / "codesign"
    stub.write_text(
        '#!/bin/sh\necho "$@" >> "$LOG"\n'
        'if [ "$1" = --verify ]; then\n'
        '  case "$3" in *"$VALID") exit 0;; esac\n  exit 1\nfi\n',
        encoding="utf-8",
    )
    stub.chmod(0o755)
    shim = tmp_path / "bin"
    shim.mkdir()
    (shim / "python3").write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n', encoding="utf-8")
    (shim / "python3").chmod(0o755)
    script = phase_script().replace("/usr/bin/codesign", str(stub))
    env = {
        "PATH": f"{shim}:/usr/bin:/bin",
        "PROJECT_DIR": str(gen),
        "CODESIGNING_FOLDER_PATH": str(app),
        "EXPANDED_CODE_SIGN_IDENTITY": "ID",
        "LOG": str(log),
        "VALID": "|".join(valid) or "none-valid",
    }
    result = subprocess.run(
        ["bash", "-c", script], env=env, capture_output=True, text=True, check=False
    )
    calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    return result, calls, app


def appl(name: str) -> dict[str, object]:
    return {
        "CFBundleExecutable": name,
        "CFBundleIdentifier": f"studio.sharecut.app.{name.replace('_', '-')}",
        "CFBundlePackageType": "APPL",
    }


def test_the_phase_verifies_generated_frameworks_and_resigns_only_stale_ones(
    tmp_path: Path,
) -> None:
    python: dict[str, object] = {
        "CFBundleExecutable": "Python",
        "CFBundleIdentifier": "org.python.python",
        "CFBundlePackageType": "FMWK",
    }
    result, calls, app = run_phase(
        tmp_path,
        {"mod_a": appl("mod_a"), "mod_b": appl("mod_b"), "Python": python},
        valid={"mod_b.framework"},
    )
    assert result.returncode == 0, result.stderr
    target_a = f"{app}/Frameworks/mod_a.framework"
    target_b = f"{app}/Frameworks/mod_b.framework"
    assert [c for c in calls if "--verify" in c] == [
        f"--verify --strict {target_a}",
        f"--verify --strict {target_b}",
    ]
    forced = [c for c in calls if "--force" in c]
    assert len(forced) == 1 and forced[0].endswith(f"--generate-entitlement-der {target_a}")
    assert "--preserve-metadata=entitlements,flags" in forced[0]
    assert not any("Python.framework" in c for c in calls)


def test_a_failing_fix_aborts_the_phase_before_any_codesign(tmp_path: Path) -> None:
    bad = appl("bad!name")
    result, calls, _ = run_phase(tmp_path, {"bad!name": bad, "mod_a": appl("mod_a")}, valid=set())
    assert result.returncode != 0
    assert calls == []


def test_the_phase_runs_with_errexit() -> None:
    assert phase_script().startswith("set -e\n")


def app_target_block() -> str:
    return TEMPLATE[TEMPLATE.index("targets:\n  {{app.name}}_iOS:\n") :]


def test_the_app_target_has_exactly_one_settings_mapping_with_a_base_block() -> None:
    block = app_target_block()
    assert block.count("\n    settings:\n") == 1
    assert block.count("\n      base:\n") == 1
    assert TEMPLATE.count("\n  {{app.name}}_iOS:\n") == 1
    assert TEMPLATE.count("targets:\n") == 1
    assert [line for line in TEMPLATE.splitlines() if line.startswith("settings:")] == []


def test_the_app_target_base_settings_are_exactly_these_keys_in_order() -> None:
    block = app_target_block()
    start = block.index("    settings:\n      base:\n") + len("    settings:\n      base:\n")
    end = block.index("      groups: [app]\n", start)
    keys = [line.split(":", 1)[0].strip() for line in block[start:end].splitlines()]
    assert keys == [
        "ENABLE_BITCODE",
        "ENABLE_USER_SCRIPT_SANDBOXING",
        "ARCHS",
        "VALID_ARCHS",
        "LIBRARY_SEARCH_PATHS[arch=x86_64]",
        "LIBRARY_SEARCH_PATHS[arch=arm64]",
        "ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES",
        "EXCLUDED_ARCHS[sdk=iphoneos*]",
        "OTHER_LDFLAGS",
    ]
    assert block[start:end].count("        ENABLE_BITCODE: false\n") == 1
    assert "        ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES: true\n" in block[start:end]
    assert "        EXCLUDED_ARCHS[sdk=iphoneos*]: x86_64\n" in block[start:end]


def test_the_template_sets_no_dead_strip_override() -> None:
    for name in ("DEAD_CODE_STRIPPING", "STRIP_STYLE"):
        assert name not in TEMPLATE
    assert TEMPLATE.count("groups: [app]") == 2


def test_the_app_exports_its_native_ffmpeg_symbols_from_the_target_base_block() -> None:
    targets = TEMPLATE[TEMPLATE.index("\ntargets:") :]
    assert targets.count("\n    settings:\n") == 1
    base = targets[
        targets.index("    settings:\n      base:\n") : targets.index("      groups: [app]")
    ]
    assert base.count('OTHER_LDFLAGS: ["$(inherited)", "-Wl,-export_dynamic"]') == 1
    assert TEMPLATE.count("OTHER_LDFLAGS") == 1
    assert TEMPLATE.count("-Wl,") == 1
