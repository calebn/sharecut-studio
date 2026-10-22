"""One stat stamp for file identity, and which modules read ``stat`` on their own (#1946)."""

from __future__ import annotations

import os
import re
from pathlib import Path

from podcast_mcp.util.fingerprint import FileStamp, file_stamp, mtime_ns_if_file
from podcast_mcp.util.project_state import file_revision

SRC = Path(__file__).resolve().parents[1] / "src"

# Modules whose cache keys come from a stamp.
STAMPED = {
    "podcast_mcp/edits/prosody_profile.py",
    "podcast_mcp/edits/transcript_reuse.py",
    "podcast_mcp/engines/alignment_audit.py",
    "podcast_mcp/engines/decoded_source.py",
    "podcast_mcp/engines/gate_fill.py",
    "podcast_mcp/engines/play_audit.py",
    "podcast_mcp/engines/waveform_media.py",
    "podcast_mcp/engines/word_align.py",
    "podcast_mcp/project/store.py",
    "podcast_mcp/services/collaboration/review_versions.py",
    "podcast_mcp/services/document/boundary.py",
    "podcast_mcp/services/document/golden_ear.py",
    "podcast_mcp/services/document/play_cache.py",
    "podcast_mcp/services/document/play_support.py",
    "podcast_mcp/services/document_sync/service.py",
    "podcast_mcp/services/document_sync/snapshot_cache.py",
    "podcast_mcp/services/media/waveform.py",
    "podcast_mcp/util/batch_scope.py",
    "podcast_mcp/util/model_manifest.py",
    "podcast_mcp/util/project_state.py",
}

# Modules that read mtime from ``stat`` themselves: their keys carry other parts (a media
# key, a sample rate, a stored value to compare against) or order the files by mtime. Move
# one to ``file_stamp`` only when its key keeps exactly the parts it keeps today.
OWN_STAT = {
    "podcast_mcp/engines/transcribe.py",
    "podcast_mcp/engines/waveform_pyramid.py",
    "podcast_mcp/gui/audio.py",
    "podcast_mcp/services/document/analysis.py",
    "podcast_mcp/services/document/play_cache.py",
    "podcast_mcp/util/binaries.py",
}


def _modules(pattern: str) -> set[str]:
    found = set()
    for path in SRC.rglob("*.py"):
        rel = path.relative_to(SRC).as_posix()
        if rel != "podcast_mcp/util/fingerprint.py" and re.search(pattern, path.read_text()):
            found.add(rel)
    return found


def test_a_stamp_is_the_files_stat_and_its_projections_keep_their_parts(tmp_path: Path) -> None:
    path = tmp_path / "a.bin"
    path.write_bytes(b"abc")
    st = path.stat()

    stamp = file_stamp(path)

    assert stamp == (st.st_dev, st.st_ino, 3, st.st_mtime_ns, st.st_ctime_ns)
    assert stamp.revision == (st.st_dev, st.st_ino, 3, st.st_mtime_ns)
    assert stamp.content == (3, st.st_mtime_ns)
    assert file_stamp(st) == stamp
    assert isinstance(stamp, FileStamp)
    assert file_revision(path) == stamp.revision


def test_a_rewritten_file_changes_the_stamp_even_when_size_and_mtime_are_restored(
    tmp_path: Path,
) -> None:
    path = tmp_path / "a.bin"
    path.write_bytes(b"abc")
    before = file_stamp(path)
    os.utime(path, ns=(before.mtime_ns, before.mtime_ns))
    replacement = tmp_path / "b.bin"
    replacement.write_bytes(b"xyz")
    os.utime(replacement, ns=(before.mtime_ns, before.mtime_ns))
    os.replace(replacement, path)

    after = file_stamp(path)

    assert after.content == before.content
    assert after.revision != before.revision
    assert after != before


def test_a_missing_input_keys_as_zero(tmp_path: Path) -> None:
    path = tmp_path / "a.bin"
    assert mtime_ns_if_file(path) == 0
    path.write_bytes(b"x")
    assert mtime_ns_if_file(path) == path.stat().st_mtime_ns
    assert mtime_ns_if_file(tmp_path) == 0


def test_the_modules_that_use_the_stamp_are_pinned() -> None:
    assert _modules(r"podcast_mcp\.util\.fingerprint import") == STAMPED


def test_the_modules_that_read_mtime_from_stat_themselves_are_pinned() -> None:
    assert _modules(r"st_mtime_ns") == OWN_STAT
