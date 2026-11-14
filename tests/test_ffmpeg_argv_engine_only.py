"""Ratchet for #1815: per-file caps on ffmpeg/ffprobe argv lists built outside the engine.

Known gap: a binary reaching the list through a local alias, a helper parameter, or a later
``append``/``insert`` is not seen.
"""

from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"

# util/binaries.py admits the ffmpeg pair that FFmpegEngine depends on, so it cannot route through it.
EXEMPT = {"engines/ffmpeg.py", "util/binaries.py"}
BINARIES = {"ffmpeg", "ffprobe"}
RESOLVERS = {"resolve_ffmpeg", "resolve_ffprobe"}

FFMPEG_ARGV: dict[str, int] = {
    "edits/join_continuity.py": 1,
    "engines/align.py": 1,
    "engines/decoded_source.py": 1,
    "engines/render_clock.py": 2,
    "engines/source_proxy_audio.py": 1,
    "engines/timeline_render.py": 1,
    "services/media/proxy_media.py": 1,
    "services/support/doctor.py": 1,
}


def _is_binary(expr: ast.expr) -> bool:
    if isinstance(expr, ast.Constant):
        return expr.value in BINARIES
    if isinstance(expr, ast.Name):
        return expr.id in BINARIES
    if isinstance(expr, ast.Attribute):
        return expr.attr in BINARIES
    if isinstance(expr, ast.Call):
        return isinstance(expr.func, ast.Name) and expr.func.id in RESOLVERS
    if isinstance(expr, ast.BoolOp):
        return any(_is_binary(value) for value in expr.values)
    if isinstance(expr, ast.IfExp):
        return _is_binary(expr.body) or _is_binary(expr.orelse)
    return False


def _count_source(text: str) -> int:
    return sum(
        1
        for node in ast.walk(ast.parse(text))
        if isinstance(node, ast.List) and node.elts and _is_binary(node.elts[0])
    )


def _counts() -> dict[str, int]:
    found: Counter[str] = Counter()
    for path in sorted(PACKAGE.rglob("*.py")):
        relative = path.relative_to(PACKAGE).as_posix()
        if relative in EXEMPT:
            continue
        count = _count_source(path.read_text(encoding="utf-8"))
        if count:
            found[relative] = count
    return dict(found)


def _over_cap(counts: dict[str, int], caps: dict[str, int]) -> dict[str, int]:
    return {f: n for f, n in counts.items() if n > caps.get(f, 0)}


def _stale(counts: dict[str, int], caps: dict[str, int]) -> list[str]:
    return sorted(f for f in caps if f not in counts)


def test_ffmpeg_argv_lists_stay_within_the_allowlist() -> None:
    over = _over_cap(_counts(), FFMPEG_ARGV)
    assert not over, f"ffmpeg argv outside engines/ffmpeg.py (cap in FFMPEG_ARGV): {over}"


def test_the_allowlist_has_no_stale_files() -> None:
    stale = _stale(_counts(), FFMPEG_ARGV)
    assert not stale, f"remove from FFMPEG_ARGV, no ffmpeg argv left: {stale}"


def test_the_exempt_files_exist() -> None:
    assert all((PACKAGE / relative).is_file() for relative in EXEMPT)


def test_the_cap_check_fails_one_above_a_cap_and_for_an_uncapped_file() -> None:
    assert _over_cap({"a.py": 2}, {"a.py": 2}) == {}
    assert _over_cap({"a.py": 1}, {"a.py": 2}) == {}
    assert _over_cap({"a.py": 3}, {"a.py": 2}) == {"a.py": 3}
    assert _over_cap({"new.py": 1}, {"a.py": 2}) == {"new.py": 1}
    assert _stale({"a.py": 1}, {"a.py": 2, "gone.py": 1}) == ["gone.py"]


def test_the_scanner_recognises_every_binary_head_spelling() -> None:
    flagged = [
        "[ffmpeg, '-y']",
        "[ffprobe, '-version']",
        "[eng.ffmpeg, '-y']",
        "[self.engine.ffprobe, '-v']",
        "[resolve_ffmpeg(), '-y']",
        "[resolve_ffprobe(), '-v']",
        "[resolve_ffmpeg_pair().ffmpeg, '-y']",
        "[ffmpeg or resolve_ffmpeg(), '-y']",
        "[custom or eng.ffmpeg, '-y']",
        "[ffmpeg if fast else slow, '-y']",
        "[slow if fast else eng.ffprobe, '-y']",
        "['ffmpeg', '-y']",
    ]
    ignored = [
        "(eng.ffmpeg, eng.ffprobe)",
        "('ffmpeg',)",
        "['whisper-cli', '-m']",
        "[str(cli), '-m']",
        "['-v', 'error']",
        "['-i', 'ffmpeg']",
        "[resolve_ffmpeg_pair(), '-y']",
        "[]",
    ]
    assert all(_count_source(text) == 1 for text in flagged)
    assert not any(_count_source(text) for text in ignored)


def test_the_scanner_counts_offenders_and_skips_exempt_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "engines").mkdir()
    (tmp_path / "util").mkdir()
    (tmp_path / "services").mkdir()
    exempt = "cmd = [eng.ffmpeg, '-y']\n"
    (tmp_path / "engines" / "ffmpeg.py").write_text(exempt, encoding="utf-8")
    (tmp_path / "util" / "binaries.py").write_text(exempt, encoding="utf-8")
    (tmp_path / "services" / "offender.py").write_text(
        "a = [eng.ffmpeg, '-y']\nb = [resolve_ffprobe(), '-v']\nc = (eng.ffmpeg,)\n",
        encoding="utf-8",
    )
    (tmp_path / "services" / "clean.py").write_text("x = ['whisper-cli']\n", encoding="utf-8")
    monkeypatch.setattr(f"{__name__}.PACKAGE", tmp_path)

    counts = _counts()
    assert counts == {"services/offender.py": 2}
    assert _over_cap(counts, {}) == {"services/offender.py": 2}
    assert _over_cap(counts, {"services/offender.py": 2}) == {}
