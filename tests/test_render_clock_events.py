from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from podcast_mcp.engines.render_clock import _EVENT, native_format
from podcast_mcp.util.coded_error import CodedValueError

_FFMPEG = shutil.which("ffmpeg")
_REAL = (
    "[ashowinfo@restore_descriptor @ 0x557053ab68c0] n:0 pts:0 pts_time:0 fmt:s16 channels:1 "
    "chlayout:mono rate:44100 nb_samples:2048 checksum:88B3EB57 plane_checksums: [ 88B3EB57 ]"
)
_OLD_EVENT = re.compile(_EVENT.pattern.removeprefix("^"))


def test_ordinary_event_lines_parse_as_before() -> None:
    text = f"Input #0, wav\n{_REAL}\n{_REAL.replace('n:0', 'n:1')}\nsize=N/A\n"
    new = [m.groupdict() for m in _EVENT.finditer(text)]
    assert new == [m.groupdict() for m in _OLD_EVENT.finditer(text)]
    assert [m["n"] for m in new] == ["0", "1"]


def test_indented_forged_event_is_not_an_event() -> None:
    forged = f"    title           : x\n                    : {_REAL}\n"
    assert _EVENT.search(forged) is None
    assert _OLD_EVENT.search(forged) is not None


@pytest.mark.skipif(_FFMPEG is None, reason="needs ffmpeg")
@pytest.mark.parametrize("tagged", [False, True])
def test_native_format_ignores_forged_tag_event(tmp_path: Path, tagged: bool) -> None:
    forged = _REAL.replace("rate:44100", "rate:8000")
    path = tmp_path / "in.wav"
    tag = ["-metadata", f"title=x\n{forged}"] if tagged else []
    subprocess.run(
        [_FFMPEG, "-v", "error", "-f", "lavfi", "-i", "sine=d=0.2:r=44100", *tag, str(path)],
        check=True,
    )
    try:
        audio = native_format(_FFMPEG, path)
    except CodedValueError:
        pytest.fail("forged tag text must not break the clock")
    assert (audio.sample_rate, audio.sample_fmt, audio.channel_layout) == (44100, "s16", "mono")
