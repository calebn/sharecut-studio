#!/usr/bin/env python3
"""Assemble the iOS engine payload from pinned inputs.

The payload is what the app bundles besides the Rust library: the Python.xcframework and an
``app_packages`` tree holding the engine wheel and every package it needs, built for one SDK.

    uv run python scripts/ios/build_payload.py --plan  --sdk iphonesimulator
    uv run python scripts/ios/build_payload.py --ensure --sdk iphonesimulator
    uv run python scripts/ios/build_payload.py --rebuild --sdk iphoneos

``--sdk`` defaults to the one Tauri's ``TAURI_ENV_TARGET_TRIPLE`` names, so the iOS
``beforeBuildCommand`` needs no flag.

Inputs: ``contracts/ios-runtime.json`` (interpreter, BeeWare wheels, cross-builds, exclusions),
``uv.lock`` through ``uv export`` (every other version and hash), and the working tree (the engine
wheel, web build included). Every package that survives the iOS markers lands in exactly one
class: a pure wheel from the lock, a BeeWare wheel, a cross-build, a pure copy from an sdist, or
excluded with a reason. A package no class admits, or a contract row the lock no longer needs,
fails the script.

Output (gitignored): ``gui/desktop/src-tauri/ios-payload/`` with ``Python.xcframework``,
``app_packages`` and ``manifest.json``. The manifest is written last and carries a digest of the
inputs only, so ``--ensure`` does nothing when they are unchanged and finishes an interrupted run.
Downloads and cross-builds are cached under ``~/.cache/sharecut-build/ios``.

The pure parts (parsing, markers, classification, digest, Mach-O check) take no IO so
tests/test_ios_payload.py runs them anywhere; the rest needs macOS, Xcode and the iOS Rust targets.
"""

from __future__ import annotations

import argparse
import enum
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request
import zipfile
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from packaging.markers import Marker
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name, parse_wheel_filename

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = ROOT / "contracts" / "ios-runtime.json"
PAYLOAD_DIR = ROOT / "gui" / "desktop" / "src-tauri" / "ios-payload"
MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1
ROOT_PACKAGE = "podcast-mcp"
LC_BUILD_VERSION = 0x32
MH_MAGIC_64 = 0xFEEDFACF
TRIPLE_SDKS = {"aarch64-apple-ios": "iphoneos", "aarch64-apple-ios-sim": "iphonesimulator"}


class PayloadError(Exception):
    """The inputs cannot make a payload; the message says which input and why."""


# --- contract ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class SdkRow:
    rust_target: str
    xcframework_slice: str
    platform_config: str
    macho_platform: int


@dataclass(frozen=True)
class PinnedFile:
    url: str
    sha256: str


@dataclass(frozen=True)
class CrossRow:
    tool_version: str
    reason: str


@dataclass(frozen=True)
class PureSourceRow:
    package_dir: str
    module: str
    reason: str


@dataclass(frozen=True)
class BeewareRow:
    version: str
    reason: str
    files: Mapping[str, PinnedFile]


@dataclass(frozen=True)
class Contract:
    python_version: str
    support_release: str
    support: PinnedFile
    sdks: Mapping[str, SdkRow]
    cross_deployment_target: str
    marker_environment: Mapping[str, str]
    uv_export_args: tuple[str, ...]
    beeware: Mapping[str, BeewareRow]
    cross_build: Mapping[str, CrossRow]
    pure_source: Mapping[str, PureSourceRow]
    excluded: Mapping[str, str]
    engine_sources: tuple[str, ...]


def _field(table: Mapping[str, Any], key: str, kind: type, where: str) -> Any:
    value = table.get(key)
    if not isinstance(value, kind) or (isinstance(value, bool) and kind is not bool):
        raise PayloadError(f"{where}.{key} must be a {kind.__name__}, found {value!r}")
    return value


def _pinned(table: Mapping[str, Any], where: str) -> PinnedFile:
    sha = table.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64 or set(sha) - set("0123456789abcdef"):
        raise PayloadError(f"{where}.sha256 must be a lowercase sha256 hex digest, found {sha!r}")
    return PinnedFile(_field(table, "url", str, where), sha)


