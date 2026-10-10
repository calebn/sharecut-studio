from __future__ import annotations

import copy
import io
import tarfile
from pathlib import Path

import pytest

from script_loader import load_script


def test_source_hash_failure_does_not_extract(tmp_path):
    builder = load_script("build_ffmpeg")
    archive = tmp_path / "source.tar"
    archive.write_bytes(b"changed upstream source")
    with pytest.raises(ValueError, match="sha256"):
        builder.verify_archive(archive, "0" * 64)


def test_archive_cannot_escape_output(tmp_path):
    builder = load_script("build_ffmpeg")
    archive = tmp_path / "source.tar"
    with tarfile.open(archive, "w") as handle:
        entry = tarfile.TarInfo("../outside")
        entry.size = 1
        handle.addfile(entry, io.BytesIO(b"x"))
    with pytest.raises(ValueError, match="unsafe"):
        builder.safe_extract(archive, tmp_path / "unpacked")
    assert not (tmp_path / "outside").exists()


def test_failed_build_leaves_previous_payload(tmp_path, monkeypatch):
    builder = load_script("build_ffmpeg")
    output = tmp_path / "payload"
    output.mkdir()
    (output / "prior").write_text("complete prior payload")
    monkeypatch.setattr(
        builder, "verify_payload", lambda *_a, **_k: (_ for _ in ()).throw(ValueError("broken"))
    )
    monkeypatch.setattr(
        builder,
        "build_payload",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("configure failed")),
    )
    with pytest.raises(RuntimeError, match="configure failed"):
        builder.ensure_payload(output)
    assert (output / "prior").read_text() == "complete prior payload"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["payload"]


def test_pair_publication_is_complete_before_replace(tmp_path, monkeypatch):
    builder = load_script("build_ffmpeg")
    output = tmp_path / "payload"
    seen = []

    def build(stage, **kwargs):
        (stage / "bin").mkdir()
        for name in ("ffmpeg", "ffprobe"):
            (stage / "bin" / name).write_text(name)
        return {"version": "9.0.2"}

    def verify(path, **kwargs):
        if not path.exists():
            raise ValueError("missing")
        seen.append(sorted(p.name for p in (path / "bin").iterdir()))
        return {"version": "9.0.2"}

    monkeypatch.setattr(builder, "build_payload", build)
    monkeypatch.setattr(builder, "verify_payload", verify)
    builder.ensure_payload(output)
    assert seen == [["ffmpeg", "ffprobe"]]
    assert (output / "bin" / "ffprobe").read_text() == "ffprobe"
    builder.ensure_payload(output)
    assert seen == [["ffmpeg", "ffprobe"], ["ffmpeg", "ffprobe"]]


def test_macos_minimum_ignores_linker_tool_version(monkeypatch, tmp_path):
    builder = load_script("build_ffmpeg")
    monkeypatch.setattr(builder.platform, "system", lambda: "Darwin")

    def run(argv, **kwargs):
        if argv[1] == "-L":
            return "ffmpeg:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n"
        return "Load command 1\n cmd LC_BUILD_VERSION\n minos 12.0\n ntools 1\n tool LD\n version 1225.1\n"

    monkeypatch.setattr(builder, "_run", run)
    assert "/usr/lib/libSystem.B.dylib" in builder._linkage(tmp_path / "ffmpeg")


def test_unknown_native_architecture_fails(monkeypatch):
    builder = load_script("build_ffmpeg")
    monkeypatch.setattr(builder.platform, "machine", lambda: "mips")
    with pytest.raises(ValueError, match="unsupported native architecture"):
        builder._target()


def test_macos_recipe_matches_advertised_app_minimum():
    import json
    from pathlib import Path

    root = Path(__file__).parents[1]
    recipe = json.loads((root / "contracts/ffmpeg-build.json").read_text())
    app = json.loads((root / "gui/desktop/src-tauri/tauri.conf.json").read_text())
    assert recipe["macos_deployment_target"] == app["bundle"]["macOS"]["minimumSystemVersion"]


