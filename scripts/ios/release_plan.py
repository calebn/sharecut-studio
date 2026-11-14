"""The release as data: a list of steps that the dry run prints and the runner executes.

``plan_build``, ``plan_validate`` and ``plan_upload`` are pure over their inputs and paths. A
``Run`` is a child process (``contacts_apple`` says whether it talks to Apple); a ``Local`` is an
in-process action over a ``Workspace`` that returns a ``CheckReport`` when it checks something.
"""

from __future__ import annotations

import json
import plistlib
import shutil
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from scripts.ios import bundle_checks as checks
from scripts.ios import private_paths
from scripts.ios.release_classify import AppleAnswer, Failure, signing_hint
from scripts.ios.release_inputs import BuildInputs, Identity, Signing
from scripts.ios.release_record import ReleaseRecord, sha256_file, write_record
from scripts.ios.release_run import Command, Part, PrivateFile, SpawnResult, capture
from scripts.ios.release_secrets import Secret

PASS_THROUGH = (
    "DEVELOPER_DIR",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
)
LANGUAGE = "en_US.UTF-8"
APPLE_NOTICE = (
    "This step may create an Apple Distribution certificate and an App Store provisioning "
    "profile in the developer account that Xcode is signed in to."
)
SIMULATOR_TEAM = "AAAAAAAAAA"


@dataclass(frozen=True)
class Layout:
    """Where things live, so plans are pure over a root."""

    root: Path

    @property
    def desktop(self) -> Path:
        return self.root / "gui" / "desktop"

    @property
    def tauri(self) -> Path:
        return self.desktop / "src-tauri"

    @property
    def release_root(self) -> Path:
        return self.tauri / "target" / "ios-release"

    @property
    def archive(self) -> Path:
        return self.tauri / "gen" / "apple" / "build" / "sharecut_iOS.xcarchive"


@dataclass
class Workspace:
    """State the local steps share during one run; not shared across runs."""

    out: Path
    ipa: Path | None = None
    app: Path | None = None
    scratch: list[Path] = field(default_factory=list)
    reports: dict[str, checks.CheckReport] = field(default_factory=dict)
    sha256: str = ""
    build_number: str = ""
    signing: Signing = Signing.NONE
    record: ReleaseRecord | None = None
    answers: list[AppleAnswer] = field(default_factory=list)

    def cleanup(self) -> None:
        for path in self.scratch:
            shutil.rmtree(path, ignore_errors=True)
        self.scratch.clear()


Outcome = tuple[Failure | None, str]
OK: Outcome = (None, "")


@dataclass(frozen=True)
class Run:
    name: str
    command: Command
    contacts_apple: bool
    interpret: Callable[[SpawnResult, Workspace], Outcome]


@dataclass(frozen=True)
class Local:
    name: str
    action: Callable[[Workspace], checks.CheckReport | None]
    contacts_apple: Literal[False] = False


Step = Run | Local


def child_environment(
    environ: Mapping[str, str], *, path: str, team: Part | None = None
) -> dict[str, Part]:
    """The only environment a child process gets: an explicit allowlist, so no API key, manual
    signing material, ``RUSTFLAGS`` or desktop release secret can reach Tauri or xcodebuild."""
    env: dict[str, Part] = {
        "PATH": path,
        "HOME": environ.get("HOME", str(Path.home())),
        "TMPDIR": environ.get("TMPDIR", tempfile.gettempdir()),
        "LANG": LANGUAGE,
    }
    env.update({name: environ[name] for name in PASS_THROUGH if environ.get(name)})
    if team is not None:
        env["APPLE_DEVELOPMENT_TEAM"] = team
    return env


def tool_path(toolchain_bin: Path, environ: Mapping[str, str]) -> str:
    """The rustup toolchain first (Homebrew's rustc has no iOS standard library), then Apple's
    ``/usr/bin`` (Homebrew's rsync hangs the Python install phase), then the caller's PATH."""
    return ":".join([str(toolchain_bin), "/usr/bin", environ.get("PATH", "")])


def ios_overlay(identity: Identity, build_number: str) -> dict[str, object]:
    """Three keys, built by hand: the identifier, the name under the icon and the build number.
    The build number goes through ``bundleVersion``; ``--build-number`` would append a fourth
    component to the version."""
    return {
        "identifier": identity.bundle_identifier,
        "productName": identity.name,
        "bundle": {"iOS": {"bundleVersion": build_number}},
    }


def overlay_argument(identity: Identity, build_number: str) -> str:
    return json.dumps(ios_overlay(identity, build_number), separators=(",", ":"))


