from __future__ import annotations

import copy
import io
import tarfile

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
    builder.build_payload(output, source_cache=cache)
    assert commands == [["make", "-j2", "ffmpeg.exe", "ffprobe.exe"]]
    assert (output / "bin/ffmpeg.exe").read_bytes() == b"native executable"
    assert (output / "bin/ffprobe.exe").read_bytes() == b"native executable"