def test_safe_extract_supports_original_python_311_api(tmp_path, monkeypatch):
    builder = load_script("build_ffmpeg")
    archive = tmp_path / "source.tar"
    with tarfile.open(archive, "w") as handle:
        entry = tarfile.TarInfo("source/configure")
        entry.mode = 0o4755
        entry.size = 4
        handle.addfile(entry, io.BytesIO(b"test"))
    original = tarfile.TarFile.extractall

    def extractall(self, path=".", members=None, *, numeric_owner=False):
        original(self, path, members, numeric_owner=numeric_owner)

    monkeypatch.setattr(tarfile.TarFile, "extractall", extractall)
    builder.safe_extract(archive, tmp_path / "unpacked")
    extracted = tmp_path / "unpacked/source/configure"
    assert extracted.read_bytes() == b"test"
    assert extracted.stat().st_mode & 0o7000 == 0


@pytest.mark.parametrize("kind", [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE])
def test_safe_extract_rejects_nonregular_members(tmp_path, kind):
    builder = load_script("build_ffmpeg")
    archive = tmp_path / "source.tar"
    with tarfile.open(archive, "w") as handle:
        entry = tarfile.TarInfo("source/unsafe")
        entry.type = kind
        entry.linkname = "../../outside"
        handle.addfile(entry)
    with pytest.raises(ValueError, match="unsafe"):
        builder.safe_extract(archive, tmp_path / "unpacked")
    assert not (tmp_path / "unpacked/source/unsafe").exists()


def test_static_recipe_requests_private_pkg_config_dependencies():
    builder = load_script("build_ffmpeg")
    assert "--pkg-config-flags=--static" in builder.ffmpeg_policy()["ffmpeg_configure"]


def test_safe_extract_preserves_generated_source_timestamps(tmp_path):
    builder = load_script("build_ffmpeg")
    archive = tmp_path / "source.tar"
    with tarfile.open(archive, "w") as handle:
        for name, timestamp in (("config.h.in", 1768341846), ("aclocal.m4", 1768341843)):
            entry = tarfile.TarInfo("source/" + name)
            entry.size = 1
            entry.mtime = timestamp
            handle.addfile(entry, io.BytesIO(b"x"))
    builder.safe_extract(archive, tmp_path / "unpacked")
    source = tmp_path / "unpacked/source"
    assert (source / "config.h.in").stat().st_mtime == 1768341846
    assert (source / "aclocal.m4").stat().st_mtime == 1768341843


@pytest.mark.parametrize("directory", ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu"])
def test_linux_linkage_accepts_system_glibc_vector_math(tmp_path, monkeypatch, directory):
    builder = load_script("build_ffmpeg")
    monkeypatch.setattr(builder.platform, "system", lambda: "Linux")
    evidence = f"libmvec.so.1 => {directory}/libmvec.so.1 (0x1234)\n"
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: evidence)
    assert builder._linkage(tmp_path / "ffmpeg") == evidence


@pytest.mark.parametrize(
    "dependency",
    [
        "libmvec.so.1 => /tmp/libmvec.so.1 (0x1234)",
        "libmvec.so.1 => /usr/lib/../../tmp/libmvec.so.1 (0x1234)",
        "libopus.so.0 => /usr/lib/libopus.so.0 (0x1234)",
        "libmvec.so.1 => not found",
    ],
)
def test_linux_linkage_rejects_external_or_missing_dependencies(tmp_path, monkeypatch, dependency):
    builder = load_script("build_ffmpeg")
    monkeypatch.setattr(builder.platform, "system", lambda: "Linux")
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: dependency + "\n")
    with pytest.raises(ValueError, match="non-system native linkage"):
        builder._linkage(tmp_path / "ffmpeg")