def export_options_parts(team: Secret) -> tuple[Part, ...]:
    marker = "@@TEAM@@"
    document = plistlib.dumps(
        {
            "method": "app-store-connect",
            "signingStyle": "automatic",
            "teamID": marker,
            "uploadSymbols": False,
            "destination": "export",
            "manageAppVersionAndBuildNumber": False,
        }
    ).decode()
    head, _, tail = document.partition(marker)
    return (head, team, tail)


def tool_outcome(result: SpawnResult, _: Workspace) -> Outcome:
    if result.exit_code == 0:
        return OK
    hint = signing_hint(result.exit_code, result.output)
    if hint:
        return Failure.SIGNING, hint
    return Failure.TOOL, f"exited {result.exit_code}"


def plan_build(
    inputs: BuildInputs, layout: Layout, environ: Mapping[str, str], path: str
) -> list[Step]:
    signed = inputs.signing is Signing.APP_STORE
    team: Part = inputs.team if inputs.team is not None else SIMULATOR_TEAM
    env = child_environment(environ, path=path, team=team)
    overlay = overlay_argument(inputs.identity, str(inputs.build_number))
    bare = child_environment(environ, path=path)
    steps: list[Step] = []
    for module, label in ((layout.root / "gui" / "web", "web"), (layout.desktop, "desktop")):
        if not (module / "node_modules").is_dir():
            steps.append(
                Run(
                    f"{label} dependencies",
                    Command(("npm", "ci"), module, bare),
                    False,
                    tool_outcome,
                )
            )
        if label == "web":
            steps.append(
                Run(
                    "web build",
                    Command(("npm", "run", "--silent", "build"), module, bare),
                    False,
                    tool_outcome,
                )
            )
    steps.append(
        Run(
            "device payload",
            Command(
                (
                    "uv",
                    "run",
                    "python",
                    "scripts/ios/build_payload.py",
                    "--ensure",
                    "--sdk",
                    "iphoneos",
                ),
                layout.root,
                bare,
            ),
            False,
            tool_outcome,
        )
    )
    steps.append(Local("reset generated project", lambda ws: reset(layout.tauri / "gen" / "apple")))
    steps.append(
        Run(
            "xcode project",
            Command(
                ("npx", "tauri", "ios", "init", "--ci", "--config", overlay), layout.desktop, env
            ),
            False,
            tool_outcome,
        )
    )
    archive_args: list[str] = ["--archive-only"]
    runner_args: list[str] = []
    if signed:
        runner_args = ["--", "-allowProvisioningUpdates"]
    else:
        archive_args.append("--no-sign")
    steps.append(
        Run(
            "archive",
            Command(
                (
                    "npx",
                    "tauri",
                    "ios",
                    "build",
                    "--ci",
                    "-v",
                    "--target",
                    "aarch64",
                    "--config",
                    overlay,
                    *archive_args,
                    *runner_args,
                ),
                layout.desktop,
                env,
            ),
            signed,
            tool_outcome,
        )
    )
    export_dir = layout.tauri / "gen" / "apple" / "build" / "export"
    if signed and inputs.team is not None:
        options = layout.tauri / "gen" / "apple" / "build" / "ExportOptions.release.plist"
        steps.append(
            Run(
                "export",
                Command(
                    (
                        "xcodebuild",
                        "-exportArchive",
                        "-allowProvisioningUpdates",
                        "-archivePath",
                        str(layout.archive),
                        "-exportPath",
                        str(export_dir),
                        "-exportOptionsPlist",
                        str(options),
                    ),
                    layout.desktop,
                    bare,
                    (PrivateFile(options, export_options_parts(inputs.team)),),
                ),
                True,
                tool_outcome,
            )
        )
    steps.append(
        Local(
            "collect ipa",
            lambda ws: collect_ipa(
                ws, layout.archive, export_dir, signed, str(inputs.build_number)
            ),
        )
    )
    steps += artifact_checks(
        checks.PlistExpectation(
            inputs.identity.bundle_identifier,
            inputs.identity.name,
            inputs.marketing_version,
            str(inputs.build_number),
        ),
        layout,
        signed,
    )
    steps.append(Local("record", lambda ws: write_build_record(ws, inputs)))
    return steps


def reset(directory: Path) -> None:
    shutil.rmtree(directory, ignore_errors=True)


