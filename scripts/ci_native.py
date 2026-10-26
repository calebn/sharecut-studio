from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum

from path_vocab import Glob


class NativeFamily(Enum):
    WEB = "web"
    CARGO = "cargo"
    PINNED = "pinned"
    RESOLVER = "resolver"
    LOCK = "lock"
    PAYLOAD = "payload"
    REGISTRY = "registry"


ALL_NATIVE = frozenset(NativeFamily)
PYTHON_NATIVE = frozenset(
    (NativeFamily.PINNED, NativeFamily.RESOLVER, NativeFamily.LOCK, NativeFamily.REGISTRY)
)
PAYLOAD_NATIVE = frozenset((NativeFamily.PAYLOAD, NativeFamily.LOCK, NativeFamily.REGISTRY))


@dataclass(frozen=True)
class NativeSelection:
    required: frozenset[NativeFamily] = ALL_NATIVE

    def outputs(self) -> dict[str, str]:
        return {
            f"skip-native-{family.value}": "0" if family in self.required else "1"
            for family in NativeFamily
        }


@dataclass(frozen=True)
class NativeRule:
    paths: tuple[Glob, ...]
    consumers: frozenset[NativeFamily]


@dataclass(frozen=True)
class NativeWorkload:
    workflow: str
    job: str
    family: NativeFamily
    test_roots: tuple[str, ...] = ()
    command_roots: tuple[str, ...] = ()
    prerequisites: tuple[str, ...] = ()


NATIVE_WORKLOADS = (
    NativeWorkload("desktop.yml", "web-dist", NativeFamily.WEB, command_roots=("npm run build",)),
    NativeWorkload(
        "desktop.yml",
        "desktop-scaffold",
        NativeFamily.CARGO,
        command_roots=("./scripts/desktop/check_desktop.sh",),
    ),
    NativeWorkload(
        "desktop.yml",
        "desktop-windows-check",
        NativeFamily.CARGO,
        command_roots=(
            "python scripts/tauri_sidecar_hook.py --dev-stub",
            "cargo check --bin sharecut --features app",
        ),
    ),
    NativeWorkload(
        "desktop.yml", "pinned-media-windows", NativeFamily.PINNED, ("tests/test_pinned_media.py",)
    ),
    NativeWorkload(
        "desktop.yml",
        "ffmpeg-resolver-windows",
        NativeFamily.RESOLVER,
        (
            "tests/test_binaries.py",
            "tests/test_verify_ffmpeg_baseline.py",
            "tests/test_ffmpeg_diagnostics.py",
        ),
    ),
    NativeWorkload(
        "desktop.yml",
        "project-commit-lock-windows",
        NativeFamily.LOCK,
        (
            "tests/test_project_commit_lock.py",
            "tests/test_history.py",
            "tests/test_review_versions.py",
        ),
    ),
    NativeWorkload("desktop.yml", "ffmpeg-native-payload", NativeFamily.PAYLOAD),
    NativeWorkload(
        "desktop.yml",
        "ffmpeg-linux-newer-host",
        NativeFamily.PAYLOAD,
        command_roots=('python scripts/ffmpeg_payload.py --output "$PAYLOAD" --verify-only',),
        prerequisites=("ffmpeg-native-payload",),
    ),
    NativeWorkload(
        "registry-backup-windows.yml",
        "native-registry-backup",
        NativeFamily.REGISTRY,
        tuple(
            f"tests/{name}.py"
            for name in (
                "test_share_registry_source_privacy",
                "test_registry_windows_acl_policy",
                "test_registry_privacy_cleanup",
                "test_registry_windows_privacy_error",
                "test_registry_windows_actor_setup",
                "test_registry_backup_windows",
                "test_registry_backup_windows_names",
                "test_registry_backup_cli",
                "test_registry_backup_publisher",
                "test_share_registry_backup_actors",
                "test_share_registry_recovery",
                "test_registry_lifecycle_actors",
                "test_sqlite_tx",
                "test_session_sqlite_initialization",
                "test_object_store_fixture",
                "test_share_registry",
                "test_list_clips_recording",
            )
        ),
    ),
)

