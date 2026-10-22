#!/usr/bin/python3
"""Configure the CI Ubuntu transport or serve apt's acquisition protocol."""

from __future__ import annotations

import json
import os
import pwd
import re
import shutil
import signal
import stat
import sys
from pathlib import Path
from typing import TextIO
from urllib.parse import unquote, urlsplit

from ci_apt_acquisition import AptSignedMetadata, FetchPlan, HashedObject, acquire

METHOD = "sharecut-https"
CANONICAL = ("archive.ubuntu.com", "security.ubuntu.com")
SECONDARY = "https://mirrors.edge.kernel.org/ubuntu/"
MAXIMUM_METADATA = 10 * 1024 * 1024
MAXIMUM_MESSAGE = 64 * 1024
MAXIMUM_FIELDS = 128
INSTALL = Path("/usr/local/lib/sharecut-ci-apt")
SUITES = {"resolute", "resolute-updates", "resolute-security", "resolute-backports"}
COMPONENTS = {"main", "universe", "restricted", "multiverse"}


def unsigned(value: str) -> int:
    if not re.fullmatch(r"[0-9]{1,12}", value):
        raise ValueError("invalid apt size")
    return int(value)


def plan_request(fields: dict[str, str]) -> FetchPlan:
    uri = urlsplit(fields["URI"])
    if (
        uri.scheme != METHOD
        or uri.netloc not in CANONICAL
        or uri.username
        or uri.password
        or uri.query
        or uri.fragment
    ):
        raise ValueError("unsupported Ubuntu source")
    decoded = unquote(uri.path)
    if (
        not decoded.startswith("/ubuntu/")
        or "\\" in decoded
        or not re.fullmatch(r"[A-Za-z0-9._+:/~-]+", decoded)
        or any(part in {"", ".", ".."} for part in decoded.split("/")[2:])
        or not re.fullmatch(r"[A-Za-z0-9._+%:/~-]+", uri.path)
    ):
        raise ValueError("invalid Ubuntu resource path")
    relative = uri.path.removeprefix("/ubuntu/")
    parts = relative.split("/")
    if parts[0] == "dists" and (len(parts) < 3 or parts[1] not in SUITES):
        raise ValueError("unsupported Ubuntu suite")
    if parts[0] == "pool" and (len(parts) < 4 or parts[1] not in COMPONENTS):
        raise ValueError("unsupported Ubuntu component")
    if parts[0] == "dists" and len(parts) > 3 and parts[2] not in COMPONENTS:
        raise ValueError("unsupported Ubuntu index component")
    if fields.get("Target-Architecture", "amd64") not in {"amd64", "amd64v3", "all"}:
        raise ValueError("unsupported Ubuntu architecture")
    is_metadata = re.fullmatch(r"dists/[a-z0-9-]+/(?:InRelease|Release|Release.gpg)", relative)
    is_object = relative.startswith("pool/") or relative.startswith("dists/")
    if "Expected-SHA256" in fields:
        sha256 = fields["Expected-SHA256"]
        if not is_object or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            raise ValueError("invalid apt SHA256 identity")
        identity: HashedObject | AptSignedMetadata = HashedObject(
            unsigned(fields["Expected-Checksum-FileSize"]), sha256
        )
    elif is_metadata and fields.get("Index-File") == "true":
        maximum = min(unsigned(fields.get("Maximum-Size", str(MAXIMUM_METADATA))), MAXIMUM_METADATA)
        if maximum == 0:
            raise ValueError("empty metadata budget")
        identity = AptSignedMetadata(maximum)
    else:
        raise ValueError("Ubuntu object lacks an authenticated SHA256 identity")
    return FetchPlan(identity, (f"https://{uri.netloc}/ubuntu/{relative}", SECONDARY + relative))