def collect_ipa(
    ws: Workspace, archive: Path, export_dir: Path, signed: bool, build_number: str
) -> checks.CheckReport | None:
    ws.out.mkdir(parents=True, exist_ok=True)
    target = ws.out / f"{build_number}.ipa"
    if signed:
        produced = sorted(export_dir.glob("*.ipa"))
        if len(produced) != 1:
            return checks.CheckReport(
                "collect ipa", (f"export produced {len(produced)} .ipa files",)
            )
        shutil.copyfile(produced[0], target)
    else:
        apps = sorted((archive / "Products" / "Applications").glob("*.app"))
        if len(apps) != 1:
            return checks.CheckReport("collect ipa", (f"the archive holds {len(apps)} apps",))
        staging = Path(tempfile.mkdtemp(prefix="sharecut-ios-ipa-"))
        try:
            capture(["ditto", str(apps[0]), str(staging / "Payload" / apps[0].name)])
            capture(["ditto", "-c", "-k", "--keepParent", str(staging / "Payload"), str(target)])
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    shutil.rmtree(archive, ignore_errors=True)
    shutil.rmtree(export_dir, ignore_errors=True)
    ws.ipa = target
    ws.sha256 = sha256_file(target)
    return None


def unpack(ws: Workspace) -> Path:
    if ws.app is not None:
        return ws.app
    assert ws.ipa is not None
    scratch = Path(tempfile.mkdtemp(prefix="sharecut-ios-app-"))
    ws.scratch.append(scratch)
    capture(["ditto", "-x", "-k", str(ws.ipa), str(scratch)])
    apps = sorted((scratch / "Payload").glob("*.app"))
    if len(apps) != 1:
        raise checks.ToolFailed(f"the IPA holds {len(apps)} apps")
    ws.app = apps[0]
    return apps[0]


def artifact_checks(
    expect: checks.PlistExpectation | None, layout: Layout, signed: bool
) -> list[Step]:
    """The local checks over the IPA: the same list runs after the build and again at upload."""
    steps: list[Step] = [
        Local("path scan", lambda ws: scan_check(ws, layout.root)),
        Local("info plist", lambda ws: plist_check(ws, expect)),
        Local("bundle layout", lambda ws: checks.check_layout(unpack(ws))),
        Local("privacy", privacy_check),
    ]
    if signed:
        steps.append(Local("signature", signature_check))
    return steps


def scan_check(ws: Workspace, root: Path) -> checks.CheckReport:
    assert ws.ipa is not None
    needles = private_paths.machine_needles(root)
    report = private_paths.scan_zip(ws.ipa, needles).merged(
        private_paths.scan_tree(unpack(ws), needles)
    )
    problems = tuple(
        f"{count:5d}  {section:20s}  {context}"
        for count, section, context in report.attribution()[:12]
    )
    return checks.CheckReport(
        "path scan",
        problems,
        tuple(f"not readable: {name}" for name in report.unseen),
        {
            "files_scanned": report.files_scanned,
            "archives_opened": report.archives_opened,
            "hits": len(report.hits),
            "unseen": list(report.unseen),
        },
    )


def plist_check(ws: Workspace, expect: checks.PlistExpectation | None) -> checks.CheckReport:
    plist = plistlib.loads((unpack(ws) / "Info.plist").read_bytes())
    ws.build_number = str(plist.get("CFBundleVersion", ""))
    if expect is None:
        return checks.CheckReport("info plist", facts={"build_number": ws.build_number})
    return checks.check_info_plist(plist, expect)


def privacy_check(ws: Workspace) -> checks.CheckReport:
    app = unpack(ws)
    return checks.check_privacy(
        checks.imported_symbols(app), checks.read_manifest(app), checks.load_privacy_contract()
    )


def signature_check(ws: Workspace) -> checks.CheckReport:
    app = unpack(ws)
    report = checks.check_signature(app)
    profile = checks.decode_profile(app)
    if profile is None:
        return checks.CheckReport(
            "signature", (*report.problems, "the app has no embedded profile")
        )
    store = checks.check_store_profile(profile)
    ws.signing = Signing.APP_STORE if store.ok else Signing.NONE
    return checks.CheckReport(
        "signature", (*report.problems, *store.problems), facts={"profile": store.facts["type"]}
    )


def write_build_record(ws: Workspace, inputs: BuildInputs) -> None:
    assert ws.ipa is not None
    write_record(
        ws.out,
        ReleaseRecord(
            build_number=str(inputs.build_number),
            marketing_version=inputs.marketing_version,
            bundle_identifier=inputs.identity.bundle_identifier,
            signing=inputs.signing.value,
            commit=inputs.checkout.commit,
            ipa_sha256=ws.sha256,
            ipa_name=ws.ipa.name,
            checks={name: report.facts for name, report in ws.reports.items()},
        ),
    )