def parse_contract(raw: Mapping[str, Any]) -> Contract:
    """Parse the contract once; every shape error names the field."""
    if raw.get("version") != 1:
        raise PayloadError("version must be 1")
    python = _field(raw, "python", dict, "contract")
    sdks = {
        name: SdkRow(
            _field(row, "rust_target", str, f"sdks.{name}"),
            _field(row, "xcframework_slice", str, f"sdks.{name}"),
            _field(row, "platform_config", str, f"sdks.{name}"),
            _field(row, "macho_platform", int, f"sdks.{name}"),
        )
        for name, row in _field(raw, "sdks", dict, "contract").items()
    }
    beeware = {
        canonicalize_name(name): BeewareRow(
            _field(row, "version", str, f"beeware_wheels.{name}"),
            _field(row, "reason", str, f"beeware_wheels.{name}"),
            {
                sdk: _pinned(pin, f"beeware_wheels.{name}.files.{sdk}")
                for sdk, pin in _field(row, "files", dict, f"beeware_wheels.{name}").items()
            },
        )
        for name, row in _field(raw, "beeware_wheels", dict, "contract").items()
    }
    for name, row in beeware.items():
        if set(row.files) != set(sdks):
            raise PayloadError(f"beeware_wheels.{name}.files must name exactly {sorted(sdks)}")
    env = _field(raw, "marker_environment", dict, "contract")
    if not all(isinstance(value, str) for value in env.values()):
        raise PayloadError("marker_environment values must be strings")
    return Contract(
        python_version=_field(python, "version", str, "python"),
        support_release=_field(python, "support_release", str, "python"),
        support=_pinned(python, "python"),
        sdks=sdks,
        cross_deployment_target=_field(raw, "cross_deployment_target", str, "contract"),
        marker_environment=dict(env),
        uv_export_args=tuple(_field(raw, "uv_export_args", list, "contract")),
        beeware=beeware,
        cross_build={
            canonicalize_name(name): CrossRow(
                _field(row, "tool_version", str, f"cross_build.{name}"),
                _field(row, "reason", str, f"cross_build.{name}"),
            )
            for name, row in _field(raw, "cross_build", dict, "contract").items()
        },
        pure_source={
            canonicalize_name(name): PureSourceRow(
                _field(row, "package_dir", str, f"pure_source.{name}"),
                _field(row, "module", str, f"pure_source.{name}"),
                _field(row, "reason", str, f"pure_source.{name}"),
            )
            for name, row in _field(raw, "pure_source", dict, "contract").items()
        },
        excluded={
            canonicalize_name(name): reason
            for name, reason in _field(raw, "excluded", dict, "contract").items()
        },
        engine_sources=tuple(_field(raw, "engine_sources", list, "contract")),
    )


def load_contract(path: Path = CONTRACT_PATH) -> Contract:
    return parse_contract(json.loads(path.read_text(encoding="utf-8")))


# --- the lock ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Locked:
    """One line of ``uv export``: a package at a version, its marker, hashes and parents."""

    name: str
    version: str
    marker: str | None
    hashes: frozenset[str]
    via: tuple[str, ...]


@dataclass(frozen=True)
class LockFile:
    filename: str
    url: str
    sha256: str


@dataclass(frozen=True)
class LockEntry:
    wheels: tuple[LockFile, ...]
    sdist: LockFile | None


def parse_export(text: str) -> list[Locked]:
    """Requirements, markers and ``# via`` parents from ``uv export --format requirements.txt``."""
    rows: list[Locked] = []
    current: dict[str, Any] | None = None
    in_via = False

    def close() -> None:
        if current is not None:
            rows.append(
                Locked(
                    current["name"],
                    current["version"],
                    current["marker"],
                    frozenset(current["hashes"]),
                    tuple(current["via"]),
                )
            )

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("--hash="):
            if current is not None:
                current["hashes"].append(line.removeprefix("--hash=sha256:").rstrip(" \\"))
            continue
        if line.startswith("#"):
            body = line.lstrip("# ").strip()
            if current is not None and body == "via":
                in_via = True
            elif current is not None and body.startswith("via "):
                current["via"].append(canonicalize_name(body.removeprefix("via ")))
                in_via = False
            elif current is not None and in_via and body:
                current["via"].append(canonicalize_name(body))
            continue
        close()
        in_via = False
        requirement = Requirement(line.rstrip(" \\").split(" --hash", 1)[0])
        pins = [spec.version for spec in requirement.specifier if spec.operator == "=="]
        if len(pins) != 1:
            raise PayloadError(f"uv export line is not an exact pin: {line!r}")
        current = {
            "name": canonicalize_name(requirement.name),
            "version": pins[0],
            "marker": str(requirement.marker) if requirement.marker else None,
            "hashes": [],
            "via": [],
        }
    close()
    return rows