def read_message(stream: TextIO) -> tuple[str, dict[str, str]] | None:
    first = stream.readline(MAXIMUM_MESSAGE + 1)
    if not first:
        return None
    if len(first.encode("utf-8")) > MAXIMUM_MESSAGE or not re.fullmatch(
        r"[0-9]{3} [^\x00-\x1f\x7f]+\n", first
    ):
        raise ValueError("invalid apt message header")
    fields: dict[str, str] = {}
    length = len(first.encode("utf-8"))
    while True:
        line = stream.readline(MAXIMUM_MESSAGE + 1)
        length += len(line.encode("utf-8"))
        if not line or length > MAXIMUM_MESSAGE:
            raise ValueError("incomplete or oversized apt message")
        if line == "\n":
            return first[:3], fields
        if len(fields) >= MAXIMUM_FIELDS or not re.fullmatch(
            r"[A-Za-z0-9-]+: [^\x00-\x1f\x7f]*\n", line
        ):
            raise ValueError("invalid apt field")
        key, value = line[:-1].split(": ", 1)
        if key in fields:
            raise ValueError("duplicate apt field")
        fields[key] = value


def send(code: str, fields: dict[str, str]) -> None:
    print(code)
    for key, value in fields.items():
        if "\n" in value or "\r" in value:
            raise ValueError("invalid apt response field")
        print(f"{key}: {value}")
    print(flush=True)


def destination_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.name in {"", ".", ".."}:
        raise ValueError("invalid apt destination")
    if path.parent.resolve(strict=True) != path.parent or path.is_symlink():
        raise ValueError("apt destination traverses a symlink")
    if path.exists() and not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("apt destination is not a regular file")
    return path


def cancelled(_signal: int, _frame: object) -> None:
    raise SystemExit(0)


def run_method() -> int:
    if os.geteuid() == 0:
        account = pwd.getpwnam("_apt")
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    send("100 Capabilities", {"Version": "1.0", "Single-Instance": "true", "Send-Config": "false"})
    while message := read_message(sys.stdin):
        code, fields = message
        if code != "600":
            raise ValueError("unsupported apt message")
        uri = fields.get("URI", "")
        try:
            plan = plan_request(fields)
            destination = destination_path(fields["Filename"])
            send("200 URI Start", {"URI": uri})
            receipt = acquire(plan, destination)
            source = urlsplit(plan.urls[receipt.source])
            print(
                json.dumps(
                    {
                        "host": source.hostname,
                        "path": source.path,
                        "bytes": receipt.size,
                        "elapsed": round(receipt.elapsed, 3),
                        "kind": type(plan.identity).__name__,
                        "winner": receipt.source,
                        "budget": plan.budgets.metadata_total
                        if isinstance(plan.identity, AptSignedMetadata)
                        else plan.budgets.object_total,
                    }
                ),
                file=sys.stderr,
                flush=True,
            )
            send(
                "201 URI Done",
                {
                    "URI": uri,
                    "Filename": str(destination),
                    "Size": str(receipt.size),
                    "SHA256-Hash": receipt.sha256,
                    "SHA512-Hash": receipt.sha512,
                },
            )
        except (ValueError, KeyError, OSError, RuntimeError) as error:
            print(
                json.dumps({"outcome": "request-failed", "failure": type(error).__name__}),
                file=sys.stderr,
                flush=True,
            )
            send("400 URI Failure", {"URI": uri, "Message": "Bounded Ubuntu acquisition failed"})
    return 0


def rewrite_mirrors(source: str) -> str:
    if not re.search(rf"^(?:https|{METHOD})://archive\.ubuntu\.com/ubuntu/(?:\s|$)", source, re.M):
        raise ValueError("runner lacks the canonical HTTPS Ubuntu archive")
    result = []
    for line in source.splitlines(keepends=True):
        if re.match(r"https?://azure\.archive\.ubuntu\.com/ubuntu/(?:\s|$)", line):
            continue
        if not line.strip() or line.lstrip().startswith("#"):
            result.append(line)
            continue
        if not any(
            re.match(rf"(?:https|{METHOD})://{re.escape(host)}/ubuntu/(?:\s|$)", line)
            for host in CANONICAL
        ):
            raise ValueError("unsupported runner Ubuntu mirror entry")
        result.append(
            f"{METHOD}://" + line.removeprefix("https://") if line.startswith("https://") else line
        )
    return "".join(result)


