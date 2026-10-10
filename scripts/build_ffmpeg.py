#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from scripts.ffmpeg_payload import _run, _target, prove_payload

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


def _record_producer_integrity(directory: Path) -> None:
    path = directory / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["files"] = {
        file.relative_to(directory).as_posix(): sha256_file(file)
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
    prove_payload(directory, target or _target())
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
        shutil.copy2(ROOT / "scripts/ffmpeg_payload.py", rebuild / "scripts/ffmpeg_payload.py")
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
        _record_producer_integrity(directory)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Produce a new native FFmpeg dependency payload")
    parser.add_argument("--output", type=Path, required=True)
    sources = parser.add_mutually_exclusive_group()
    sources.add_argument("--source-cache", type=Path)
    sources.add_argument("--source-archives", type=Path)
    parser.add_argument("--target")
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args(argv)
    output = args.output.absolute()
    output.mkdir(parents=True)
    build_payload(
        output,
        source_cache=args.source_cache,
        source_archives=args.source_archives,
        target=args.target,
        jobs=args.jobs,
    )
    verify_payload(output, target=args.target)
    print(f"Produced FFmpeg {ffmpeg_policy()['version']} payload at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