def parse_lock(text: str) -> dict[tuple[str, str], LockEntry]:
    """Wheel and sdist files (name, url, sha256) per ``(package, version)`` in uv.lock."""

    def file_of(table: Mapping[str, Any]) -> LockFile:
        url = str(table["url"])
        return LockFile(
            Path(urlparse(url).path).name, url, str(table["hash"]).removeprefix("sha256:")
        )

    entries: dict[tuple[str, str], LockEntry] = {}
    for package in tomllib.loads(text).get("package", []):
        if "version" not in package:
            continue
        sdist = package.get("sdist")
        entries[(canonicalize_name(package["name"]), package["version"])] = LockEntry(
            tuple(file_of(wheel) for wheel in package.get("wheels", [])),
            file_of(sdist) if sdist and "url" in sdist else None,
        )
    return entries


def marker_holds(marker: str | None, environment: Mapping[str, str]) -> bool:
    """Evaluate against the complete iOS environment, never the machine running the script."""
    return marker is None or Marker(marker).evaluate({**environment, "extra": ""})


def pure_wheel(entry: LockEntry | None) -> LockFile | None:
    """The lock's py3-none-any wheel for a package, if it has one."""
    for wheel in sorted(entry.wheels if entry else (), key=lambda item: item.filename):
        _, _, _, tags = parse_wheel_filename(wheel.filename)
        if all(tag.abi == "none" and tag.platform == "any" for tag in tags):
            return wheel
    return None


# --- the plan ---------------------------------------------------------------------------------


class PackageClass(enum.Enum):
    PURE_WHEEL = "pure_wheel"
    BEEWARE_WHEEL = "beeware_wheel"
    CROSS_BUILD = "cross_build"
    PURE_SOURCE = "pure_source"
    EXCLUDED = "excluded"


@dataclass(frozen=True)
class Planned:
    name: str
    version: str
    package_class: PackageClass
    reason: str | None = None
    file: LockFile | None = None


@dataclass(frozen=True)
class Plan:
    packages: tuple[Planned, ...]

    def of(self, *classes: PackageClass) -> list[Planned]:
        return [pkg for pkg in self.packages if pkg.package_class in classes]

    def installed(self) -> list[Planned]:
        return [pkg for pkg in self.packages if pkg.package_class is not PackageClass.EXCLUDED]


def _reachable(rows: Mapping[str, Locked], kept: set[str]) -> set[str]:
    """Packages reachable from the engine's own requirements through packages still kept."""
    reached = {name for name in kept if ROOT_PACKAGE in rows[name].via}
    frontier = list(reached)
    while frontier:
        parent = frontier.pop()
        for name in kept:
            if name not in reached and parent in rows[name].via:
                reached.add(name)
                frontier.append(name)
    return reached


