from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "asr_gold"
DOWNLOADER = Path(__file__).parents[1] / "scripts" / "download_fixture_asr_gold.sh"


def test_committed_asr_corpus_matches_manifest() -> None:
    manifest = json.loads((FIXTURE / "manifest.json").read_text(encoding="utf-8"))
    entries = manifest["utterances"]
    assert manifest["utterance_count"] == len(entries) == 3
    assert {entry["id"] for entry in entries} == {
        "01_1272-135031-0001",
        "02_1272-135031-0002",
        "03_1272-135031-0003",
    }
    assert {path.relative_to(FIXTURE).as_posix() for path in (FIXTURE / "audio").iterdir()} == {
        entry["audio"] for entry in entries
    }
    assert {path.relative_to(FIXTURE).as_posix() for path in (FIXTURE / "reference").iterdir()} == {
        entry["reference"] for entry in entries
    }
    for entry in entries:
        assert (FIXTURE / entry["audio"]).read_bytes().startswith(b"fLaC")
        assert (FIXTURE / entry["reference"]).read_text(encoding="utf-8").strip() == entry["text"]
        assert entry["text"]


def test_downloader_selects_same_three_references(tmp_path: Path) -> None:
    source = tmp_path / "source" / "1272" / "135031"
    source.mkdir(parents=True)
    manifest = json.loads((FIXTURE / "manifest.json").read_text(encoding="utf-8"))
    lines = []
    for entry in manifest["utterances"]:
        _, original_id = entry["id"].split("_", 1)
        (source / f"{original_id}.flac").write_bytes((FIXTURE / entry["audio"]).read_bytes())
        lines.append(f"{original_id} {entry['text']}")
    (source / "1272-135031-0000.flac").write_bytes(b"unused clip")
    (source / "1272-135031.trans.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    out = tmp_path / "out"
    (out / "audio").mkdir(parents=True)
    (out / "reference").mkdir()
    (out / "audio" / "00_1272-135031-0000.flac").write_bytes(b"obsolete audio")
    (out / "reference" / "00_1272-135031-0000.txt").write_text("obsolete reference")
    script = DOWNLOADER.read_text(encoding="utf-8").split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
    subprocess.run(
        [sys.executable, "-", str(tmp_path / "source"), str(out)],
        input=script,
        text=True,
        capture_output=True,
        check=True,
    )
    assert json.loads((out / "manifest.json").read_text(encoding="utf-8")) == manifest
    for folder in ("audio", "reference"):
        actual = {path.name: path.read_bytes() for path in (out / folder).iterdir()}
        expected = {path.name: path.read_bytes() for path in (FIXTURE / folder).iterdir()}
        assert actual == expected
