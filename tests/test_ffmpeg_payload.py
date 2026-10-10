from __future__ import annotations

import copy
import io
import json
import shutil
import struct
import tarfile
from pathlib import Path

import pytest

from script_loader import load_script

TARGET = "x86_64-unknown-linux-gnu"


@pytest.fixture
def payload(tmp_path, monkeypatch):
    owner = load_script("ffmpeg_payload", register=True)
    policy = copy.deepcopy(owner.ffmpeg_policy())
    origin = tmp_path / "origin"
    files = {
        "bin/ffmpeg": b"ffmpeg9",
        "bin/ffprobe": b"ffprobe9",
        "rebuild/config.h": b"#define CONFIG_GPL 0\n#define CONFIG_NONFREE 0\n",
        "rebuild/scripts/build_ffmpeg.py": b"historical producer",
    }
    for name, source in policy["sources"].items():
        content = f"pinned {name} source".encode()
        source["sha256"] = owner.hashlib.sha256(content).hexdigest()
        files["sources/" + source["archive"]] = content
        files[f"notices/{name}/COPYING"] = b"corresponding license notice"
    files["rebuild/contracts/ffmpeg-build.json"] = json.dumps(policy).encode()
    for name, content in files.items():
        path = origin / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    manifest = {
        "target": TARGET,
        "version": "9.0.2",
        "contract_sha256": "historical recipe digest",
        "builder_sha256": "historical producer digest",
        "compiler": "historical native compiler",
        "files": {
            name: owner.hashlib.sha256(content).hexdigest() for name, content in files.items()
        },
    }
    catalog = tmp_path / "catalog.json"
    archive = tmp_path / "release.tar.xz"

    def pack():
        (origin / "manifest.json").write_text(json.dumps(manifest))
        with tarfile.open(archive, "w:xz") as handle:
            for file in sorted(origin.rglob("*")):
                if file.is_file():
                    handle.add(file, arcname=file.relative_to(origin).as_posix())
        catalog.write_text(
            json.dumps(
                {
                    "version": "9.0.2",
                    "targets": {
                        TARGET: {
                            "url": "https://fixtures.example.test/release.tar.xz",
                            "sha256": owner.sha256_file(archive),
                            "manifest_sha256": owner.sha256_file(origin / "manifest.json"),
                        }
                    },
                }
            )
        )

    pack()
    monkeypatch.setattr(owner, "ffmpeg_policy", lambda: policy)
    monkeypatch.setattr(owner, "_download", lambda _artifact, dest: shutil.copyfile(archive, dest))
    proofs = []
    monkeypatch.setattr(
        owner, "prove_payload", lambda directory, target: proofs.append((directory, target))
    )
    return owner, origin, archive, catalog, manifest, pack, proofs


def install(payload, output):
    owner, _, _, catalog, _, _, _ = payload
    return owner.ensure_payload(output, target=TARGET, catalog=catalog)


def test_acquire_reuse_and_corrupt_pair_repair_preserve_provenance(payload, tmp_path, monkeypatch):
    owner, origin, _, catalog, manifest, _, proofs = payload
    output = tmp_path / "installed"
    assert install(payload, output) == manifest
    pristine_manifest = (output / "manifest.json").read_bytes()
    monkeypatch.setattr(owner, "_download", lambda *_: pytest.fail("downloaded intact payload"))
    assert install(payload, output)["builder_sha256"] == "historical producer digest"
    monkeypatch.setattr(
        owner, "_download", lambda _artifact, dest: shutil.copyfile(payload[2], dest)
    )
    (output / "bin/ffprobe").write_bytes(b"different pair")
    install(payload, output)
    assert (output / "bin/ffprobe").read_bytes() == b"ffprobe9"
    assert (output / "manifest.json").read_bytes() == pristine_manifest
    assert (output / "rebuild/scripts/build_ffmpeg.py").read_bytes() == b"historical producer"
    assert len(proofs) == 3
    assert owner.verify_payload(output, target=TARGET, catalog=catalog) == manifest
    assert (origin / "manifest.json").read_bytes() == pristine_manifest


def test_corrupt_archive_fails_before_tar_open_or_execution(payload, tmp_path, monkeypatch):
    owner, _, archive, _, _, _, _ = payload
    archive.write_bytes(b"corrupt download")
    monkeypatch.setattr(
        owner.tarfile, "open", lambda *_a, **_k: pytest.fail("opened unadmitted archive")
    )
    monkeypatch.setattr(owner, "prove_payload", lambda *_: pytest.fail("executed unadmitted bytes"))
    with pytest.raises(ValueError, match="sha256"):
        install(payload, tmp_path / "installed")
    assert not (tmp_path / "installed").exists()


