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


@pytest.mark.parametrize("failure", [OSError("publication failed"), KeyboardInterrupt("Ctrl-C")])
@pytest.mark.parametrize("boundary", ["old-moved", "new-publication"])
def test_failed_replacement_restores_prior_payload(
    payload, tmp_path, monkeypatch, failure, boundary
):
    output = tmp_path / "installed"
    install(payload, output)
    (output / "unexpected").write_bytes(b"force repair without damaging the playable pair")
    prior = payload_bytes(output)
    rename = Path.rename

    def fail_stage(path, destination):
        if boundary == "old-moved" and path == output:
            rename(path, destination)
            assert payload_bytes(destination) == prior
            assert not output.exists()
            raise failure
        if boundary == "new-publication" and path.name == "payload":
            assert payload_bytes(tmp_path / ".installed.previous") == prior
            assert not output.exists()
            raise failure
        return rename(path, destination)

    monkeypatch.setattr(Path, "rename", fail_stage)
    with pytest.raises(type(failure)) as caught:
        install(payload, output)
    assert caught.value is failure
    assert payload_bytes(output) == prior
    assert not (tmp_path / ".installed.previous").exists()
    assert not (tmp_path / ".installed.work").exists()
    monkeypatch.setattr(Path, "rename", rename)
    assert install(payload, output) == payload[4]
    assert (output / "bin/ffmpeg").read_bytes() == b"ffmpeg9"
    assert (output / "bin/ffprobe").read_bytes() == b"ffprobe9"
    assert not (output / "unexpected").exists()


def payload_bytes(directory):
    return {
        file.relative_to(directory).as_posix(): file.read_bytes()
        for file in directory.rglob("*")
        if file.is_file()
    }


@pytest.mark.parametrize("recovery_failure", [OSError("sharing violation"), KeyboardInterrupt()])
def test_failed_restore_retains_previous_for_retry(
    payload, tmp_path, monkeypatch, recovery_failure
):
    output = tmp_path / "installed"
    install(payload, output)
    (output / "unexpected").write_bytes(b"retain every previous byte")
    prior = payload_bytes(output)
    previous = tmp_path / ".installed.previous"
    rename = Path.rename
    failure = KeyboardInterrupt("publication interrupted")

    def fail_publication_and_restore(path, destination):
        if path.name == "payload":
            raise failure
        if path == previous:
            raise recovery_failure
        return rename(path, destination)

    monkeypatch.setattr(Path, "rename", fail_publication_and_restore)
    with pytest.raises(KeyboardInterrupt) as caught:
        install(payload, output)
    assert caught.value is failure
    assert str(previous) in caught.value.__notes__[0]
    assert not output.exists()
    assert payload_bytes(previous) == prior
    assert not (tmp_path / ".installed.work").exists()
    monkeypatch.setattr(Path, "rename", rename)
    assert install(payload, output) == payload[4]
    assert (output / "bin/ffmpeg").read_bytes() == b"ffmpeg9"
    assert (output / "bin/ffprobe").read_bytes() == b"ffprobe9"
    assert not previous.exists()


@pytest.mark.parametrize("published", [False, True])
def test_restart_restores_previous_before_failed_acquisition(
    payload, tmp_path, monkeypatch, published
):
    owner = payload[0]
    output = tmp_path / "installed"
    install(payload, output)
    (output / "unexpected").write_bytes(b"prior payload extra material")
    prior = payload_bytes(output)
    previous = tmp_path / ".installed.previous"
    output.rename(previous)
    work = tmp_path / ".installed.work"
    work.mkdir()
    (work / "payload.tar.xz").write_bytes(b"interrupted scratch")
    shutil.copytree(payload[1], work / "payload")
    if published:
        (work / "payload").rename(output)
        (output / "bin/ffprobe").write_bytes(b"published pair subsequently damaged")

    def fail_acquisition(*_):
        assert payload_bytes(output) == prior
        assert not previous.exists()
        raise OSError("offline acquisition")

    monkeypatch.setattr(owner, "_download", fail_acquisition)
    with pytest.raises(OSError, match="offline acquisition"):
        install(payload, output)
    assert payload_bytes(output) == prior
    assert not work.exists()
    monkeypatch.setattr(
        owner, "_download", lambda _artifact, dest: shutil.copyfile(payload[2], dest)
    )
    assert install(payload, output) == payload[4]
    assert (output / "bin/ffmpeg").read_bytes() == b"ffmpeg9"
    assert (output / "bin/ffprobe").read_bytes() == b"ffprobe9"
    assert not previous.exists()
    assert not work.exists()


