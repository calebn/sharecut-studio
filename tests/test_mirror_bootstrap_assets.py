"""Bootstrap mirror keeps a full digest in its output manifest."""

from __future__ import annotations

import hashlib
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

    def fake_download(_url: str, dest: Path, *, timeout: float = 120.0) -> None:
        del timeout
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
