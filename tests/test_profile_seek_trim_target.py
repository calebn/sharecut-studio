"""`make profile-seek-trim` refuses an existing OUT before it builds or summarizes."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_profile_seek_trim_refuses_existing_out_and_keeps_its_evidence(tmp_path: Path) -> None:
    out = tmp_path / "seek-trim"
    out.mkdir()
    marker = out / "marker.txt"
    marker.write_text("retained evidence", encoding="utf-8")

    result = subprocess.run(
        ["make", "profile-seek-trim", f"OUT={out}"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "refusing" in result.stderr
    assert marker.read_text(encoding="utf-8") == "retained evidence"
    assert not (out / "summary.txt").exists()