def test_restart_after_publication_proves_new_output_before_discarding_previous(
    payload, tmp_path, monkeypatch
):
    owner, origin, _, _, manifest, _, _ = payload
    output = tmp_path / "installed"
    install(payload, output)
    (output / "unexpected").write_bytes(b"previous payload")
    previous = tmp_path / ".installed.previous"
    output.rename(previous)
    work = tmp_path / ".installed.work"
    work.mkdir()
    (work / "payload.tar.xz").write_bytes(b"interrupted scratch")
    shutil.copytree(origin, work / "payload")
    (work / "payload").rename(output)
    proofs = []

    def proof(directory, target):
        assert directory == output
        assert target == TARGET
        assert (directory / "bin/ffmpeg").read_bytes() == b"ffmpeg9"
        assert (directory / "bin/ffprobe").read_bytes() == b"ffprobe9"
        assert (previous / "unexpected").read_bytes() == b"previous payload"
        proofs.append(directory)

    monkeypatch.setattr(owner, "prove_payload", proof)
    monkeypatch.setattr(owner, "_download", lambda *_: pytest.fail("downloaded published payload"))
    assert install(payload, output) == manifest
    assert proofs == [output]
    assert not previous.exists()
    assert not work.exists()
    assert payload_bytes(output) == payload_bytes(origin)


def test_restart_native_proof_failure_preserves_previous_before_acquisition(
    payload, tmp_path, monkeypatch
):
    owner, origin, _, _, _, _, _ = payload
    output = tmp_path / "installed"
    install(payload, output)
    (output / "unexpected").write_bytes(b"prior material must survive failed acquisition")
    prior = payload_bytes(output)
    previous = tmp_path / ".installed.previous"
    output.rename(previous)
    shutil.copytree(origin, output)
    proved = []

    def reject_native(directory, target):
        assert directory == output
        assert target == TARGET
        assert (directory / "bin/ffmpeg").read_bytes() == b"ffmpeg9"
        proved.append(directory)
        raise RuntimeError("native proof failed")

    def fail_acquisition(*_):
        raise OSError("offline")

    monkeypatch.setattr(owner, "prove_payload", reject_native)
    monkeypatch.setattr(owner, "_download", fail_acquisition)
    with pytest.raises(OSError, match="offline"):
        install(payload, output)
    assert proved == [output]
    assert payload_bytes(output) == prior
    assert not previous.exists()


@pytest.mark.parametrize("root", ["installed", ".installed.previous", ".installed.work"])
@pytest.mark.parametrize("kind", ["file", "fifo", "symlink", "dangling-symlink"])
def test_unsafe_publication_roots_fail_without_mutation(payload, tmp_path, monkeypatch, root, kind):
    owner, origin, _, _, _, _, _ = payload
    unsafe = tmp_path / root
    if kind == "file":
        unsafe.write_bytes(b"unowned recovery root")
    elif kind == "fifo":
        if not hasattr(owner.os, "mkfifo"):
            pytest.skip("native platform has no FIFO creation")
        owner.os.mkfifo(unsafe)
    else:
        unsafe.symlink_to(
            origin if kind == "symlink" else tmp_path / "missing", target_is_directory=True
        )
    before = payload_bytes(origin)
    monkeypatch.setattr(owner, "_download", lambda *_: pytest.fail("acquired with unsafe root"))
    monkeypatch.setattr(owner, "prove_payload", lambda *_: pytest.fail("proved unsafe root"))
    with pytest.raises(ValueError, match="unsafe payload publication directory"):
        install(payload, tmp_path / "installed")
    assert payload_bytes(origin) == before
    if kind == "file":
        assert unsafe.read_bytes() == b"unowned recovery root"
    elif kind != "fifo":
        assert unsafe.is_symlink()
    else:
        assert unsafe.exists()


