"""Desktop pack scripts must not re-notarize on DMG retry."""

import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TAURI_CONF = ROOT / "gui/desktop/src-tauri/tauri.conf.json"


def test_desktop_build_notarizes_app_once_then_packs_dmg() -> None:
    text = (ROOT / "scripts/build_desktop.sh").read_text(encoding="utf-8")
    assert "npm run tauri -- build --bundles app" in text
    assert "pack_macos_dmg.sh" in text
    assert "npm run tauri -- build --bundles dmg" not in text


@pytest.mark.parametrize("script_name", ["build_desktop.sh", "build_linux_appimage.sh"])
def test_desktop_build_scripts_canonicalize_relative_profile_before_changing_directory(
    script_name: str,
) -> None:
    text = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")

    caller_at = text.index('CALLER_DIR="$PWD"')
    relative_at = text.index('DIST_PROFILE="$CALLER_DIR/$DIST_PROFILE"')
    canonical_at = text.index('pwd -P)/$(basename "$DIST_PROFILE")')
    chdir_at = text.index('cd "$ROOT"')
    export_at = text.index('export PODCAST_DISTRIBUTION_PROFILE="$DIST_PROFILE"')

    assert caller_at < relative_at < canonical_at < chdir_at < export_at


@pytest.mark.parametrize("script_name", ["build_desktop.sh", "build_linux_appimage.sh"])
def test_desktop_build_scripts_resolve_relative_profiles_from_the_callers_directory(
    tmp_path: Path, script_name: str
) -> None:
    caller = tmp_path / "caller"
    profile = caller / "profiles" / "distribution.json"
    profile.parent.mkdir(parents=True)
    profile.write_text("{}\n", encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "python.log"
    _write_executable(
        bin_dir / "python3",
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CALL_LOG"\n',
    )
    _write_executable(bin_dir / "cargo", "#!/usr/bin/env bash\nexit 0\n")
    _write_executable(bin_dir / "uname", "#!/usr/bin/env bash\necho Linux\n")
    _write_executable(bin_dir / "xdg-mime", "#!/usr/bin/env bash\nexit 0\n")
    _write_executable(
        bin_dir / "npm",
        "#!/usr/bin/env bash\n"
        'if [[ "$*" == *appimage* ]]; then\n'
        '  mkdir -p "$CARGO_TARGET_DIR/release/bundle/appimage"\n'
        '  touch "$CARGO_TARGET_DIR/release/bundle/appimage/test.AppImage"\n'
        "fi\n"
        "exit 0\n",
    )
    env = os.environ | {
        "CALL_LOG": str(log),
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PODCAST_DISTRIBUTION_PROFILE": "profiles/distribution.json",
        "CARGO_TARGET_DIR": str(tmp_path / "target"),
        "SHARECUT_SIDECAR_OUT": str(tmp_path / "sidecar"),
        "SKIP_APPIMAGE_SMOKE": "1",
    }

    completed = subprocess.run(
        ["bash", str(ROOT / "scripts" / script_name)],
        cwd=caller,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert f"--profile {profile}" in log.read_text(encoding="utf-8")


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def test_pack_macos_dmg_retries_hdiutil_only() -> None:
    text = (ROOT / "scripts/pack_macos_dmg.sh").read_text(encoding="utf-8")
    while_at = text.find("while true")
    notary_at = text.find("notarytool submit")
    staple_at = text.find("stapler validate")
    sha_at = text.rfind("shasum -a 256")
    assert while_at != -1
    assert notary_at > while_at
    assert "hdiutil create" in text
    assert 'partial="${OUT}.partial.dmg"' in text
    assert "trap 'rc=$?" in text
    assert "npm run tauri" not in text
    assert staple_at != -1
    assert sha_at > staple_at
    assert "tauri.conf.json" in text
    assert 'product_name="$(basename "$APP" .app)"' in text
    assert "compact_name=" in text
    assert "${compact_name}_${version}_$(default_arch).dmg" in text
    assert '"$staging/${product_name}.app"' in text
    assert '-volname "$product_name"' in text
    assert "Sharecut Studio.app" not in text
    assert TAURI_CONF.is_file()


def test_tauri_bundle_lists_square_png_icons() -> None:
    """AppImage bundler panics without a square PNG in bundle.icon."""
    import json

    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    icons = conf["bundle"]["icon"]
    pngs = [name for name in icons if name.endswith(".png")]
    assert pngs, "bundle.icon must list at least one PNG for Linux AppImage"
    for name in icons:
        path = TAURI_CONF.parent / name
        assert path.is_file(), f"missing {path.relative_to(ROOT)}"


def test_linux_appimage_script_is_shared_by_docker_and_gha() -> None:
    script = (ROOT / "scripts/build_linux_appimage.sh").read_text(encoding="utf-8")
    docker_run = (ROOT / "scripts/build_linux_appimage_docker.sh").read_text(encoding="utf-8")
    dockerfile = (ROOT / "gui/desktop/Dockerfile.linux-appimage").read_text(encoding="utf-8")
    gha = (ROOT / ".github/workflows/release-desktop-build.yml").read_text(encoding="utf-8")
    assert "NO_STRIP" in script
    assert "APPIMAGE_EXTRACT_AND_RUN" in script
    assert "generate_distribution_config.py" in script
    assert "--compact-product-name" in script
    assert "PODCAST_DISTRIBUTION_PROFILE" in script
    assert "build_sidecar.py" in script
    assert "--slim-only" in script
    assert "appimage_deb" in script
    assert "LD_LIBRARY_PATH" in script
    assert "*.libs" in script
    assert "--bundles appimage" in script
    assert "xdg-utils" in dockerfile
    assert "xdg-utils" in gha
    assert "ubuntu:22.04" in dockerfile
    assert "libwebkit2gtk-4.1-dev" in dockerfile
    assert "BASE_IMAGE" in dockerfile
    assert "build_linux_appimage.sh" in docker_run
    assert "Dockerfile.linux-appimage" in docker_run
    assert "sharecut-linux-sidecar" in docker_run
    assert "SHARECUT_APPIMAGE_OUT" in script
    assert "/opt/sharecut-debs" in script
    assert "/opt/sharecut-debs" in docker_run
    assert "./scripts/build_linux_appimage.sh" in gha
    assert "ubuntu-22.04" in gha
    assert ".freeze-complete" in script
    assert "REBUILD_WEB" not in script
    assert "https://archive.ubuntu.com" in docker_run
    assert ".partial" in docker_run
    assert "shasum -a 256 -c" in docker_run
    assert '"$PODCAST_DISTRIBUTION_TAURI_COMPACT_CONFIG"' in gha
    assert "smoke_linux_appimage.sh" in script
    assert "SKIP_APPIMAGE_SMOKE" in script


def test_linux_docker_wrapper_mounts_external_distribution_profile(tmp_path: Path) -> None:
    profile = tmp_path / "private" / "distribution.production.json"
    profile.parent.mkdir()
    profile.write_text('{"product_name":"Private Brand"}\n', encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker_log = tmp_path / "docker.log"
    _write_executable(
        bin_dir / "docker",
        "#!/usr/bin/env bash\n"
        'if [[ "$1 $2" == "image inspect" ]]; then exit 0; fi\n'
        'printf \'%s\\n\' "$@" >> "$DOCKER_LOG"\n',
    )
    _write_executable(bin_dir / "uname", "#!/usr/bin/env bash\necho x86_64\n")
    _write_executable(
        bin_dir / "curl",
        "#!/usr/bin/env bash\n"
        "out=''\n"
        "while (( $# )); do\n"
        '  if [[ "$1" == -o ]]; then out="$2"; shift 2; else shift; fi\n'
        "done\n"
        'printf fixture > "$out"\n',
    )
    _write_executable(bin_dir / "shasum", "#!/usr/bin/env bash\nexit 0\n")
    env = os.environ | {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "TMPDIR": str(tmp_path / "tmp"),
        "DOCKER_LOG": str(docker_log),
        "PODCAST_DISTRIBUTION_PROFILE": str(profile),
    }

    completed = subprocess.run(
        ["bash", str(ROOT / "scripts" / "build_linux_appimage_docker.sh")],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    arguments = docker_log.read_text(encoding="utf-8").splitlines()
    assert "PODCAST_DISTRIBUTION_PROFILE=/run/sharecut/distribution.json" in arguments
    assert f"{profile}:/run/sharecut/distribution.json:ro" in arguments


def test_desktop_build_has_native_intel_mac_job() -> None:
    build = ROOT / ".github/workflows/release-desktop-build.yml"
    gha = build.read_text(encoding="utf-8")
    assert "macos-15-intel" in gha
    assert "sharecut-macos-x64-dmg" in gha
    assert "bundle/dmg/*.dmg" in gha
    assert "bundle/macos/*.app" in gha
    assert "expected exactly one macOS app bundle" in gha
    assert "pack_macos_dmg.sh" in gha
    assert "Require native Intel Mac" in gha
    assert "uname -m" in gha
    assert "x86_64" in gha
    assert "do not Rosetta-cross" in gha
    assert "matrix.bundle == 'appimage'" in gha


def test_tauri_production_window_waits_on_splash() -> None:
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    windows = conf["app"]["windows"]
    assert len(windows) == 1
    assert "url" not in windows[0]
    splash = (ROOT / "gui/desktop/splash/index.html").read_text(encoding="utf-8")
    assert "127.0.0.1:8765" not in splash
    assert "Starting Sharecut Studio" in splash
    assert 'role="status"' in splash
    assert 'aria-live="polite"' in splash
    main_rs = (ROOT / "gui/desktop/src-tauri/src/main.rs").read_text(encoding="utf-8")
    assert "window.location.replace('http://127.0.0.1:8765/')" not in main_rs
    assert "window.location.replace('http://127.0.0.1:{port}/')" in main_rs
    assert "sidecar_owns_listen" in main_rs
    assert "X-Sharecut-Boot-Token" in main_rs
    assert "PODCAST_SIDECAR_BOOT_TOKEN" in main_rs
    assert "PODCAST_SIDECAR_EPHEMERAL" in main_rs
    assert "PODCAST_GUI_OPENAPI" in main_rs
    assert "PODCAST_BOOTSTRAP_CDN_BASE" in main_rs
    assert "distribution::BOOTSTRAP_CDN_BASE" in main_rs
    assert "https://cdn.sharecut.studio/assets" not in main_rs
    assert "on_navigation" in main_rs
    assert "engine-nav" in main_rs
    assert "sidecar_log_path" in main_rs
    assert "wait_for_engine" in main_rs
    assert "open_engine_window(&handle, port)" in main_rs
    owns_at = main_rs.find("sidecar_owns_listen")
    token_at = main_rs.find("X-Sharecut-Boot-Token")
    open_at = main_rs.find("open_engine_window(&handle, port)")
    assert owns_at != -1 and token_at != -1 and open_at != -1
    assert owns_at < open_at
    assert token_at < open_at
    assert "if cfg!(debug_assertions)" in main_rs
    assert "spawn_fallback" in main_rs
    assert "tcp_get_health" in main_rs
    assert "read_health_response" in main_rs
    assert "ureq_get_health" not in main_rs
    assert "try_wait" in main_rs
    assert "PODCAST_MAGIC_LINK_PRINT" in main_rs
    assert "wait_for_main_window" in main_rs
    assert "set_write_timeout" in main_rs
    assert "HEALTH_READ_CAP" in main_rs
    assert "Connection: close" in main_rs
    assert '"remote"' not in json.dumps(conf.get("app", {}).get("security", {}))
    assert "remote.urls" not in TAURI_CONF.read_text(encoding="utf-8")
    csp = conf["app"]["security"]["csp"]
    assert isinstance(csp, str) and csp
    assert "frame-ancestors 'none'" in csp
    sidecar_rs = (ROOT / "gui/desktop/src-tauri/src/sidecar.rs").read_text(encoding="utf-8")
    assert '"ok": true"' in sidecar_rs or '"ok": true' in sidecar_rs
    assert "read_health_response" in sidecar_rs
    assert "health_http_ok" in sidecar_rs
    assert "mib_tcp_row_port" in sidecar_rs
    assert "pid_owns_loopback_listen" in sidecar_rs
    assert "loopback_listener_owned" not in sidecar_rs
    assert "200 OK" not in sidecar_rs.split("health_body_ok")[1].split("pub fn health_http_ok")[0]
    shared = (ROOT / "scripts" / "sidecar_shared.rs").read_text(encoding="utf-8")
    assert "sidecar.listen.{}.json" in shared
    assert 'with_file_name("sidecar.listen.json")' not in shared
    share_url = (ROOT / "gui/desktop/src-tauri/src/share_url.rs").read_text(encoding="utf-8")
    assert "fn is_discovered_engine_origin" in share_url
    assert 'host == "127.0.0.1"' in share_url
    assert "parse_share_deep_link" in share_url
    assert "struct ShareDeepLink" in share_url
    assert "ALLOWED_HTTPS_SHARE_ORIGINS" in share_url
    assert "DEEP_LINK_SCHEMES" in share_url
    assert 'const SHARE_HTTPS_HOST: &str = "sharecut.studio"' not in share_url
    assert "tauri_plugin_single_instance" in main_rs
    assert "setup_deep_links" in main_rs
    assert "get_current" in main_rs
    assert "on_open_url" in main_rs
    assert "open(&link.open_url" in main_rs
    cargo_toml = (ROOT / "gui/desktop/src-tauri/Cargo.toml").read_text(encoding="utf-8")
    assert 'features = ["deep-link"]' in cargo_toml
    caps = json.loads(
        (ROOT / "gui/desktop/src-tauri/capabilities/default.json").read_text(encoding="utf-8")
    )
    assert "shell:allow-open" not in caps.get("permissions", [])
    deep = conf.get("plugins", {}).get("deep-link", {})
    assert "sharecut-dev" in deep.get("desktop", {}).get("schemes", [])
    mobile = deep.get("mobile") or []
    assert any(
        "https" in (entry.get("scheme") or [])
        and entry.get("host") == "share.example.test"
        and "/r/" in (entry.get("pathPrefix") or [])
        and "/rec/" in (entry.get("pathPrefix") or [])
        and entry.get("appLink") is False
        for entry in mobile
        if isinstance(entry, dict)
    )
    slim = (ROOT / "scripts" / "build_sidecar.py").read_text(encoding="utf-8")
    assert '"python/**/lib/thread[0-9]*"' in slim
    assert '"python/**/lib/thread*"' not in slim
    assert "PODCAST_GUI_OPENAPI=0" in slim
    assert "PORT=0" not in slim
    assert '"--managed-python"' in slim
    assert '"--no-project"' in slim
    launcher = (ROOT / "scripts" / "sidecar_launcher.rs").read_text(encoding="utf-8")
    assert "PODCAST_GUI_OPENAPI" in launcher
    assert "PODCAST_SIDECAR_EPHEMERAL" in launcher
    assert "sidecar_gui_port" not in launcher
    bind_py = (ROOT / "src/podcast_mcp/gui/bind.py").read_text(encoding="utf-8")
    assert "uvicorn.Server" in bind_py
    assert "sockets=[sock]" in bind_py
    assert "fd=sock.fileno()" not in bind_py


def test_linux_appimage_smoke_kills_process_group() -> None:
    text = (ROOT / "scripts/smoke_linux_appimage.sh").read_text(encoding="utf-8")
    assert "usr/bin/sharecut-sidecar" in text
    assert 'kill -- "-${SIDECAR_PID}"' in text or 'kill -- "-$SIDECAR_PID"' in text
    assert "kill -0" in text
    assert "set -m" in text


def test_gitignore_ignores_platform_binaries_dirs() -> None:
    text = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "gui/desktop/binaries-*/" in text
    assert "gui/desktop/dist-linux/" in text
    sample = "gui/desktop/binaries-linux/sharecut-runtime/web-dist/index.html"
    out = subprocess.check_output(
        ["git", "check-ignore", "-v", "--", sample],
        cwd=ROOT,
        text=True,
    )
    assert "binaries-*/" in out
    kept = subprocess.run(
        ["git", "check-ignore", "-v", "--", "gui/desktop/binaries/sharecut-sidecar"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert kept.returncode == 1
    assert kept.stdout.strip() == ""


def test_tauri_before_build_ensures_sidecar() -> None:
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    cmd = conf["build"]["beforeBuildCommand"]
    if isinstance(cmd, dict):
        cmd = cmd["script"]
    assert "--ensure" in cmd
    assert "tauri_sidecar_hook.py" in cmd
    assert "$(git" not in cmd


def test_tauri_sidecar_hook_finds_repo(tmp_path: Path, monkeypatch) -> None:
    spec = importlib.util.spec_from_file_location(
        "tauri_sidecar_hook", ROOT / "scripts" / "tauri_sidecar_hook.py"
    )
    assert spec is not None and spec.loader is not None
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)

    nested = tmp_path / "gui" / "desktop"
    nested.mkdir(parents=True)
    script = tmp_path / "scripts" / "build_sidecar.py"
    script.parent.mkdir(parents=True)
    script.write_text("ok\n", encoding="utf-8")
    monkeypatch.chdir(nested)
    assert hook.repo_root(nested.resolve()) == tmp_path.resolve()