def owned_target(path: Path) -> None:
    if path.is_symlink() or path.parent.resolve(strict=True) != path.parent:
        raise ValueError("configuration path traverses a symlink")
    if path.exists():
        info = path.stat()
        if info.st_uid != os.geteuid() or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
            raise ValueError("configuration file must be owned without other writers")


def rewrite_sources(source: str) -> str:
    uri_lines = re.findall(r"^URIs:[ \t]+(.+)$", source, re.M)
    allowed = {"mirror+file:/etc/apt/apt-mirrors.txt"}
    for host in CANONICAL:
        allowed.update(
            f"{scheme}://{host}/ubuntu{slash}"
            for scheme in ("https", METHOD)
            for slash in ("", "/")
        )
    if not uri_lines or any(uri not in allowed for line in uri_lines for uri in line.split()):
        raise ValueError("unsupported Ubuntu source layout")
    suites = re.findall(r"^Suites:[ \t]+(.+)$", source, re.M)
    components = re.findall(r"^Components:[ \t]+(.+)$", source, re.M)
    if not suites or any(suite not in SUITES for line in suites for suite in line.split()):
        raise ValueError("unsupported runner Ubuntu suites")
    if not components or any(c not in COMPONENTS for line in components for c in line.split()):
        raise ValueError("unsupported runner Ubuntu components")
    for host in CANONICAL:
        source = re.sub(
            rf"(?<!\S)https://{re.escape(host)}/ubuntu/?(?=\s|$)",
            f"{METHOD}://{host}/ubuntu/",
            source,
        )
    return source


def configure(
    apt_root: Path = Path("/etc/apt"),
    install: Path = INSTALL,
    method_directory: Path = Path("/usr/lib/apt/methods"),
) -> None:
    for directory in (apt_root, method_directory):
        if directory.resolve(strict=True) != directory or directory.stat().st_uid != os.geteuid():
            raise ValueError("configuration directory is not owned or traverses a symlink")
    mirrors = apt_root / "apt-mirrors.txt"
    ubuntu = apt_root / "sources.list.d/ubuntu.sources"
    executable = method_directory / METHOD
    configuration = apt_root / "apt.conf.d/99sharecut-acquisition"
    for path in (mirrors, ubuntu, executable, configuration):
        owned_target(path)
    changed = rewrite_mirrors(mirrors.read_text())
    sources = rewrite_sources(ubuntu.read_text())
    for command in ("curl", "/usr/bin/python3"):
        if shutil.which(command) is None:
            raise ValueError("runner lacks Ubuntu transport prerequisites")
    new_install = not install.exists()
    install.mkdir(mode=0o755, parents=True, exist_ok=True)
    if new_install:
        install.chmod(0o755)
    if (
        install.resolve(strict=True) != install
        or install.stat().st_uid != os.geteuid()
        or stat.S_IMODE(install.stat().st_mode) != 0o755
    ):
        raise ValueError("method directory must be owned and readable without other writers")
    for name in ("ci_apt_method.py", "ci_apt_acquisition.py"):
        owned_target(install / name)
        shutil.copyfile(Path(__file__).with_name(name), install / name)
        (install / name).chmod(0o644)
    executable.write_text(f'#!/bin/sh\nexec /usr/bin/python3 "{install}/ci_apt_method.py"\n')
    executable.chmod(0o755)
    configuration.write_text('APT::Update::Error-Mode "any";\n')
    configuration.chmod(0o644)
    mirrors.write_text(changed)
    ubuntu.write_text(sources)


if __name__ == "__main__":
    if sys.argv[1:] == ["configure"]:
        configure()
    elif not sys.argv[1:]:
        raise SystemExit(run_method())
    else:
        raise SystemExit("Expected configure or an apt protocol stream")