def test_unexpected_work_member_fails_without_cleanup(payload, tmp_path):
    work = tmp_path / ".installed.work"
    work.mkdir()
    (work / "unowned").write_bytes(b"keep unrecognized material")
    with pytest.raises(ValueError, match="unexpected payload work member"):
        install(payload, tmp_path / "installed")
    assert (work / "unowned").read_bytes() == b"keep unrecognized material"


@pytest.mark.parametrize("published", [False, True])
def test_invalid_explicit_archive_precedes_recovery_mutation(
    payload, tmp_path, monkeypatch, published
):
    owner, origin, archive, catalog, _, _, _ = payload
    output = tmp_path / "installed"
    install(payload, output)
    previous = tmp_path / ".installed.previous"
    output.rename(previous)
    if published:
        shutil.copytree(origin, output)
    work = tmp_path / ".installed.work"
    work.mkdir()
    (work / "payload.tar.xz").write_bytes(b"keep interrupted work")
    before = payload_bytes(previous)
    archive.write_bytes(b"corrupt explicit override")
    monkeypatch.setattr(Path, "rename", lambda *_: pytest.fail("renamed before archive admission"))
    monkeypatch.setattr(
        owner.shutil, "rmtree", lambda *_: pytest.fail("removed before archive admission")
    )
    monkeypatch.setattr(
        owner, "_integrity", lambda *_a, **_k: pytest.fail("reused before archive admission")
    )
    with pytest.raises(ValueError, match="sha256"):
        owner.ensure_payload(output, target=TARGET, catalog=catalog, archive=archive)
    assert payload_bytes(previous) == before
    assert output.exists() is published
    assert (work / "payload.tar.xz").read_bytes() == b"keep interrupted work"


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
    calls.clear()
    with pytest.raises(ValueError, match="unexpected signing receipt"):
        owner.sign_payload(output, "Developer ID fixture", target=target, catalog=catalog)
    assert not calls
    (output / owner.SIGNED_RECEIPT).unlink()
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


@pytest.mark.parametrize(
    "receipt",
    [
        None,
        [],
        {},
        {"files": []},
        {"files": None},
        {"files": {"bin/ffmpeg": 42}},
        {"files": {"bin/ffmpeg": "invalid digest"}},
    ],
)
def test_signed_inspection_rejects_malformed_receipt_before_execution(
    payload, tmp_path, monkeypatch, receipt
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
    (output / owner.SIGNED_RECEIPT).write_text(json.dumps(receipt))
    monkeypatch.setattr(owner, "_run", lambda *_: pytest.fail("executed malformed receipt"))
    monkeypatch.setattr(owner, "prove_payload", lambda *_: pytest.fail("proved malformed receipt"))
    with pytest.raises(ValueError, match="invalid signing receipt"):
        owner.verify_payload(output, target=target, catalog=catalog)


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


def test_acquisition_replaces_signed_receipt_before_executing_pair(payload, tmp_path, monkeypatch):
    owner, _, _, catalog, manifest, pack, _ = payload
    target = "x86_64-apple-darwin"
    manifest["target"] = target
    pack()
    data = json.loads(catalog.read_text())
    data["targets"][target] = data["targets"].pop(TARGET)
    catalog.write_text(json.dumps(data))
    output = tmp_path / "installed"
    owner.ensure_payload(output, target=target, catalog=catalog)
    (output / "bin/ffmpeg").write_bytes(b"changed bytes")
    (output / owner.SIGNED_RECEIPT).write_text(
        json.dumps(
            {
                "archive_sha256": data["targets"][target]["sha256"],
                "manifest_sha256": data["targets"][target]["manifest_sha256"],
                "files": {
                    name: owner.sha256_file(output / name) for name in ("bin/ffmpeg", "bin/ffprobe")
                },
            }
        )
    )
    proved = []

    def proof(directory, actual_target):
        assert actual_target == target
        assert (directory / "bin/ffmpeg").read_bytes() == b"ffmpeg9"
        assert (directory / "bin/ffprobe").read_bytes() == b"ffprobe9"
        assert not (directory / owner.SIGNED_RECEIPT).exists()
        proved.append(directory)

    monkeypatch.setattr(owner, "prove_payload", proof)
    owner.ensure_payload(output, target=target, catalog=catalog)
    assert len(proved) == 1
    assert (output / "bin/ffmpeg").read_bytes() == b"ffmpeg9"
    assert not (output / owner.SIGNED_RECEIPT).exists()
