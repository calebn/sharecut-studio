#!/usr/bin/env python3
"""Install the catalog-pinned FFmpeg pair and preserve its producer provenance."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.ffmpeg_policy import ffmpeg_policy
from podcast_mcp.util.hashing import sha256_file

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "contracts/ffmpeg-artifacts.json"
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_FILES = 256
SIGNED_RECEIPT = "signed-installed.json"
TARGETS = frozenset(
    {
        "x86_64-unknown-linux-gnu",
        "x86_64-pc-windows-msvc",
        "x86_64-apple-darwin",
        "aarch64-apple-darwin",
    }
)


@dataclass(frozen=True)
class Artifact:
    target: str
    url: str
    sha256: str
    manifest_sha256: str


def artifact_for(target: str, catalog: Path = CATALOG) -> Artifact:
    if target not in TARGETS:
        raise ValueError(f"unsupported prebuilt target {target!r}")
    try:
        data = json.loads(catalog.read_text())
        entry = data["targets"][target]
    except (OSError, KeyError) as exc:
        raise ValueError(f"prebuilt catalog has no admitted artifact for {target}") from exc
    if data["version"] != ffmpeg_policy()["version"]:
        raise ValueError("prebuilt catalog version differs from runtime policy")
    for key in ("sha256", "manifest_sha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", entry[key]):
            raise ValueError(f"invalid artifact {key}")
    url = urlparse(entry["url"])
    if url.scheme != "https" or not url.netloc or url.username or url.password or url.fragment:
        raise ValueError("prebuilt artifact requires an HTTPS URL without credentials")
    return Artifact(target, entry["url"], entry["sha256"], entry["manifest_sha256"])


def verify_archive(archive: Path, expected: str) -> None:
    actual = sha256_file(archive)
    if actual != expected:
        raise ValueError(f"sha256 mismatch for {archive.name}: expected {expected}, got {actual}")


def _relative(name: str) -> Path:
    path = PurePosixPath(name)
    if (
        not name
        or not path.parts
        or path.is_absolute()
        or ".." in path.parts
        or "\\" in name
        or path.as_posix() != name
        or ":" in name
    ):
        raise ValueError(f"unsafe payload path {name!r}")
    return Path(*path.parts)


def _manifest(raw: bytes, artifact: Artifact) -> dict[str, Any]:
    if hashlib.sha256(raw).hexdigest() != artifact.manifest_sha256:
        raise ValueError("producer manifest sha256 differs from admitted artifact")
    manifest: dict[str, Any] = json.loads(raw)
    if manifest["target"] != artifact.target or manifest["version"] != ffmpeg_policy()["version"]:
        raise ValueError("payload target or release differs from admitted artifact")
    files = manifest["files"]
    if not isinstance(files, dict) or not files or len(files) > MAX_FILES:
        raise ValueError("invalid payload inventory")
    for relative, digest in files.items():
        _relative(relative)
        if relative in {"manifest.json", SIGNED_RECEIPT} or not re.fullmatch(
            r"[a-f0-9]{64}", digest
        ):
            raise ValueError("invalid producer file digest")
    suffix = ".exe" if artifact.target.endswith("windows-msvc") else ""
    required = {f"bin/{name}{suffix}" for name in ("ffmpeg", "ffprobe")}
    required |= {
        "rebuild/config.h",
        "rebuild/contracts/ffmpeg-build.json",
        "rebuild/scripts/build_ffmpeg.py",
    }
    for name, source in ffmpeg_policy()["sources"].items():
        required.add("sources/" + source["archive"])
        if not any(relative.startswith(f"notices/{name}/") for relative in files):
            raise ValueError(f"missing {name} notices")
    if not required <= files.keys():
        raise ValueError("missing binary pair, source, or rebuild material")
    return manifest


def _extract(archive: Path, directory: Path, artifact: Artifact) -> None:
    if archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("payload archive exceeds download limit")
    verify_archive(archive, artifact.sha256)
    with tarfile.open(archive) as handle:
        files = {}
        directories = set()
        total = 0
        for count, member in enumerate(handle, start=1):
            total += member.size
            if member.size < 0 or count > MAX_FILES * 2 or total > MAX_UNPACKED_BYTES:
                raise ValueError("payload archive exceeds extraction limit")
            _relative(member.name.rstrip("/") if member.isdir() else member.name)
            if member.isfile():
                if member.name in files:
                    raise ValueError("duplicate payload archive member")
                files[member.name] = member
            elif member.isdir():
                directories.add(member.name.rstrip("/"))
            else:
                raise ValueError(f"unsafe payload archive member {member.name!r}")
        if "manifest.json" not in files or files["manifest.json"].size > 1024 * 1024:
            raise ValueError("missing or oversized producer manifest")
        source = handle.extractfile(files["manifest.json"])
        if source is None:
            raise ValueError("unreadable producer manifest")
        with source:
            manifest = _manifest(source.read(), artifact)
        expected = set(manifest["files"]) | {"manifest.json"}
        parents = {
            parent.as_posix()
            for name in expected
            for parent in PurePosixPath(name).parents
            if parent.as_posix() != "."
        }
        if files.keys() != expected or not directories <= parents:
            raise ValueError("payload archive differs from closed producer inventory")
        for name, member in files.items():
            path = directory / _relative(name)
            path.parent.mkdir(parents=True, exist_ok=True)
            stream = handle.extractfile(member)
            if stream is None:
                raise ValueError(f"unreadable payload archive member {name!r}")
            with stream, path.open("wb") as output:
                shutil.copyfileobj(stream, output, length=1024 * 1024)
            path.chmod(member.mode & 0o755)


def _integrity(directory: Path, artifact: Artifact, *, signed: bool = True) -> dict[str, Any]:
    if directory.is_symlink():
        raise ValueError("unsafe payload directory")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("unsafe producer manifest")
    manifest = _manifest(manifest_path.read_bytes(), artifact)
    installed = dict(manifest["files"])
    receipt = directory / SIGNED_RECEIPT
    suffix = ".exe" if artifact.target.endswith("windows-msvc") else ""
    pair = {f"bin/{name}{suffix}" for name in ("ffmpeg", "ffprobe")}
    if receipt.exists():
        if not signed or not artifact.target.endswith("apple-darwin") or receipt.is_symlink():
            raise ValueError("unexpected signing receipt")
        data = json.loads(receipt.read_text())
        if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
            raise ValueError("invalid signing receipt")
        files = data["files"]
        if any(
            not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            for digest in files.values()
        ):
            raise ValueError("invalid signing receipt file digest")
        if (
            data.get("archive_sha256") != artifact.sha256
            or data.get("manifest_sha256") != artifact.manifest_sha256
            or files.keys() != pair
        ):
            raise ValueError("signing receipt differs from admitted origin")
        installed.update(files)
    inventory = set()
    for file in directory.rglob("*"):
        if file.is_symlink() or not (file.is_file() or file.is_dir()):
            raise ValueError("unsafe installed payload member")
        if file.is_file():
            inventory.add(file.relative_to(directory).as_posix())
    expected = set(installed) | {"manifest.json"}
    if receipt.exists():
        expected.add(SIGNED_RECEIPT)
    if inventory != expected:
        raise ValueError("installed payload differs from closed producer inventory")
    for relative, digest in installed.items():
        verify_archive(directory / _relative(relative), digest)
    for source in ffmpeg_policy()["sources"].values():
        verify_archive(directory / "sources" / source["archive"], source["sha256"])
    recipe = json.loads((directory / "rebuild/contracts/ffmpeg-build.json").read_text())
    policy = ffmpeg_policy()
    for key in (
        "version",
        "sources",
        "lame_configure",
        "zlib_configure",
        "opus_configure",
        "ffmpeg_configure",
        "macos_deployment_target",
    ):
        if recipe[key] != policy[key]:
            raise ValueError(f"producer recipe {key} differs from admitted policy")
    if receipt.exists():
        for relative in sorted(pair):
            _run(["codesign", "--verify", "--strict", str(directory / relative)])
    return manifest


def verify_payload(
    directory: Path, *, target: str | None = None, catalog: Path = CATALOG
) -> dict[str, Any]:
    artifact = artifact_for(target or _target(), catalog)
    manifest = _integrity(directory, artifact)
    prove_payload(directory, artifact.target)
    return manifest


def _download(artifact: Artifact, destination: Path) -> None:
    with urlopen(artifact.url, timeout=120) as response, destination.open("wb") as output:
        if urlparse(response.geturl()).scheme != "https":
            raise ValueError("prebuilt redirect must remain HTTPS")
        remaining = MAX_ARCHIVE_BYTES
        while chunk := response.read(min(1024 * 1024, remaining + 1)):
            remaining -= len(chunk)
            if remaining < 0:
                raise ValueError("payload download exceeds size limit")
            output.write(chunk)
    verify_archive(destination, artifact.sha256)


def ensure_payload(
    output: Path, *, target: str | None = None, catalog: Path = CATALOG, archive: Path | None = None
) -> dict[str, Any]:
    artifact = artifact_for(target or _target(), catalog)
    if archive is not None:
        verify_archive(archive, artifact.sha256)
    previous = output.with_name(f".{output.name}.previous")
    work = output.with_name(f".{output.name}.work")
    for directory in (output, previous, work):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError(f"unsafe payload publication directory {directory}")
    if work.exists():
        if any(child.name not in {"payload.tar.xz", "payload"} for child in work.iterdir()):
            raise ValueError(f"unexpected payload work member in {work}")
        shutil.rmtree(work)
    if previous.exists():
        if output.exists():
            try:
                manifest = _integrity(output, artifact, signed=False)
                prove_payload(output, artifact.target)
            except (OSError, ValueError, KeyError, RuntimeError):
                shutil.rmtree(output)
            else:
                shutil.rmtree(previous)
                return manifest
        previous.rename(output)
    try:
        manifest = _integrity(output, artifact, signed=False)
        prove_payload(output, artifact.target)
        return manifest
    except (OSError, ValueError, KeyError, RuntimeError):
        pass
    output.parent.mkdir(parents=True, exist_ok=True)
    work.mkdir()
    try:
        selected_archive = work / "payload.tar.xz"
        if archive is None:
            _download(artifact, selected_archive)
        else:
            shutil.copyfile(archive, selected_archive)
        stage = work / "payload"
        stage.mkdir()
        _extract(selected_archive, stage, artifact)
        manifest = _integrity(stage, artifact, signed=False)
        prove_payload(stage, artifact.target)
        try:
            if output.exists():
                output.rename(previous)
            stage.rename(output)
        except BaseException as failure:
            if previous.exists() and not output.exists():
                try:
                    previous.rename(output)
                except BaseException as recovery:
                    failure.add_note(f"Previous payload retained at {previous}: {recovery}")
            raise
        if previous.exists():
            shutil.rmtree(previous)
    finally:
        shutil.rmtree(work)
    return manifest


def sign_payload(
    directory: Path, identity: str, *, target: str | None = None, catalog: Path = CATALOG
) -> None:
    artifact = artifact_for(target or _target(), catalog)
    if not artifact.target.endswith("apple-darwin") or not identity.strip():
        raise ValueError("payload signing requires a macOS target and identity")
    _integrity(directory, artifact, signed=False)
    prove_payload(directory, artifact.target)
    pair = ("bin/ffmpeg", "bin/ffprobe")
    for relative in pair:
        binary = directory / relative
        _run(
            [
                "codesign",
                "--force",
                "--options",
                "runtime",
                "--timestamp",
                "--sign",
                identity,
                str(binary),
            ]
        )
        _run(["codesign", "--verify", "--strict", str(binary)])
    receipt = {
        "archive_sha256": artifact.sha256,
        "manifest_sha256": artifact.manifest_sha256,
        "files": {relative: sha256_file(directory / relative) for relative in pair},
    }
    atomic_write(
        directory / SIGNED_RECEIPT,
        lambda stream: stream.write((json.dumps(receipt, indent=2) + "\n").encode()),
    )
    verify_payload(directory, target=artifact.target, catalog=catalog)


def _run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int = 120,
) -> str:
    result = subprocess.run(
        argv, cwd=cwd, env=env, capture_output=True, text=True, check=False, timeout=timeout
    )
    if result.returncode:
        raise RuntimeError(f"Command failed {argv!r}: {result.stdout}\n{result.stderr}")
    return result.stdout + result.stderr


def _target() -> str:
    machine = platform.machine().lower()
    architectures = {
        "arm64": "aarch64",
        "aarch64": "aarch64",
        "x86_64": "x86_64",
        "amd64": "x86_64",
    }
    if machine not in architectures:
        raise ValueError(f"unsupported native architecture {machine!r}")
    arch = architectures[machine]
    suffix = {"Darwin": "apple-darwin", "Linux": "unknown-linux-gnu", "Windows": "pc-windows-msvc"}[
        platform.system()
    ]
    return f"{arch}-{suffix}"


def _pe_headers(binary: Path) -> tuple[bytes, int, list[tuple[int, int, int]]]:
    data = binary.read_bytes()
    if len(data) < 64 or data[:2] != b"MZ":
        raise ValueError("invalid PE executable")
    header = struct.unpack_from("<I", data, 60)[0]
    if data[header : header + 4] != b"PE\0\0":
        raise ValueError("invalid PE signature")
    if header + 24 > len(data):
        raise ValueError("truncated PE header")
    machine, count = struct.unpack_from("<HH", data, header + 4)
    optional_size = struct.unpack_from("<H", data, header + 20)[0]
    optional = header + 24
    if optional_size < 128 or optional + optional_size + count * 40 > len(data):
        raise ValueError("truncated PE optional header or section table")
    if machine != 0x8664 or struct.unpack_from("<H", data, optional)[0] != 0x20B:
        raise ValueError("payload PE architecture is not x86_64")
    sections = []
    for index in range(count):
        section = optional + optional_size + index * 40
        virtual_size, address, raw_size, offset = struct.unpack_from("<IIII", data, section + 8)
        if offset + raw_size > len(data):
            raise ValueError("PE section exceeds executable size")
        sections.append((address, min(virtual_size, raw_size), offset))
    return data, optional, sections


def _windows_imports(binary: Path) -> list[str]:
    data, optional, sections = _pe_headers(binary)

    def offset(address: int, length: int = 1) -> int:
        for start, size, raw in sections:
            if start <= address and address + length <= start + size:
                return raw + address - start
        raise ValueError("PE import address outside mapped section")

    address, size = struct.unpack_from("<II", data, optional + 120)
    if not 20 <= size <= 20 * 1024:
        raise ValueError("invalid PE import table size")
    imports = []
    for index in range(size // 20):
        descriptor = struct.unpack_from("<IIIII", data, offset(address + index * 20, 20))
        if not any(descriptor):
            return imports
        start = offset(descriptor[3])
        end = data.find(b"\0", start, start + 256)
        if end < 0:
            raise ValueError("unterminated PE import name")
        imports.append(data[start:end].decode("ascii"))
    raise ValueError("unterminated PE import table")


def _architecture(binary: Path, target: str) -> None:
    with binary.open("rb") as handle:
        header = handle.read(64)
    if target.endswith("windows-msvc"):
        _pe_headers(binary)
    elif target.endswith("linux-gnu"):
        if (
            len(header) < 20
            or header[:6] != b"\x7fELF\x02\x01"
            or struct.unpack_from("<H", header, 18)[0] != 62
        ):
            raise ValueError("payload ELF architecture is not x86_64")
    else:
        expected = 0x100000C if target.startswith("aarch64-") else 0x1000007
        if (
            len(header) < 8
            or header[:4] != b"\xcf\xfa\xed\xfe"
            or struct.unpack_from("<I", header, 4)[0] != expected
        ):
            raise ValueError("payload Mach-O architecture differs from target")


def _linkage(binary: Path) -> str:
    system = platform.system()
    if system == "Darwin":
        text = _run(["otool", "-L", str(binary)])
        loads = _run(["otool", "-l", str(binary)])
        minima = []
        for block in loads.split("Load command"):
            if "LC_BUILD_VERSION" in block:
                minima.extend(re.findall(r"^\s*minos (\d+\.\d+(?:\.\d+)?)", block, re.MULTILINE))
            elif "LC_VERSION_MIN_MACOSX" in block:
                minima.extend(re.findall(r"^\s*version (\d+\.\d+(?:\.\d+)?)", block, re.MULTILINE))
        maximum = tuple(map(int, ffmpeg_policy()["macos_deployment_target"].split(".")))
        if not minima or any(tuple(map(int, value.split(".")))[:2] > maximum for value in minima):
            raise ValueError(f"Mach-O minimum OS exceeds deployment target: {minima}")
        dependencies = [line.strip().split(" (")[0] for line in text.splitlines()[1:]]
        invalid = [
            item for item in dependencies if not item.startswith(("/usr/lib/", "/System/Library/"))
        ]
    elif system == "Windows":
        dependencies = _windows_imports(binary)
        text = "\n".join(dependencies)
        print(f"Windows native imports for {binary}: {dependencies}")
        allowed = {
            "kernel32.dll",
            "msvcrt.dll",
            "ucrtbase.dll",
            "advapi32.dll",
            "bcrypt.dll",
            "crypt32.dll",
            "user32.dll",
            "ws2_32.dll",
            "secur32.dll",
            "shell32.dll",
            "ole32.dll",
            "avrt.dll",
            "gdi32.dll",
            "oleaut32.dll",
            "shlwapi.dll",
            "avicap32.dll",
        }
        invalid = [
            item
            for item in dependencies
            if item.lower() not in allowed
            and not re.fullmatch(
                r"api-ms-win-[a-z0-9]+(?:-[a-z0-9]+)*-l[0-9]+-[0-9]+-[0-9]+\.dll", item.lower()
            )
        ]
    else:
        text = _run(["ldd", str(binary)])
        allowed = {
            "libc.so.6",
            "libm.so.6",
            "libmvec.so.1",
            "libpthread.so.0",
            "libdl.so.2",
            "librt.so.1",
            "ld-linux-x86-64.so.2",
            "ld-linux-aarch64.so.1",
            "linux-vdso.so.1",
        }
        dependencies = [line.strip().split()[0] for line in text.splitlines() if line.strip()]
        invalid = []
        for line in text.splitlines():
            fields = line.strip().split()
            if not fields:
                continue
            name = Path(fields[0]).name
            location = fields[2] if len(fields) > 2 and fields[1] == "=>" else fields[0]
            if name == "linux-vdso.so.1":
                continue
            if (
                name not in allowed
                or ".." in location.split("/")
                or not location.startswith(("/lib/", "/lib64/", "/usr/lib/", "/usr/lib64/"))
            ):
                invalid.append(line.strip())
    if not dependencies or invalid:
        raise ValueError(f"non-system native linkage for {binary}: {invalid or text}")
    return text


def media_proof(directory: Path) -> dict[str, Any]:
    suffix = ".exe" if platform.system() == "Windows" else ""
    ffmpeg, ffprobe = (directory / "bin" / (name + suffix) for name in ("ffmpeg", "ffprobe"))
    environment = os.environ.copy()
    for key in ("DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "LD_LIBRARY_PATH"):
        environment.pop(key, None)
    if platform.system() == "Windows":
        environment["PATH"] = str(Path(environment["SYSTEMROOT"]) / "System32")
    else:
        environment["PATH"] = "/usr/bin:/bin"
    with tempfile.TemporaryDirectory(prefix="media-proof-") as temp:
        output = Path(temp)
        base = [
            str(ffmpeg),
            "-hide_banner",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:duration=1:sample_rate=48000",
        ]
        for codec, extension, expected in (
            ("pcm_s16le", "wav", "pcm_s16le"),
            ("pcm_f32le", "wav", "pcm_f32le"),
            ("flac", "flac", "flac"),
            ("aac", "m4a", "aac"),
            ("libmp3lame", "mp3", "mp3"),
            ("libopus", "opus", "opus"),
        ):
            encoded = output / f"{codec}.{extension}"
            _run([*base, "-c:a", codec, str(encoded)], env=environment)
            probe = json.loads(
                _run(
                    [str(ffprobe), "-v", "error", "-show_streams", "-of", "json", str(encoded)],
                    env=environment,
                )
            )["streams"][0]
            if probe["codec_name"] != expected or probe["sample_rate"] != "48000":
                raise ValueError(f"codec proof failed for {codec}: {probe}")
            decoded = output / f"{codec}.f32"
            _run(
                [str(ffmpeg), "-v", "error", "-i", str(encoded), "-f", "f32le", str(decoded)],
                env=environment,
            )
            frames = decoded.stat().st_size // 4
            if not 48000 <= frames <= 49152:
                raise ValueError(f"decoded sample count for {codec}: {frames}")
        resampled = output / "resampled.f32"
        _run([*base, "-ar", "44100", "-f", "f32le", str(resampled)], env=environment)
        if resampled.stat().st_size != 44100 * 4:
            raise ValueError("resampling proof failed")
        for audio_filter, marker in (
            ("ebur128=peak=true", "True peak:"),
            ("loudnorm=I=-16:TP=-1:LRA=11:print_format=json", "input_tp"),
        ):
            if marker not in _run([*base, "-af", audio_filter, "-f", "null", "-"], env=environment):
                raise ValueError(f"loudness proof failed for {audio_filter}")
        png = output / "waveform.png"
        _run(
            [*base, "-filter_complex", "showwavespic=s=320x100", "-frames:v", "1", str(png)],
            env=environment,
        )
        if png.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError("PNG waveform proof failed")
    return {
        "codecs": ["pcm_s16le", "pcm_f32le", "flac", "aac", "libmp3lame", "libopus"],
        "resampling": "48000 to 44100",
        "filters": ["ebur128", "loudnorm", "showwavespic"],
    }


def prove_payload(directory: Path, target: str) -> None:
    if target != _target():
        raise ValueError(f"payload target {target} differs from host {_target()}")
    policy = ffmpeg_policy()
    suffix = ".exe" if platform.system() == "Windows" else ""
    for name in ("ffmpeg", "ffprobe"):
        binary = directory / "bin" / (name + suffix)
        _architecture(binary, target)
        version = _run([str(binary), "-version"])
        if not re.match(rf"^{name} version {re.escape(policy['version'])}(?:\s|$)", version):
            raise ValueError(f"payload {name} does not report exact {policy['version']}")
        if "--enable-gpl" in version or "--enable-nonfree" in version:
            raise ValueError("GPL or nonfree configure flag in payload")
        _linkage(binary)
    media_proof(directory)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target")
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--sign-identity")
    parser.add_argument("--github-env", action="store_true")
    args = parser.parse_args(argv)
    output = args.output.absolute()
    if args.archive is not None and (args.sign_identity or args.verify_only):
        parser.error("--archive is only valid for payload installation")
    if args.sign_identity:
        sign_payload(output, args.sign_identity, target=args.target, catalog=args.catalog)
    elif args.verify_only:
        verify_payload(output, target=args.target, catalog=args.catalog)
    else:
        ensure_payload(output, target=args.target, catalog=args.catalog, archive=args.archive)
    if args.github_env:
        suffix = ".exe" if platform.system() == "Windows" else ""
        with Path(os.environ["GITHUB_ENV"]).open("a") as handle:
            for name in ("ffmpeg", "ffprobe"):
                handle.write(f"PODCAST_MCP_{name.upper()}={output / 'bin' / (name + suffix)}\n")
        with Path(os.environ["GITHUB_PATH"]).open("a") as handle:
            handle.write(str(output / "bin") + "\n")
    print(f"Verified prebuilt FFmpeg {ffmpeg_policy()['version']} at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