def test_windows_builder_requests_and_stages_executable_targets(tmp_path, monkeypatch):
    builder = load_script("build_ffmpeg")
    policy = copy.deepcopy(builder.ffmpeg_policy())
    cache = tmp_path / "sources"
    cache.mkdir()
    for source in policy["sources"].values():
        archive = cache / source["archive"]
        with tarfile.open(archive, "w") as handle:
            entry = tarfile.TarInfo(source["directory"] + "/COPYING")
            entry.size = 7
            handle.addfile(entry, io.BytesIO(b"license"))
        source["sha256"] = builder.sha256_file(archive)
    monkeypatch.setattr(builder, "ffmpeg_policy", lambda: policy)
    monkeypatch.setattr(builder.platform, "system", lambda: "Windows")
    monkeypatch.setattr(builder.platform, "machine", lambda: "AMD64")
    commands = []

    def native_tool(argv, *, cwd=None, **kwargs):
        if argv[0] == "curl":
            pytest.fail("supplied sources triggered a download")
        if cwd and cwd.name == policy["sources"]["ffmpeg"]["directory"]:
            if argv[:2] == ["sh", "configure"]:
                (cwd / "config.h").write_text("#define CONFIG_GPL 0\n#define CONFIG_NONFREE 0\n")
            elif argv[0] == "make":
                commands.append(argv)
                if argv[2:] != ["ffmpeg.exe", "ffprobe.exe"]:
                    raise RuntimeError("No rule to make target 'ffmpeg'")
                for name in ("ffmpeg.exe", "ffprobe.exe"):
                    (cwd / name).write_bytes(b"native executable")
        return "native tool completed\n"

    monkeypatch.setattr(builder, "_run", native_tool)
    output = tmp_path / "payload"
    output.mkdir()
    builder.build_payload(output, source_archives=cache)
    assert commands == [["make", "-j2", "ffmpeg.exe", "ffprobe.exe"]]
    assert (output / "bin/ffmpeg.exe").read_bytes() == b"native executable"
    assert (output / "bin/ffprobe.exe").read_bytes() == b"native executable"
    for source in policy["sources"].values():
        assert (output / "sources" / source["archive"]).read_bytes() == (
            cache / source["archive"]
        ).read_bytes()
    rebuild = output / "rebuild"
    assert (rebuild / "scripts/build_ffmpeg.py").read_bytes() == Path(builder.__file__).read_bytes()
    for name in ("atomic_file.py", "ffmpeg_policy.py", "hashing.py"):
        assert (rebuild / "src/podcast_mcp/util" / name).read_bytes() == (
            builder.ROOT / "src/podcast_mcp/util" / name
        ).read_bytes()


def test_windows_media_proof_uses_canonical_systemroot_for_every_child(tmp_path, monkeypatch):
    builder = load_script("build_ffmpeg")
    monkeypatch.setattr(builder.platform, "system", lambda: "Windows")
    system_root = tmp_path / "Windows"
    original_environment = {
        "PATH": "C:\\toolchain\\bin;C:\\Windows\\System32",
        "SYSTEMROOT": str(system_root),
        "DYLD_LIBRARY_PATH": "toolchain-dylib",
        "DYLD_FALLBACK_LIBRARY_PATH": "toolchain-fallback",
        "LD_LIBRARY_PATH": "toolchain-ld",
    }
    monkeypatch.setattr(builder.os, "environ", original_environment)
    child_environments = []

    def run(argv, *, env=None, **_kwargs):
        child_environments.append(env)
        if argv[0].endswith("ffprobe.exe"):
            codec = Path(argv[-1]).stem
            codec = {"libmp3lame": "mp3", "libopus": "opus"}.get(codec, codec)
            return f'{{"streams":[{{"codec_name":"{codec}","sample_rate":"48000"}}]}}'
        if "-af" in argv:
            return (
                "True peak: -1 dBTP"
                if argv[argv.index("-af") + 1].startswith("ebur128")
                else '{"input_tp":"-1.0"}'
            )
        if "-frames:v" in argv:
            Path(argv[-1]).write_bytes(b"\x89PNG\r\n\x1a\nproof")
        elif "-ar" in argv:
            Path(argv[-1]).write_bytes(b"f" * (44100 * 4))
        elif "-f" in argv and argv[argv.index("-f") + 1] == "f32le":
            Path(argv[-1]).write_bytes(b"f" * (48000 * 4))
        elif argv[-1] != "-":
            Path(argv[-1]).write_bytes(b"encoded audio")
        return ""

    monkeypatch.setattr(builder, "_run", run)
    result = builder.media_proof(tmp_path / "payload")

    assert result == {
        "codecs": ["pcm_s16le", "pcm_f32le", "flac", "aac", "libmp3lame", "libopus"],
        "resampling": "48000 to 44100",
        "filters": ["ebur128", "loudnorm", "showwavespic"],
    }
    assert len(child_environments) == 22
    assert all(
        environment["PATH"] == str(system_root / "System32")
        and environment["SYSTEMROOT"] == str(system_root)
        and "toolchain" not in environment["PATH"]
        and all(
            key not in environment
            for key in (
                "DYLD_LIBRARY_PATH",
                "DYLD_FALLBACK_LIBRARY_PATH",
                "LD_LIBRARY_PATH",
            )
        )
        for environment in child_environments
    )
    assert original_environment == {
        "PATH": "C:\\toolchain\\bin;C:\\Windows\\System32",
        "SYSTEMROOT": str(system_root),
        "DYLD_LIBRARY_PATH": "toolchain-dylib",
        "DYLD_FALLBACK_LIBRARY_PATH": "toolchain-fallback",
        "LD_LIBRARY_PATH": "toolchain-ld",
    }


