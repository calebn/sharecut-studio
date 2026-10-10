#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.util.atomic_file import publish_completed_file
from podcast_mcp.util.ffmpeg_policy import ffmpeg_policy
from podcast_mcp.util.hashing import sha256_file

ROOT = Path(__file__).resolve().parents[1]


def verify_archive(archive: Path, expected: str) -> None:
    actual = sha256_file(archive)
    if actual != expected:
        raise ValueError(f"sha256 mismatch for {archive.name}: expected {expected}, got {actual}")


def _prepare_sources(directory: Path, *, download: bool) -> dict[str, Path]:
    sources = ffmpeg_policy()["sources"]
    if download:
        directory.mkdir(parents=True, exist_ok=True)
    archives = {}
    for name, source in sources.items():
        filename = source["archive"]
        if Path(filename).name != filename or filename in {".", ".."} or "\\" in filename:
            raise ValueError(f"unsafe source archive name {filename!r}")
        archive = directory / filename
        if not archive.is_file() and download:
            with tempfile.NamedTemporaryFile(
                prefix=f".{filename}-", dir=directory, delete=False
            ) as handle:
                partial = Path(handle.name)
            try:
                _run(
                    [
                        "curl",
                        "--fail",
                        "--location",
                        "--proto",
                        "=https",
                        "--proto-redir",
                        "=https",
                        "--max-time",
                        "120",
                        "--retry",
                        "2",
                        "--max-filesize",
                        "104857600",
                        "--output",
                        str(partial),
                        source["url"],
                    ],
                    timeout=400,
                )
                verify_archive(partial, source["sha256"])
                publish_completed_file(partial, archive)
            finally:
                partial.unlink(missing_ok=True)
        verify_archive(archive, source["sha256"])
        archives[name] = archive
    return archives


def acquire_sources(directory: Path) -> None:
    """Acquire the complete pinned archive set without extracting or compiling."""
    _prepare_sources(directory, download=True)


def safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with tarfile.open(archive) as handle:
        members = handle.getmembers()
        if sum(member.size for member in members) > 1024 * 1024 * 1024:
            raise ValueError("source archive exceeds extraction limit")
        for member in members:
            path = (root / member.name).resolve()
            if not path.is_relative_to(root) or not (member.isfile() or member.isdir()):
                raise ValueError(f"unsafe source archive member {member.name!r}")
        for member in members:
            path = root / member.name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                source = handle.extractfile(member)
                if source is None:
                    raise ValueError(f"unreadable source archive member {member.name!r}")
                with source, path.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                path.chmod(member.mode & 0o755)
                os.utime(path, (member.mtime, member.mtime))


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
        text = _run(["objdump", "-p", str(binary)])
        dependencies = re.findall(r"DLL Name:\s*(\S+)", text)
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


def refresh_integrity(directory: Path) -> None:
    path = directory / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["files"] = {
        str(file.relative_to(directory)): sha256_file(file)
        for file in sorted(directory.rglob("*"))
        if file.is_file() and file != path
    }
    path.write_text(json.dumps(manifest, indent=2) + "\n")


def verify_payload(directory: Path, *, target: str | None = None) -> dict[str, Any]:
    policy = ffmpeg_policy()
    manifest = json.loads((directory / "manifest.json").read_text())
    contract_digest = sha256_file(ROOT / "contracts/ffmpeg-build.json")
    if (
        manifest["contract_sha256"] != contract_digest
        or manifest["target"] != (target or _target())
        or manifest["version"] != policy["version"]
        or manifest["builder_sha256"] != sha256_file(Path(__file__))
    ):
        raise ValueError("payload target, recipe, or release differs from the build policy")
    for relative, expected in manifest["files"].items():
        file = (directory / relative).resolve()
        if not file.is_relative_to(directory.resolve()) or not file.is_file():
            raise ValueError(f"payload file is missing or unsafe: {relative}")
        verify_archive(file, expected)
    for name, source in policy["sources"].items():
        verify_archive(directory / "sources" / source["archive"], source["sha256"])
        if not (directory / "notices" / name).is_dir():
            raise ValueError(f"missing {name} notices")
    suffix = ".exe" if platform.system() == "Windows" else ""
    for name in ("ffmpeg", "ffprobe"):
        binary = directory / "bin" / (name + suffix)
        version = _run([str(binary), "-version"])
        if not re.match(rf"^{name} version {re.escape(policy['version'])}(?:\s|$)", version):
            raise ValueError(f"payload {name} does not report exact {policy['version']}")
        if "--enable-gpl" in version or "--enable-nonfree" in version:
            raise ValueError("GPL or nonfree configure flag in payload")
        _linkage(binary)
    media_proof(directory)
    return manifest


