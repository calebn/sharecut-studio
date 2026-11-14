"""Checks over a built iOS app that App Store processing or this repository's rules care about.

Each check returns a ``CheckReport``; none contacts Apple. Parsing is separate from reading, so
the rules are tested over plain mappings and small fixture trees.
"""

from __future__ import annotations

import json
import plistlib
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from scripts.ios.release_run import capture

ROOT = Path(__file__).resolve().parents[2]
PRIVACY_CONTRACT = ROOT / "contracts" / "ios-privacy.json"
MINIMUM_OS = "17.0"
BUILD_NUMBER = re.compile(r"^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$")
MACHO_MAGICS = (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf", b"\xbe\xba\xfe\xca")


@dataclass(frozen=True)
class CheckReport:
    name: str
    problems: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    facts: Mapping[str, object] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.problems


@dataclass(frozen=True)
class PlistExpectation:
    bundle_identifier: str
    name: str
    marketing_version: str
    build_number: str


def check_info_plist(plist: Mapping[str, object], expect: PlistExpectation) -> CheckReport:
    wanted = {
        "CFBundleIdentifier": expect.bundle_identifier,
        "CFBundleName": expect.name,
        "CFBundleShortVersionString": expect.marketing_version,
        "CFBundleVersion": expect.build_number,
        "MinimumOSVersion": MINIMUM_OS,
        "ITSAppUsesNonExemptEncryption": False,
    }
    problems = [
        f"{key} is {plist.get(key)!r}, expected {value!r}"
        for key, value in wanted.items()
        if plist.get(key) != value or type(plist.get(key)) is not type(value)
    ]
    if not BUILD_NUMBER.fullmatch(str(plist.get("CFBundleVersion", ""))):
        problems.append("CFBundleVersion is not three dot-separated integers")
    return CheckReport(
        "info plist", tuple(problems), facts={"build_number": plist.get("CFBundleVersion")}
    )


def is_macho(path: Path) -> bool:
    with path.open("rb") as handle:
        return handle.read(4) in MACHO_MAGICS


def check_layout(app: Path) -> CheckReport:
    """No static libraries, no loose shared object, and every Mach-O is the main executable or
    inside a framework."""
    problems: list[str] = []
    machos = 0
    for path in sorted(app.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(app)
        parts = relative.parts
        in_framework = (
            parts[0] == "Frameworks" and len(parts) >= 3 and parts[1].endswith(".framework")
        )
        if path.suffix == ".a":
            problems.append(f"static library {relative}")
        elif path.suffix in {".so", ".dylib"} and not in_framework:
            problems.append(f"loose {path.suffix} {relative}")
        elif "__pycache__" in parts:
            problems.append(f"bytecode cache {relative}")
        if is_macho(path):
            machos += 1
            if not in_framework and len(parts) != 1:
                problems.append(f"Mach-O outside the executable and Frameworks: {relative}")
    return CheckReport("bundle layout", tuple(problems), facts={"mach_o_files": machos})


def check_store_profile(profile: Mapping[str, object]) -> CheckReport:
    """A decoded embedded.mobileprovision that an App Store build carries: no device list."""
    entitlements = profile.get("Entitlements", {})
    problems = []
    if profile.get("ProvisionedDevices") or profile.get("ProvisionsAllDevices"):
        problems.append("the embedded profile is a development or ad hoc profile, not App Store")
    if isinstance(entitlements, dict) and entitlements.get("get-task-allow"):
        problems.append("the embedded profile allows debugging (get-task-allow)")
    return CheckReport(
        "profile", tuple(problems), facts={"type": "app-store" if not problems else "other"}
    )


def decode_profile(app: Path) -> Mapping[str, object] | None:
    embedded = app / "embedded.mobileprovision"
    if not embedded.is_file():
        return None
    return plistlib.loads(capture(["security", "cms", "-D", "-i", str(embedded)]).encode())


def check_signature(app: Path) -> CheckReport:
    try:
        capture(["codesign", "--verify", "--deep", "--strict", str(app)])
    except RuntimeError as error:
        return CheckReport("signature", (str(error),))
    return CheckReport("signature")


def load_privacy_contract(path: Path = PRIVACY_CONTRACT) -> Mapping[str, Mapping[str, list[str]]]:
    return json.loads(path.read_text(encoding="utf-8"))["categories"]


def imported_symbols(app: Path) -> dict[str, frozenset[str]]:
    """Undefined symbols of every Mach-O in the bundle, keyed by its bundle-relative path."""
    imports = {}
    for path in sorted(app.rglob("*")):
        if path.is_file() and not path.is_symlink() and is_macho(path):
            output = capture(["xcrun", "nm", "-u", "-j", str(path)])
            imports[path.relative_to(app).as_posix()] = frozenset(output.split())
    return imports


def used_categories(
    imports: Mapping[str, frozenset[str]], contract: Mapping[str, Mapping[str, list[str]]]
) -> dict[str, list[str]]:
    return {
        category: [name for name, symbols in imports.items() if symbols & set(row["symbols"])]
        for category, row in contract.items()
        if any(symbols & set(row["symbols"]) for symbols in imports.values())
    }


def declared_categories(manifest: Mapping[str, object]) -> dict[str, list[str]]:
    declared = {}
    for entry in manifest.get("NSPrivacyAccessedAPITypes", []):  # type: ignore[attr-defined]
        declared[entry["NSPrivacyAccessedAPIType"]] = list(entry["NSPrivacyAccessedAPITypeReasons"])
    return declared


def check_privacy(
    imports: Mapping[str, frozenset[str]],
    manifest: Mapping[str, object] | None,
    contract: Mapping[str, Mapping[str, list[str]]],
) -> CheckReport:
    """Used but undeclared fails; declared but unused warns; a reason the contract does not list
    fails. The manifest read is the one inside the built bundle."""
    if manifest is None:
        return CheckReport("privacy", ("the built app has no PrivacyInfo.xcprivacy",))
    used = used_categories(imports, contract)
    declared = declared_categories(manifest)
    problems = [
        f"{category} is used by {', '.join(names[:3])}{' ...' if len(names) > 3 else ''} but not declared"
        for category, names in used.items()
        if category not in declared
    ]
    problems += [
        f"{category} lists reason {reason}, which is not in contracts/ios-privacy.json"
        for category, reasons in declared.items()
        for reason in reasons
        if category in contract and reason not in contract[category]["reasons"]
    ]
    problems += [
        f"{category} lists no reason" for category, reasons in declared.items() if not reasons
    ]
    warnings = [
        f"{category} is declared but no binary imports it"
        for category in declared
        if category not in used
    ]
    facts = {category: len(names) for category, names in used.items()}
    return CheckReport("privacy", tuple(problems), tuple(warnings), facts)


def read_manifest(app: Path) -> Mapping[str, object] | None:
    path = app / "PrivacyInfo.xcprivacy"
    return plistlib.loads(path.read_bytes()) if path.is_file() else None