def test_windows_linkage_accepts_native_recipe_sdk_imports(tmp_path, monkeypatch, capsys):
    builder = load_script("build_ffmpeg")
    monkeypatch.setattr(builder.platform, "system", lambda: "Windows")
    evidence = (
        "DLL Name: GDI32.dll\n"
        "DLL Name: OLEAUT32.dll\n"
        "DLL Name: SHLWAPI.dll\n"
        "DLL Name: AVICAP32.dll\n"
        "DLL Name: KERNEL32.dll\n"
        "DLL Name: api-ms-win-crt-runtime-l1-1-0.dll\n"
    )
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: evidence)
    assert builder._linkage(tmp_path / "ffmpeg.exe") == evidence
    assert capsys.readouterr().out == (
        f"Windows native imports for {tmp_path / 'ffmpeg.exe'}: "
        "['GDI32.dll', 'OLEAUT32.dll', 'SHLWAPI.dll', 'AVICAP32.dll', 'KERNEL32.dll', "
        "'api-ms-win-crt-runtime-l1-1-0.dll']\n"
    )


@pytest.mark.parametrize(
    "dependency",
    [
        "libopus-0.dll",
        "libmp3lame-0.dll",
        "libgcc_s_seh-1.dll",
        "libwinpthread-1.dll",
        "api-ms-win-../../libopus.dll",
        "api-ms-win-..\\libopus.dll",
        "api-ms-win-crt-runtime-l1-1-0.exe",
        "api-ms-win-crt-runtime-l1-1-0.dll/extra",
        "api-ms-win-crt-runtime.dll",
        "C:\\Windows\\System32\\KERNEL32.dll",
        "../KERNEL32.dll",
    ],
)
def test_windows_linkage_rejects_external_or_malformed_imports(
    tmp_path, monkeypatch, dependency, capsys
):
    builder = load_script("build_ffmpeg")
    monkeypatch.setattr(builder.platform, "system", lambda: "Windows")
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: "DLL Name: " + dependency + "\n")
    with pytest.raises(ValueError, match="non-system native linkage"):
        builder._linkage(tmp_path / "ffmpeg.exe")
    assert capsys.readouterr().out == (
        f"Windows native imports for {tmp_path / 'ffmpeg.exe'}: {[dependency]!r}\n"
    )


def test_windows_linkage_rejects_missing_import_evidence(tmp_path, monkeypatch):
    builder = load_script("build_ffmpeg")
    monkeypatch.setattr(builder.platform, "system", lambda: "Windows")
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: "no import table\n")
    with pytest.raises(ValueError, match="non-system native linkage"):
        builder._linkage(tmp_path / "ffmpeg.exe")


@pytest.fixture
def source_delivery(tmp_path, monkeypatch):
    builder = load_script("build_ffmpeg")
    policy = copy.deepcopy(builder.ffmpeg_policy())
    cache = tmp_path / "archives"
    cache.mkdir()
    for source in policy["sources"].values():
        archive = cache / source["archive"]
        archive.write_bytes(b"original pinned source " + archive.name.encode())
        source["sha256"] = builder.sha256_file(archive)
    monkeypatch.setattr(builder, "ffmpeg_policy", lambda: policy)
    return builder, policy, cache


def test_source_only_cli_never_extracts_or_compiles(source_delivery, monkeypatch):
    builder, _, cache = source_delivery
    monkeypatch.setattr(builder, "safe_extract", lambda *_: pytest.fail("extracted"))
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: pytest.fail("compiled or downloaded"))
    assert builder.main(["--acquire-sources", "--source-cache", str(cache)]) == 0
    assert len(list(cache.iterdir())) == 4


@pytest.mark.parametrize("damage", ["missing", "corrupt", "misnamed"])
def test_supplied_sources_rejected_before_payload_reuse(source_delivery, monkeypatch, damage):
    builder, policy, cache = source_delivery
    archive = cache / policy["sources"]["opus"]["archive"]
    if damage == "missing":
        archive.unlink()
    elif damage == "misnamed":
        archive.rename(cache / "wrong-name.tar.gz")
    else:
        archive.write_bytes(b"corrupt")
    monkeypatch.setattr(builder, "verify_payload", lambda *_a, **_k: pytest.fail("reused"))
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: pytest.fail("download fallback"))
    with pytest.raises((ValueError, FileNotFoundError)):
        builder.ensure_payload(cache.parent / "payload", source_archives=cache)


