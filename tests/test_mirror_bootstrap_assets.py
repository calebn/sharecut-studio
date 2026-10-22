"""Bootstrap mirror keeps a full digest in its output manifest."""

from __future__ import annotations

import hashlib
import io
import json
import runpy
import sys
from pathlib import Path


def test_mirror_records_full_file_sha256(tmp_path: Path, monkeypatch) -> None:
    script = Path(__file__).resolve().parents[1] / "scripts" / "mirror_bootstrap_assets.py"
    main = runpy.run_path(str(script))["main"]
    manifest = tmp_path / "assets.json"
    manifest.write_text(
        json.dumps(
            {
                "assets": {
                    "fixture": {
                        "kind": "http",
                        "cdn_prefix": "fixtures",
                        "url": "https://example.test/file.bin",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    out_dir = tmp_path / "mirror"
    payload = b"mirrored asset"

    def fake_download(
        _url: str, dest: Path, *, expected_sha256: str | None = None, timeout: float = 120.0
    ) -> None:
        del timeout, expected_sha256
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    monkeypatch.setitem(main.__globals__, "_download", fake_download)
    monkeypatch.setattr(
        sys,
        "argv",
        ["mirror_bootstrap_assets.py", "--manifest", str(manifest), "--out-dir", str(out_dir)],
    )

    assert main() == 0
    summary = json.loads((out_dir / "mirror-summary.json").read_text(encoding="utf-8"))
    assert summary[0]["sha256"] == hashlib.sha256(payload).hexdigest()


def _run_mirror(tmp_path: Path, monkeypatch, asset: dict, payload: bytes | None = None):
    """Run main() against a one-asset manifest; a fake opener serves ``payload`` if given."""
    from podcast_mcp.util import asset_sources

    script = Path(__file__).resolve().parents[1] / "scripts" / "mirror_bootstrap_assets.py"
    main = runpy.run_path(str(script))["main"]
    manifest = tmp_path / "assets.json"
    manifest.write_text(
        json.dumps({"assets": {"fixture": {"kind": "http", "cdn_prefix": "fx", **asset}}}),
        encoding="utf-8",
    )
    out_dir = tmp_path / "mirror"
    if payload is not None:

        class _Opener:
            def open(self, req, timeout=None):  # noqa: ANN001
                del req, timeout
                return io.BytesIO(payload)

        monkeypatch.setattr(asset_sources, "_https_opener", lambda: _Opener())
    monkeypatch.setattr(
        sys,
        "argv",
        ["mirror_bootstrap_assets.py", "--manifest", str(manifest), "--out-dir", str(out_dir)],
    )
    return main, out_dir


def test_mirror_records_size_bytes(tmp_path: Path, monkeypatch) -> None:
    payload = b"mirrored asset"
    main, out_dir = _run_mirror(
        tmp_path, monkeypatch, {"url": "https://example.test/file.bin"}, payload
    )
    assert main() == 0
    summary = json.loads((out_dir / "mirror-summary.json").read_text(encoding="utf-8"))
    assert summary[0]["size_bytes"] == len(payload)


def test_mirror_fails_on_pinned_sha_drift(tmp_path: Path, monkeypatch, capsys) -> None:
    payload = b"served bytes"
    asset = {
        "url": "https://example.test/file.bin",
        "sha256": hashlib.sha256(b"pinned bytes").hexdigest(),
    }
    main, _ = _run_mirror(tmp_path, monkeypatch, asset, payload)
    assert main() != 0
    assert "sha256 mismatch" in capsys.readouterr().err


def test_mirror_fails_on_pinned_size_drift(tmp_path: Path, monkeypatch, capsys) -> None:
    payload = b"served bytes"
    asset = {
        "url": "https://example.test/file.bin",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "size_bytes": len(payload) + 1,
    }
    main, _ = _run_mirror(tmp_path, monkeypatch, asset, payload)
    assert main() != 0
    assert "size mismatch" in capsys.readouterr().err