def build_payload(
    directory: Path,
    *,
    source_cache: Path | None = None,
    source_archives: Path | None = None,
    target: str | None = None,
    jobs: int = 2,
) -> dict[str, Any]:
    target = target or _target()
    if target != _target():
        raise ValueError(f"native builder target {target} differs from host {_target()}")
    policy = ffmpeg_policy()
    if source_cache is not None and source_archives is not None:
        raise ValueError("choose source cache or supplied source archives")
    archives = _prepare_sources(
        source_archives
        if source_archives is not None
        else source_cache or directory / "download-cache",
        download=source_archives is None,
    )
    (directory / "sources").mkdir()
    (directory / "notices").mkdir()
    (directory / "bin").mkdir()
    with tempfile.TemporaryDirectory(prefix="ffmpeg-native-") as temp:
        work = Path(temp)
        environment = os.environ.copy()
        prefix = work / "prefix"
        environment.update(PKG_CONFIG_PATH="", PKG_CONFIG_LIBDIR=str(prefix / "lib/pkgconfig"))
        if platform.system() == "Darwin":
            environment["MACOSX_DEPLOYMENT_TARGET"] = policy["macos_deployment_target"]
        logs: dict[str, str] = {}
        for name, source in policy["sources"].items():
            archive = directory / "sources" / source["archive"]
            shutil.copy2(archives[name], archive)
            verify_archive(archive, source["sha256"])
        for name, source in policy["sources"].items():
            safe_extract(directory / "sources" / source["archive"], work)
            source_dir = work / source["directory"]
            notices = directory / "notices" / name
            notices.mkdir()
            for file in source_dir.iterdir():
                if file.is_file() and (
                    file.name.startswith("COPYING")
                    or file.name in {"LICENSE", "LICENSE.md", "README"}
                ):
                    shutil.copy2(file, notices / file.name)
        for name, build_timeout in (("lame", 1800), ("zlib", 600), ("opus", 1800)):
            source = work / policy["sources"][name]["directory"]
            flags = [*policy[f"{name}_configure"], f"--prefix={prefix.as_posix()}"]
            logs[f"{name}-configure"] = _run(
                ["sh", "configure", *flags], cwd=source, env=environment, timeout=300
            )
            logs[f"{name}-build"] = _run(
                ["make", f"-j{min(max(jobs, 1), 8)}"],
                cwd=source,
                env=environment,
                timeout=build_timeout,
            )
            logs[f"{name}-install"] = _run(
                ["make", "install"], cwd=source, env=environment, timeout=300
            )
        ffmpeg = work / policy["sources"]["ffmpeg"]["directory"]
        flags = [
            *policy["ffmpeg_configure"],
            f"--extra-cflags=-I{(prefix / 'include').as_posix()}",
            f"--extra-ldflags=-L{(prefix / 'lib').as_posix()}",
            f"--prefix={prefix.as_posix()}",
        ]
        if platform.system() == "Windows":
            flags.extend(["--target-os=mingw32", "--extra-ldexeflags=-static -static-libgcc"])
        elif platform.system() == "Linux":
            flags.append("--extra-ldexeflags=-static-libgcc")
        logs["ffmpeg-configure"] = _run(
            ["sh", "configure", *flags], cwd=ffmpeg, env=environment, timeout=300
        )
        config = (ffmpeg / "config.h").read_text()
        if "#define CONFIG_GPL 0" not in config or "#define CONFIG_NONFREE 0" not in config:
            raise ValueError("build enabled GPL or nonfree")
        suffix = ".exe" if platform.system() == "Windows" else ""
        programs = [name + suffix for name in ("ffmpeg", "ffprobe")]
        logs["ffmpeg-build"] = _run(
            ["make", f"-j{min(max(jobs, 1), 8)}", *programs],
            cwd=ffmpeg,
            env=environment,
            timeout=3600,
        )
        for name in programs:
            shutil.copy2(ffmpeg / name, directory / "bin" / name)
        rebuild = directory / "rebuild"
        rebuild.mkdir()
        (rebuild / "scripts").mkdir()
        (rebuild / "contracts").mkdir()
        modules = rebuild / "src/podcast_mcp/util"
        modules.mkdir(parents=True)
        (modules.parent / "__init__.py").write_text("")
        (modules / "__init__.py").write_text("")
        for module in ("atomic_file.py", "ffmpeg_policy.py", "hashing.py"):
            shutil.copy2(ROOT / "src/podcast_mcp/util" / module, modules / module)
        shutil.copy2(Path(__file__), rebuild / "scripts/build_ffmpeg.py")
        shutil.copy2(ROOT / "contracts/ffmpeg-build.json", rebuild / "contracts/ffmpeg-build.json")
        for name, text in logs.items():
            (rebuild / f"{name}.log").write_text(text)
        (rebuild / "config.h").write_text(config)
        manifest = {
            "version": policy["version"],
            "target": target,
            "contract_sha256": sha256_file(ROOT / "contracts/ffmpeg-build.json"),
            "builder_sha256": sha256_file(Path(__file__)),
            "os": platform.platform(),
            "compiler": _run(["cc", "--version"]),
            "files": {},
        }
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        refresh_integrity(directory)
    return manifest