def test_supplied_source_copy_change_refused_before_any_extraction(source_delivery, monkeypatch):
    builder, policy, cache = source_delivery
    original = builder.shutil.copy2

    def changed_copy(src, dst, **kwargs):
        result = original(src, dst, **kwargs)
        if Path(dst).name == policy["sources"]["opus"]["archive"]:
            Path(dst).write_bytes(b"changed while copied")
        return result

    monkeypatch.setattr(builder.shutil, "copy2", changed_copy)
    monkeypatch.setattr(builder, "safe_extract", lambda *_: pytest.fail("extracted"))
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: pytest.fail("download fallback"))
    output = cache.parent / "payload"
    output.mkdir()
    with pytest.raises(ValueError, match="sha256"):
        builder.build_payload(output, source_archives=cache)


@pytest.mark.parametrize("failure", ["partial", "corrupt", "none"])
def test_source_acquisition_atomic_publication(source_delivery, monkeypatch, failure):
    builder, policy, cache = source_delivery
    source = policy["sources"]["opus"]
    archive = cache / source["archive"]
    content = archive.read_bytes()
    archive.unlink()
    commands = []

    def download(argv, **kwargs):
        commands.append(argv)
        destination = Path(argv[argv.index("--output") + 1])
        assert destination.parent == cache
        assert not archive.exists()
        destination.write_bytes(b"partial" if failure != "none" else content)
        if failure == "partial":
            raise RuntimeError("interrupted transfer")
        return "downloaded"

    monkeypatch.setattr(builder, "_run", download)
    if failure == "none":
        assert builder.main(["--acquire-sources", "--source-cache", str(cache)]) == 0
        assert archive.read_bytes() == content
    else:
        with pytest.raises((ValueError, RuntimeError)):
            builder.main(["--acquire-sources", "--source-cache", str(cache)])
        assert not archive.exists()
    assert sorted(p.name for p in cache.iterdir()) == sorted(
        s["archive"] for s in policy["sources"].values() if failure == "none" or s is not source
    )
    assert commands[0][-1] == source["url"]
    assert "--proto-redir" in commands[0]
    assert "=https" in commands[0]


def test_valid_supplied_sources_admitted_before_reuse(source_delivery, monkeypatch):
    builder, _, cache = source_delivery
    monkeypatch.setattr(builder, "verify_payload", lambda *_a, **_k: {"version": "9.0.2"})
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: pytest.fail("network or compiler"))
    assert builder.ensure_payload(cache.parent / "payload", source_archives=cache) == {
        "version": "9.0.2"
    }


def test_local_build_acquires_and_checks_complete_set_before_extraction(
    source_delivery, monkeypatch
):
    builder, policy, cache = source_delivery
    source = policy["sources"]["opus"]
    archive = cache / source["archive"]
    content = archive.read_bytes()
    archive.unlink()

    def download(argv, **kwargs):
        assert argv[0] == "curl"
        Path(argv[argv.index("--output") + 1]).write_bytes(content)
        return "original source"

    def extraction(archive, destination):
        assert archive.parent.name == "sources"
        assert archive.read_bytes() == (cache / archive.name).read_bytes()
        raise RuntimeError("reached extraction with admitted sources")

    monkeypatch.setattr(builder, "_run", download)
    monkeypatch.setattr(builder, "safe_extract", extraction)
    output = cache.parent / "payload"
    output.mkdir()
    with pytest.raises(RuntimeError, match="reached extraction"):
        builder.build_payload(output, source_cache=cache)
    assert archive.read_bytes() == content


@pytest.mark.parametrize("filename", ["../escape.tar", "/outside.tar", "..", "nested\\archive.tar"])
def test_source_archive_names_are_checked_at_boundary(source_delivery, monkeypatch, filename):
    builder, policy, cache = source_delivery
    policy["sources"]["opus"]["archive"] = filename
    monkeypatch.setattr(builder, "_run", lambda *_a, **_k: pytest.fail("download"))
    with pytest.raises(ValueError, match="unsafe source archive name"):
        builder.main(["--acquire-sources", "--source-cache", str(cache)])