@pytest.mark.parametrize(
    "damage",
    ["mixed-pair", "source-pin", "missing-notice", "missing-source", "wrong-target", "recipe"],
)
def test_manifest_and_materials_fail_before_execution(payload, tmp_path, monkeypatch, damage):
    owner, origin, _, _, manifest, pack, _ = payload
    if damage == "mixed-pair":
        (origin / "bin/ffprobe").write_bytes(b"another release")
    elif damage == "source-pin":
        source = origin / "sources" / owner.ffmpeg_policy()["sources"]["opus"]["archive"]
        source.write_bytes(b"different source")
        manifest["files"][source.relative_to(origin).as_posix()] = owner.sha256_file(source)
    elif damage in {"missing-notice", "missing-source"}:
        prefix = "notices/opus/" if damage == "missing-notice" else "sources/opus-"
        name = next(name for name in manifest["files"] if name.startswith(prefix))
        del manifest["files"][name]
        (origin / name).unlink()
    elif damage == "wrong-target":
        manifest["target"] = "aarch64-apple-darwin"
    else:
        name = "rebuild/contracts/ffmpeg-build.json"
        recipe = json.loads((origin / name).read_text())
        recipe["ffmpeg_configure"].append("--enable-gpl")
        (origin / name).write_text(json.dumps(recipe))
        manifest["files"][name] = owner.sha256_file(origin / name)
    pack()
    monkeypatch.setattr(owner, "prove_payload", lambda *_: pytest.fail("executed rejected payload"))
    with pytest.raises(ValueError):
        install(payload, tmp_path / "installed")


@pytest.mark.parametrize(
    "name,kind",
    [
        ("../outside", tarfile.REGTYPE),
        ("bin/escape", tarfile.SYMTYPE),
        ("bin/ffmpeg", tarfile.REGTYPE),
        ("unexpected", tarfile.REGTYPE),
        ("C:/escape", tarfile.REGTYPE),
    ],
)
def test_archive_rejects_unsafe_duplicate_or_unlisted_members(
    payload, tmp_path, monkeypatch, name, kind
):
    owner, origin, archive, catalog, _, _, _ = payload
    with tarfile.open(archive, "w:xz") as handle:
        for file in origin.rglob("*"):
            if file.is_file():
                handle.add(file, arcname=file.relative_to(origin).as_posix())
        member = tarfile.TarInfo(name)
        member.type = kind
        member.linkname = "../../outside"
        member.size = 1 if kind == tarfile.REGTYPE else 0
        handle.addfile(member, io.BytesIO(b"x") if member.size else None)
    data = json.loads(catalog.read_text())
    data["targets"][TARGET]["sha256"] = owner.sha256_file(archive)
    catalog.write_text(json.dumps(data))
    monkeypatch.setattr(owner, "prove_payload", lambda *_: pytest.fail("executed unsafe archive"))
    with pytest.raises(ValueError):
        install(payload, tmp_path / "installed")
    assert not (tmp_path / "outside").exists()


def test_bounded_archive_refused_before_extraction(payload, tmp_path, monkeypatch):
    owner = payload[0]
    monkeypatch.setattr(owner, "MAX_UNPACKED_BYTES", 1)
    with pytest.raises(ValueError, match="limit"):
        install(payload, tmp_path / "installed")


def test_failed_replacement_restores_prior_payload(payload, tmp_path, monkeypatch):
    output = tmp_path / "installed"
    output.mkdir()
    (output / "prior").write_bytes(b"prior payload")
    rename = Path.rename

    def fail_stage(path, destination):
        if path.name == "payload":
            raise OSError("publication failed")
        return rename(path, destination)

    monkeypatch.setattr(Path, "rename", fail_stage)
    with pytest.raises(OSError, match="publication failed"):
        install(payload, output)
    assert (output / "prior").read_bytes() == b"prior payload"
    assert not list(tmp_path.glob(".installed-*"))


def test_closed_installed_inventory_and_symlinks_trigger_repair(payload, tmp_path):
    output = tmp_path / "installed"
    install(payload, output)
    (output / "unexpected").write_bytes(b"extra")
    install(payload, output)
    assert not (output / "unexpected").exists()
    (output / "bin/ffprobe").unlink()
    (output / "bin/ffprobe").symlink_to(payload[1] / "bin/ffprobe")
    install(payload, output)
    assert not (output / "bin/ffprobe").is_symlink()