NATIVE_CONTRACTS: dict[str, frozenset[NativeFamily]] = {
    "bootstrap-assets.json": PYTHON_NATIVE,
    "ffmpeg-artifacts.json": PAYLOAD_NATIVE,
    "ffmpeg-build.json": PYTHON_NATIVE | PAYLOAD_NATIVE,
    "join-length-limits.json": PYTHON_NATIVE,
    "ripple-scope.json": PYTHON_NATIVE,
    "timeline-zoom.json": PYTHON_NATIVE,
    "trim-edge-limits.json": PYTHON_NATIVE,
    **dict.fromkeys(
        (
            "bootstrap-assets.schema.json",
            "capabilities.manifest.json",
            "caps.json",
            "distribution-profile.schema.json",
            "docs-sync.json",
            "export-presets.json",
            "pipeline-params.json",
            "progress-exemptions.json",
            "progress-richness.json",
            "roll-join-limits.json",
            "test-wait-allowlist.json",
        ),
        frozenset(),
    ),
}

DESKTOP_PR_EXCLUSIONS: tuple[str, ...] = tuple(
    f"contracts/{name}" for name, consumers in NATIVE_CONTRACTS.items() if not consumers
)
DESKTOP_PR_PATHS: tuple[str, ...] = ("**", *(f"!{path}" for path in DESKTOP_PR_EXCLUSIONS))

NATIVE_RULES = tuple(
    NativeRule(tuple(Glob.parse(path) for path in paths), consumers)
    for paths, consumers in (
        (
            (
                "scripts/ci_plan.py",
                "scripts/ci_native.py",
                "scripts/path_vocab.py",
                "tests/test_ci_plan.py",
                "tests/test_native_ci_plan.py",
                "tests/test_release_ci_plan.py",
                ".github/actions/ci-plan/**",
                ".github/workflows/desktop.yml",
                ".github/workflows/registry-backup-windows.yml",
            ),
            ALL_NATIVE,
        ),
        (("gui/web/**",), frozenset((NativeFamily.WEB,))),
        (
            (
                "gui/desktop/**",
                "scripts/desktop/**",
                "scripts/sidecar_*.rs",
                "scripts/build_sidecar.py",
                "scripts/generate_distribution_config.py",
                "scripts/tauri_sidecar_hook.py",
                "config/distribution.dev.json",
                "src/podcast_mcp/config/distribution.py",
                "src/podcast_mcp/settings.py",
                "src/podcast_mcp/__init__.py",
            ),
            frozenset((NativeFamily.CARGO,)),
        ),
        (
            (
                "src/podcast_mcp/**",
                "src/podcast_relay/**",
                "tests/**",
                ".agents/defaults/**",
                "pyproject.toml",
                "uv.lock",
                "hatch_build.py",
                ".github/actions/install-locked-python/**",
                "scripts/registry_windows_storage.ps1",
            ),
            PYTHON_NATIVE,
        ),
        (
            (
                ".github/actions/setup-ffmpeg/**",
                "scripts/ffmpeg_payload.py",
                "scripts/build_sidecar.py",
                "src/podcast_mcp/__init__.py",
                "src/podcast_mcp/util/__init__.py",
                "src/podcast_mcp/util/atomic_file.py",
                "src/podcast_mcp/util/hashing.py",
                "src/podcast_mcp/util/ffmpeg_policy.py",
                "src/podcast_mcp/util/contracts.py",
                "src/podcast_mcp/util/review.py",
                "src/podcast_mcp/util/text.py",
            ),
            PAYLOAD_NATIVE,
        ),
        (("scripts/verify_ffmpeg_baseline.py",), frozenset((NativeFamily.RESOLVER,))),
        (
            (
                "docs/**",
                "docs-site/**",
                "ux/**",
                ".agents/skills/**",
                "README.md",
                "ROADMAP.md",
                "AGENTS.md",
            ),
            frozenset(),
        ),
    )
)


def select_native(changed: Sequence[str]) -> NativeSelection:
    """Union every matching consumer; absent or unclassified changes require all."""
    if not changed:
        return NativeSelection()
    required: set[NativeFamily] = set()
    for path in changed:
        if (
            not path
            or path.startswith("/")
            or "\\" in path
            or any(part in {"", ".", ".."} for part in path.split("/"))
            or any(ord(char) < 32 or ord(char) == 127 for char in path)
        ):
            return NativeSelection()
        if path.startswith("contracts/"):
            consumers = NATIVE_CONTRACTS.get(path.removeprefix("contracts/"))
            if consumers is None:
                return NativeSelection()
            required.update(consumers)
            continue
        matches = [rule for rule in NATIVE_RULES if any(glob.matches(path) for glob in rule.paths)]
        if not matches:
            return NativeSelection()
        for rule in matches:
            required.update(rule.consumers)
    return NativeSelection(frozenset(required))