def plan_packages(
    export: Iterable[Locked],
    lock: Mapping[tuple[str, str], LockEntry],
    contract: Contract,
) -> Plan:
    """Classify every package the iOS markers keep; fail on an unclassified or stale entry."""
    applicable = {
        row.name: row for row in export if marker_holds(row.marker, contract.marker_environment)
    }
    rows_by_class = (
        set(contract.excluded)
        | set(contract.beeware)
        | set(contract.cross_build)
        | set(contract.pure_source)
    )
    if len(rows_by_class) != (
        len(contract.excluded)
        + len(contract.beeware)
        + len(contract.cross_build)
        + len(contract.pure_source)
    ):
        raise PayloadError("a package has rows in more than one class of the contract")
    stale = sorted(rows_by_class - set(applicable))
    if stale:
        raise PayloadError(f"contract rows for packages the lock no longer needs: {stale}")

    kept = set(applicable) - set(contract.excluded)
    reached = _reachable(applicable, kept)
    planned: list[Planned] = []
    unclassified: list[str] = []
    for name in sorted(applicable):
        row = applicable[name]
        if name in contract.excluded:
            planned.append(
                Planned(name, row.version, PackageClass.EXCLUDED, contract.excluded[name])
            )
        elif name not in reached:
            parents = sorted(set(row.via) & set(applicable))
            reason = f"needed only by excluded packages: {', '.join(parents)}"
            planned.append(Planned(name, row.version, PackageClass.EXCLUDED, reason))
        elif name in contract.beeware:
            beeware = contract.beeware[name]
            planned.append(
                Planned(name, beeware.version, PackageClass.BEEWARE_WHEEL, beeware.reason)
            )
        elif name in contract.cross_build:
            sdist = (lock.get((name, row.version)) or LockEntry((), None)).sdist
            if sdist is None:
                raise PayloadError(f"{name}: cross_build needs an sdist in uv.lock")
            planned.append(
                Planned(
                    name,
                    row.version,
                    PackageClass.CROSS_BUILD,
                    contract.cross_build[name].reason,
                    sdist,
                )
            )
        elif name in contract.pure_source:
            sdist = (lock.get((name, row.version)) or LockEntry((), None)).sdist
            if sdist is None:
                raise PayloadError(f"{name}: pure_source needs an sdist in uv.lock")
            planned.append(
                Planned(
                    name,
                    row.version,
                    PackageClass.PURE_SOURCE,
                    contract.pure_source[name].reason,
                    sdist,
                )
            )
        elif (wheel := pure_wheel(lock.get((name, row.version)))) is not None:
            if wheel.sha256 not in row.hashes:
                raise PayloadError(f"{name}: lock wheel hash is not among the export's hashes")
            planned.append(Planned(name, row.version, PackageClass.PURE_WHEEL, None, wheel))
        else:
            unclassified.append(f"{name}=={row.version}")
    if unclassified:
        raise PayloadError(
            "no class admits these packages (no pure wheel in uv.lock and no contract row): "
            + ", ".join(unclassified)
        )
    return Plan(tuple(planned))


def check_engine_requirements(
    plan: Plan, engine_requirements: Iterable[str], environment: Mapping[str, str]
) -> None:
    """A BeeWare version must satisfy what the engine itself asks of that package."""
    versions = {pkg.name: pkg.version for pkg in plan.installed()}
    for text in engine_requirements:
        requirement = Requirement(text)
        name = canonicalize_name(requirement.name)
        if name not in versions or not marker_holds(
            str(requirement.marker) if requirement.marker else None, environment
        ):
            continue
        if not SpecifierSet(str(requirement.specifier)).contains(versions[name], prereleases=True):
            raise PayloadError(
                f"{name} {versions[name]} does not satisfy the engine's {requirement}"
            )


# --- digest and Mach-O -------------------------------------------------------------------------


def digest_inputs(parts: Mapping[str, str]) -> str:
    """One sha256 over named input digests; the order of the mapping does not matter."""
    outer = hashlib.sha256()
    for key in sorted(parts):
        outer.update(f"{key}={parts[key]}\n".encode())
    return outer.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(root: Path) -> str:
    """Content digest of a directory, ignoring bytecode and dependency folders."""
    outer = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        parts = path.relative_to(root).parts
        if not path.is_file() or "__pycache__" in parts or "node_modules" in parts:
            continue
        outer.update(f"{'/'.join(parts)}:{sha256_file(path)}\n".encode())
    return outer.hexdigest()


def macho_platform(data: bytes) -> int | None:
    """The Mach-O platform number (2 iOS, 7 iOS Simulator) of a thin 64-bit binary, else None."""
    if len(data) < 32 or struct.unpack_from("<I", data, 0)[0] != MH_MAGIC_64:
        return None
    (count,) = struct.unpack_from("<I", data, 16)
    offset = 32
    for _ in range(count):
        if offset + 8 > len(data):
            return None
        command, size = struct.unpack_from("<II", data, offset)
        if command == LC_BUILD_VERSION:
            return struct.unpack_from("<I", data, offset + 8)[0]
        offset += size
    return None