def ensure_payload(
    output: Path,
    *,
    source_cache: Path | None = None,
    source_archives: Path | None = None,
    target: str | None = None,
    jobs: int = 2,
) -> dict[str, Any]:
    if source_cache is not None and source_archives is not None:
        raise ValueError("choose source cache or supplied source archives")
    if source_archives is not None:
        _prepare_sources(source_archives, download=False)
    try:
        return verify_payload(output, target=target)
    except (OSError, ValueError, KeyError, RuntimeError):
        pass
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-", dir=output.parent) as temp:
        stage = Path(temp) / "payload"
        stage.mkdir()
        build_payload(
            stage,
            source_cache=source_cache,
            source_archives=source_archives,
            target=target,
            jobs=jobs,
        )
        manifest = verify_payload(stage, target=target)
        previous = Path(temp) / "previous"
        if output.exists():
            output.rename(previous)
        try:
            stage.rename(output)
        except OSError:
            if previous.exists():
                previous.rename(output)
            raise
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    sources = parser.add_mutually_exclusive_group()
    sources.add_argument("--source-cache", type=Path)
    sources.add_argument("--source-archives", type=Path)
    parser.add_argument("--acquire-sources", action="store_true")
    parser.add_argument("--target")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--refresh-integrity", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args(argv)
    if args.acquire_sources:
        if args.source_cache is None or args.output or args.verify_only or args.refresh_integrity:
            parser.error("--acquire-sources requires --source-cache and no payload operation")
        acquire_sources(args.source_cache.absolute())
        print(f"Verified original FFmpeg sources at {args.source_cache}")
        return 0
    if args.output is None:
        parser.error("--output is required for payload operations")
    if args.verify_only:
        verify_payload(args.output, target=args.target)
        return 0
    if args.refresh_integrity:
        refresh_integrity(args.output)
        verify_payload(args.output, target=args.target)
        return 0
    ensure_payload(
        args.output.absolute(),
        source_cache=args.source_cache,
        source_archives=args.source_archives,
        target=args.target,
        jobs=args.jobs,
    )
    print(f"Verified FFmpeg {ffmpeg_policy()['version']} native payload at {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