def test_signing_preserves_admitted_origin_and_refuses_prior_corruption(
    payload, tmp_path, monkeypatch
):
    owner, _, _, catalog, manifest, pack, _ = payload
    target = "x86_64-apple-darwin"
    manifest["target"] = target
    pack()
    data = json.loads(catalog.read_text())
    data["targets"][target] = data["targets"].pop(TARGET)
    catalog.write_text(json.dumps(data))
    output = tmp_path / "installed"
    owner.ensure_payload(output, target=target, catalog=catalog)
    original = (output / "manifest.json").read_bytes()
    calls = []

    def sign(argv, **_kwargs):
        calls.append(argv)
        if "--sign" in argv:
            binary = Path(argv[-1])
            binary.write_bytes(binary.read_bytes() + b" signed")
        return ""

    monkeypatch.setattr(owner, "_run", sign)
    owner.sign_payload(output, "Developer ID fixture", target=target, catalog=catalog)
    receipt = json.loads((output / owner.SIGNED_RECEIPT).read_text())
    assert receipt["archive_sha256"] == data["targets"][target]["sha256"]
    assert receipt["files"]["bin/ffmpeg"] == owner.sha256_file(output / "bin/ffmpeg")
    assert (output / "manifest.json").read_bytes() == original
    assert owner.verify_payload(output, target=target, catalog=catalog) == manifest
    assert len([call for call in calls if "--sign" in call]) == 2
    (output / "bin/ffmpeg").write_bytes(b"untrusted replacement")
    calls.clear()
    with pytest.raises(ValueError, match="sha256"):
        owner.sign_payload(output, "Developer ID fixture", target=target, catalog=catalog)
    assert not calls


@pytest.mark.parametrize(
    "target,cpu", [("x86_64-apple-darwin", 0x1000007), ("aarch64-apple-darwin", 0x100000C)]
)
def test_architecture_checks_actual_macho_header(tmp_path, target, cpu):
    owner = load_script("ffmpeg_payload", register=True)
    binary = tmp_path / "binary"
    binary.write_bytes(b"\xcf\xfa\xed\xfe" + struct.pack("<I", cpu) + bytes(56))
    owner._architecture(binary, target)
    other = "aarch64-apple-darwin" if target.startswith("x86") else "x86_64-apple-darwin"
    with pytest.raises(ValueError, match="architecture"):
        owner._architecture(binary, other)


def test_missing_catalog_fails_without_acquisition(tmp_path, monkeypatch):
    owner = load_script("ffmpeg_payload", register=True)
    monkeypatch.setattr(owner, "_download", lambda *_: pytest.fail("downloaded without admission"))
    with pytest.raises(ValueError, match="no admitted artifact"):
        owner.ensure_payload(tmp_path / "out", target=TARGET, catalog=tmp_path / "missing.json")


def test_explicit_archive_admitted_before_installed_reuse_without_fallback(
    payload, tmp_path, monkeypatch
):
    owner, _, archive, catalog, _, _, _ = payload
    output = tmp_path / "installed"
    owner.ensure_payload(output, target=TARGET, catalog=catalog, archive=archive)
    expected = (output / "bin/ffmpeg").read_bytes()
    monkeypatch.setattr(
        owner, "_download", lambda *_: pytest.fail("fallback after explicit archive")
    )
    archive.write_bytes(b"corrupt explicitly selected archive")
    with pytest.raises(ValueError, match="sha256"):
        owner.ensure_payload(output, target=TARGET, catalog=catalog, archive=archive)
    assert (output / "bin/ffmpeg").read_bytes() == expected


def test_importer_cli_exports_absolute_pair_paths(payload, tmp_path, monkeypatch):
    owner, _, archive, catalog, _, _, _ = payload
    environment = tmp_path / "github-env"
    search_path = tmp_path / "github-path"
    monkeypatch.setenv("GITHUB_ENV", str(environment))
    monkeypatch.setenv("GITHUB_PATH", str(search_path))
    monkeypatch.setattr(owner.platform, "system", lambda: "Linux")
    output = tmp_path / "installed"
    assert (
        owner.main(
            [
                "--output",
                str(output),
                "--target",
                TARGET,
                "--catalog",
                str(catalog),
                "--archive",
                str(archive),
                "--github-env",
            ]
        )
        == 0
    )
    assert environment.read_text().splitlines() == [
        f"PODCAST_MCP_FFMPEG={output}/bin/ffmpeg",
        f"PODCAST_MCP_FFPROBE={output}/bin/ffprobe",
    ]
    assert search_path.read_text() == f"{output}/bin\n"


def test_pe_imports_are_read_without_toolchain(tmp_path):
    owner = load_script("ffmpeg_payload", register=True)
    data = bytearray(512)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 60, 64)
    data[64:68] = b"PE\0\0"
    struct.pack_into("<HH", data, 68, 0x8664, 1)
    struct.pack_into("<H", data, 84, 128)
    struct.pack_into("<H", data, 88, 0x20B)
    struct.pack_into("<II", data, 208, 0x1000, 40)
    struct.pack_into("<IIII", data, 224, 128, 0x1000, 128, 256)
    struct.pack_into("<IIIII", data, 256, 0, 0, 0, 0x1040, 0)
    data[320:333] = b"KERNEL32.dll\0"
    binary = tmp_path / "ffmpeg.exe"
    binary.write_bytes(data)
    assert owner._windows_imports(binary) == ["KERNEL32.dll"]
    owner._architecture(binary, "x86_64-pc-windows-msvc")
    struct.pack_into("<H", data, 68, 0xAA64)
    binary.write_bytes(data)
    with pytest.raises(ValueError, match="architecture"):
        owner._architecture(binary, "x86_64-pc-windows-msvc")