def check_site_packages(site: Path, sdk: SdkRow) -> None:
    """No static libraries, and every binary module built for this SDK."""
    problems = [f"{p.relative_to(site)}: static library" for p in site.rglob("*.a")]
    for path in sorted([*site.rglob("*.so"), *site.rglob("*.dylib")]):
        platform = macho_platform(path.read_bytes())
        if platform != sdk.macho_platform:
            problems.append(f"{path.relative_to(site)}: Mach-O platform {platform}")
    if problems:
        raise PayloadError("payload check failed:\n  " + "\n  ".join(problems))


# --- IO shell ---------------------------------------------------------------------------------


def cache_dir() -> Path:
    return Path.home() / ".cache" / "sharecut-build" / "ios"


def run(command: Sequence[str | Path], **kwargs: Any) -> str:
    result = subprocess.run(
        [str(part) for part in command], check=False, capture_output=True, text=True, **kwargs
    )
    if result.returncode != 0:
        tail = (result.stdout + result.stderr).strip().splitlines()[-25:]
        raise PayloadError(f"{command[0]} failed ({result.returncode}):\n" + "\n".join(tail))
    return result.stdout


def tool_version(*command: str) -> str:
    return run(command).strip().splitlines()[0]


def fetch(url: str, sha256: str, dest: Path) -> Path:
    """Download *url* once into the cache; a file whose hash differs is refused and removed."""
    if dest.is_file() and sha256_file(dest) == sha256:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "sharecut-ios-payload"})
    with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as out:
        shutil.copyfileobj(response, out)
    if sha256_file(partial) != sha256:
        partial.unlink()
        raise PayloadError(f"{url}: sha256 does not match the pin")
    partial.replace(dest)
    return dest


def ensure_support(contract: Contract, cache: Path) -> Path:
    """The verified Python-Apple-support release, unpacked; returns its Python.xcframework."""
    release = cache / "python" / contract.support_release
    framework = release / "Python.xcframework"
    if framework.is_dir():
        return framework
    archive = fetch(contract.support.url, contract.support.sha256, release.with_suffix(".tar.gz"))
    staging = Path(tempfile.mkdtemp(dir=cache))
    try:
        with tarfile.open(archive) as tar:
            tar.extractall(staging, filter="data")
        release.mkdir(parents=True, exist_ok=True)
        (staging / "Python.xcframework").rename(framework)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return framework


def build_engine_wheel(out_dir: Path) -> Path:
    """The real engine wheel; hatch puts the web build, contracts and defaults into it."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import build_sidecar

    build_sidecar.ensure_web_dist(rebuild=False)
    out_dir.mkdir(parents=True, exist_ok=True)
    run(["uv", "build", "--wheel", "--out-dir", out_dir], cwd=ROOT)
    wheels = sorted(out_dir.glob("podcast_mcp-*.whl"))
    if len(wheels) != 1:
        raise PayloadError(f"expected one engine wheel in {out_dir}, found {len(wheels)}")
    return wheels[0]


def cross_venv(contract: Contract, sdk: str, framework: Path, cache: Path) -> Path:
    venv = cache / "crossvenv" / f"{contract.support_release}-{sdk}"
    if (venv / "bin" / "python").is_file():
        return venv
    row = contract.sdks[sdk]
    config = framework / row.xcframework_slice / "platform-config" / row.platform_config
    shutil.rmtree(venv, ignore_errors=True)
    run(["uv", "venv", "--python", contract.python_version, venv])
    run([venv / "bin" / "python", config / "make_cross_venv.py", venv])
    return venv


def cross_build(
    pkg: Planned, contract: Contract, sdk: str, framework: Path, cache: Path, rustc: str
) -> Path:
    """maturin build --locked of the locked sdist against the cross venv; cached by toolchain."""
    assert pkg.file is not None
    row = contract.cross_build[pkg.name]
    key = f"{pkg.name}-{pkg.version}-{sdk}-maturin{row.tool_version}-{sha256_bytes(rustc.encode())[:12]}"
    out = cache / "cross" / key
    if list(out.glob("*.whl")):
        return next(out.glob("*.whl"))
    sdist = fetch(pkg.file.url, pkg.file.sha256, cache / "sdist" / pkg.file.filename)
    source_root = Path(tempfile.mkdtemp(dir=cache))
    try:
        with tarfile.open(sdist) as tar:
            tar.extractall(source_root, filter="data")
        (source,) = [p for p in source_root.iterdir() if p.is_dir()]
        venv = cross_venv(contract, sdk, framework, cache)
        out.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "IPHONEOS_DEPLOYMENT_TARGET": contract.cross_deployment_target}
        run(
            [
                "uv",
                "tool",
                "run",
                "--from",
                f"maturin=={row.tool_version}",
                "maturin",
                "build",
                "--release",
                "--locked",
                "--target",
                contract.sdks[sdk].rust_target,
                "-i",
                venv / "bin" / "python",
                "--out",
                out,
            ],
            cwd=source,
            env=env,
        )
    finally:
        shutil.rmtree(source_root, ignore_errors=True)
    return next(out.glob("*.whl"))


def extract_wheel(wheel: Path, site: Path) -> None:
    """Unpack a wheel the way an installer would for a pure or binary wheel without scripts."""
    with zipfile.ZipFile(wheel) as archive:
        for member in archive.infolist():
            name = member.filename
            first, _, tail = name.partition("/")
            if first.endswith(".data"):
                scheme, _, rest = tail.partition("/")
                if scheme not in {"purelib", "platlib"} or not rest:
                    continue
                name = rest
            target = (site / name).resolve()
            if site.resolve() not in target.parents:
                raise PayloadError(f"{wheel.name}: member {member.filename!r} escapes the target")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(member))


def copy_pure_source(pkg: Planned, contract: Contract, cache: Path, site: Path) -> None:
    assert pkg.file is not None
    row = contract.pure_source[pkg.name]
    sdist = fetch(pkg.file.url, pkg.file.sha256, cache / "sdist" / pkg.file.filename)
    scratch = Path(tempfile.mkdtemp(dir=cache))
    try:
        with tarfile.open(sdist) as tar:
            tar.extractall(scratch, filter="data")
        (source,) = [p for p in scratch.iterdir() if p.is_dir()]
        shutil.copytree(source / row.package_dir, site / row.module)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def engine_digest(contract: Contract) -> str:
    parts = {
        entry: tree_digest(ROOT / entry) if (ROOT / entry).is_dir() else sha256_file(ROOT / entry)
        for entry in contract.engine_sources
    }
    web = ROOT / "gui" / "web" / "dist"
    parts["gui/web/dist"] = tree_digest(web) if web.is_dir() else "absent"
    return digest_inputs(parts)


def input_digest(contract: Contract, sdk: str, export_text: str, rustc: str) -> str:
    return digest_inputs(
        {
            "contract": sha256_file(CONTRACT_PATH),
            "uv.lock": sha256_file(ROOT / "uv.lock"),
            "uv-export": sha256_bytes(export_text.encode()),
            "engine": engine_digest(contract),
            "script": sha256_file(Path(__file__)),
            "sdk": sdk,
            "rustc": rustc,
        }
    )


def load_plan(contract: Contract) -> tuple[str, Plan]:
    """The `uv export` text and the classified plan for the locked packages."""
    export_text = run(
        ["uv", "export", *contract.uv_export_args, "--format", "requirements.txt"], cwd=ROOT
    )
    lock = parse_lock((ROOT / "uv.lock").read_text(encoding="utf-8"))
    return export_text, plan_packages(parse_export(export_text), lock, contract)


def engine_requirements() -> list[str]:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    return [*project["dependencies"], *project["optional-dependencies"]["gui"]]


def sdk_from_environment() -> str:
    triple = os.environ.get("TAURI_ENV_TARGET_TRIPLE", "")
    if triple not in TRIPLE_SDKS:
        raise PayloadError(
            "pass --sdk iphonesimulator|iphoneos (TAURI_ENV_TARGET_TRIPLE names no iOS target)"
        )
    return TRIPLE_SDKS[triple]


def read_manifest() -> dict[str, Any] | None:
    try:
        return json.loads((PAYLOAD_DIR / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def build(contract: Contract, sdk: str, plan: Plan, digest: str, rustc: str) -> None:
    output = PAYLOAD_DIR
    cache = cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    (output / MANIFEST_NAME).unlink(missing_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    framework = ensure_support(contract, cache)
    wheels: dict[str, Path] = {}
    for pkg in plan.of(PackageClass.PURE_WHEEL):
        assert pkg.file is not None
        wheels[pkg.name] = fetch(
            pkg.file.url, pkg.file.sha256, cache / "wheels" / pkg.file.filename
        )
    for pkg in plan.of(PackageClass.BEEWARE_WHEEL):
        pin = contract.beeware[pkg.name].files[sdk]
        wheels[pkg.name] = fetch(
            pin.url, pin.sha256, cache / "wheels" / Path(urlparse(pin.url).path).name
        )
    for pkg in plan.of(PackageClass.CROSS_BUILD):
        wheels[pkg.name] = cross_build(pkg, contract, sdk, framework, cache, rustc)
    engine = build_engine_wheel(cache / "engine" / sdk)

    staging = output / "app_packages.tmp"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()
    for wheel in [*wheels.values(), engine]:
        extract_wheel(wheel, staging)
    for pkg in plan.of(PackageClass.PURE_SOURCE):
        copy_pure_source(pkg, contract, cache, staging)
    for cache_dir_ in staging.rglob("__pycache__"):
        shutil.rmtree(cache_dir_)
    for static_library in staging.rglob("*.a"):
        static_library.unlink()
    check_site_packages(staging, contract.sdks[sdk])
    shutil.rmtree(output / "app_packages", ignore_errors=True)
    staging.rename(output / "app_packages")
    if not (output / "Python.xcframework" / "Info.plist").is_file() or not sha_matches(
        output / "Python.xcframework", framework
    ):
        shutil.rmtree(output / "Python.xcframework", ignore_errors=True)
        shutil.copytree(framework, output / "Python.xcframework", symlinks=True)

    manifest = {
        "version": MANIFEST_VERSION,
        "sdk": sdk,
        "input_digest": digest,
        "python": {
            "version": contract.python_version,
            "support_release": contract.support_release,
            "support_sha256": contract.support.sha256,
        },
        "tools": {"uv": tool_version("uv", "--version"), "rustc": rustc},
        "packages": [
            {
                "name": pkg.name,
                "version": pkg.version,
                "class": pkg.package_class.value,
                **({"file": wheels[pkg.name].name} if pkg.name in wheels else {}),
            }
            for pkg in plan.installed()
        ],
        "dropped": [
            {"name": pkg.name, "version": pkg.version, "reason": pkg.reason}
            for pkg in plan.of(PackageClass.EXCLUDED)
        ],
        "bytes": {
            "app_packages": dir_bytes(output / "app_packages"),
            "python_xcframework": dir_bytes(output / "Python.xcframework"),
        },
    }
    (output / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def sha_matches(copy: Path, original: Path) -> bool:
    return (copy / "Info.plist").read_bytes() == (original / "Info.plist").read_bytes() and (
        dir_bytes(copy) == dir_bytes(original)
    )


def dir_bytes(root: Path) -> int:
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def plan_summary(plan: Plan) -> dict[str, Any]:
    return {
        "installed": [
            {"name": p.name, "version": p.version, "class": p.package_class.value}
            for p in plan.installed()
        ],
        "dropped": [
            {"name": p.name, "version": p.version, "reason": p.reason}
            for p in plan.of(PackageClass.EXCLUDED)
        ],
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--plan", action="store_true", help="print the classified plan, build nothing"
    )
    mode.add_argument("--ensure", action="store_true", help="build unless the inputs are unchanged")
    mode.add_argument(
        "--rebuild", action="store_true", help="build even when the inputs are unchanged"
    )
    parser.add_argument("--sdk", choices=sorted(TRIPLE_SDKS.values()))
    args = parser.parse_args(argv)
    try:
        contract = load_contract()
        sdk = args.sdk or sdk_from_environment()
        export_text, plan = load_plan(contract)
        check_engine_requirements(plan, engine_requirements(), contract.marker_environment)
        if args.plan:
            print(json.dumps(plan_summary(plan), indent=2))
            return 0
        rustc = tool_version("rustc", "--version")
        digest = input_digest(contract, sdk, export_text, rustc)
        manifest = read_manifest()
        if (
            args.ensure
            and manifest
            and manifest.get("input_digest") == digest
            and (PAYLOAD_DIR / "app_packages").is_dir()
        ):
            print(f"ios payload up to date ({sdk})")
            return 0
        build(contract, sdk, plan, digest, rustc)
    except PayloadError as error:
        print(f"build_payload: {error}", file=sys.stderr)
        return 1
    print(f"ios payload built ({sdk}): {PAYLOAD_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
