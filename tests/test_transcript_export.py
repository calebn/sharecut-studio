"""``TranscriptService.export`` / ``exported`` and the shared transcript renderers."""

from __future__ import annotations

import errno
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.export.transcript import (
    CaptionLimits,
    combined_transcript_markdown,
    format_clock,
    render_reading_text,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    EpisodeProject,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TranscriptService
from podcast_mcp.services.document.transcript import ExportBusyError, TranscriptEmptyError
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.project_state import RenderBusyError


def _words(texts: list[str], start: float = 0.0) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=t, start=start + i * 0.5, end=start + i * 0.5 + 0.4)
        for i, t in enumerate(texts)
    ]


@pytest.fixture
def ws(minimal_project: Path) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(track_id="host", words=_words(["Hello", "there", "friends."], start=3.0)),
        Transcript(track_id="guest", words=_words(["Thanks", "for", "having", "me."], start=70.0)),
    ]
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _export_dir(ws: ProjectWorkspace) -> Path:
    return ws.project.export_dir()


def test_format_clock():
    assert format_clock(0) == "0:00"
    assert format_clock(3.9) == "0:03"
    assert format_clock(65) == "1:05"
    assert format_clock(3599.9) == "59:59"
    assert format_clock(3600) == "1:00:00"
    assert format_clock(3725) == "1:02:05"
    assert format_clock(-4) == "0:00"


def test_markdown_timestamp_is_clock(ws):
    md = combined_transcript_markdown(ws.project, load_defaults())
    assert "[0:03]: Hello there friends." in md
    assert "[1:10]: Thanks for having me." in md
    assert "s]:" not in md


def test_reading_text_layout(ws):
    lines = render_reading_text(ws.project, load_defaults()).splitlines()
    assert lines[0] == ws.project.name
    assert lines[1] == "Language: en"
    assert lines[2] == ""
    assert lines[3].endswith("  0:03")
    assert lines[4] == "Hello there friends."
    assert lines[6].endswith("  1:10")


def test_export_formats_write_all_and_report(ws):
    result = TranscriptService(ws).export(["txt", "md", "srt", "vtt"])
    assert [f.format for f in result.files] == ["txt", "md", "srt", "vtt"]
    assert all(f.written and f.current for f in result.files)
    assert {f.name for f in result.files} == {
        f"{ws.project.name}.{ext}" for ext in ("txt", "md", "srt", "vtt")
    }
    for f in result.files:
        assert Path(f.path).parent == _export_dir(ws)
        assert f.bytes == Path(f.path).stat().st_size
    assert result.turns == 2
    assert result.language == "en"
    assert result.text is None
    assert result.cue_sample and "00:00:03,000" in result.cue_sample
    assert [t.start_sec for t in result.preview] == [3.0, 70.0]
    txt = Path(result.files[0].path).read_text(encoding="utf-8")
    assert txt == render_reading_text(ws.project, load_defaults())


def test_export_default_json_shape_and_with_text(ws):
    result = TranscriptService(ws).export(["md"], with_text=True)
    assert result.text and result.text.startswith(ws.project.name)
    from dataclasses import asdict

    assert set(asdict(result)) == {
        "language",
        "turns",
        "duration_sec",
        "preview",
        "cue_sample",
        "files",
        "text",
    }


def test_export_dedupes_and_rejects_bad_formats(ws):
    svc = TranscriptService(ws)
    assert [f.format for f in svc.export(["md", "md"]).files] == ["md"]
    with pytest.raises(ValueError, match="html"):
        svc.export(["html"])
    with pytest.raises(ValueError, match="at least one"):
        svc.export([])


def test_dry_run_writes_nothing_and_takes_no_lock(ws, monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("dry_run must not take the render lock")

    monkeypatch.setattr("podcast_mcp.services.document.transcript.render_lock", boom)
    before = ws.path.read_bytes()
    result = TranscriptService(ws).export(["md", "srt"], dry_run=True, with_text=True)
    assert result.files == []
    assert result.turns == 2 and result.text
    assert not _export_dir(ws).exists() or not list(_export_dir(ws).iterdir())
    assert ws.path.read_bytes() == before


def test_empty_transcript_errors_on_write_not_on_dry_run(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    svc = TranscriptService(ws)
    assert svc.export(["md"], dry_run=True).turns == 0
    with pytest.raises(TranscriptEmptyError) as err:
        svc.export(["md"])
    assert err.value.code == "transcript_empty"
    assert not any(_export_dir(ws).glob("*.md")) if _export_dir(ws).exists() else True


def test_busy_maps_to_export_busy(ws, monkeypatch):
    from contextlib import contextmanager

    @contextmanager
    def busy(*_a, **_k):
        raise RenderBusyError("lock")
        yield

    monkeypatch.setattr("podcast_mcp.services.document.transcript.render_lock", busy)
    with pytest.raises(ExportBusyError) as err:
        TranscriptService(ws).export(["md"])
    assert err.value.code == "export_busy"
    assert not list(_export_dir(ws).glob("*.md"))


def test_render_lock_uses_request_timeout(ws, monkeypatch):
    from contextlib import contextmanager

    from podcast_mcp.util.project_state import REQUEST_RENDER_LOCK_TIMEOUT_SEC, render_lock

    seen: list[float] = []

    @contextmanager
    def spy(project, *, timeout):
        seen.append(timeout)
        with render_lock(project, timeout=timeout):
            yield

    monkeypatch.setattr("podcast_mcp.services.document.transcript.render_lock", spy)
    TranscriptService(ws).export(["txt"])
    assert seen == [REQUEST_RENDER_LOCK_TIMEOUT_SEC]


def test_write_is_all_or_none(ws, monkeypatch):
    svc = TranscriptService(ws)
    first = svc.export(["md", "srt"])
    before = {f.name: Path(f.path).read_bytes() for f in first.files}

    import podcast_mcp.services.document.transcript as mod

    real = mod.render_transcript_formats

    def poisoned(project, defaults, formats, limits=None):
        out = real(project, defaults, formats, limits)
        out["srt"] = None  # the second write_text fails after the first temp is written
        return out

    monkeypatch.setattr(mod, "render_transcript_formats", poisoned)
    with pytest.raises(TypeError):
        svc.export(["md", "srt"])
    assert {f.name: Path(f.path).read_bytes() for f in first.files} == before
    assert not list(_export_dir(ws).glob("*.partial*"))


def test_non_file_destination_is_refused_before_anything_is_replaced(ws):
    svc = TranscriptService(ws)
    stem = _export_dir(ws) / ws.project.name
    stem.with_name(f"{stem.name}.txt").write_text("old words", encoding="utf-8")
    stem.with_name(f"{stem.name}.srt").mkdir()
    with pytest.raises(CodedValueError) as err:
        svc.export(["txt", "srt"])
    assert err.value.code == "export_target_not_file"
    assert stem.with_name(f"{stem.name}.txt").read_text(encoding="utf-8") == "old words"
    assert not list(_export_dir(ws).glob("*.partial*"))


def test_exported_stays_current_for_captions_written_with_custom_limits(ws):
    svc = TranscriptService(ws)
    svc.export(["srt", "vtt"], limits=CaptionLimits(max_duration_sec=1.5))
    assert [e.current for e in svc.exported()] == [True, True]
    ws2 = ProjectWorkspace.open(ws.path)
    ws2.project.transcripts[0].words[0].text = "Howdy"
    assert [e.current for e in TranscriptService(ws2).exported()] == [False, False]


def _current(ws, edit) -> list[bool]:
    TranscriptService(ws).export(["srt", "vtt"])
    ws2 = ProjectWorkspace.open(ws.path)
    edit(ws2.project)
    return [e.current for e in TranscriptService(ws2).exported()]


def _set_words(proj, texts):
    proj.transcripts = [Transcript(track_id="host", words=_words(texts, start=3.0))]


@pytest.mark.parametrize(
    "before, after",
    [
        (["a" * 40, "1990", "b" * 40, "end."], ["a" * 40, "1991", "b" * 40, "end."]),
        (["go", "-->", "home", "now."], ["go", "-->", "there", "now."]),
    ],
)
def test_caption_edits_on_numeric_or_arrow_lines_make_the_file_stale(ws, before, after):
    _set_words(ws.project, before)
    save_project(ws.project, ws.path)
    ws = ProjectWorkspace.open(ws.path)
    assert _current(ws, lambda p: _set_words(p, after)) == [False, False]


def test_overlapping_tracks_stay_current(ws):
    def overlap(proj):
        proj.transcripts = [
            Transcript(track_id="host", words=_words(["a", "b", "c", "d", "e", "f"], start=3.0)),
            Transcript(track_id="guest", words=_words(["x", "y"], start=4.0)),
        ]

    TranscriptService(ws).export(["srt", "vtt"])
    ws2 = ProjectWorkspace.open(ws.path)
    overlap(ws2.project)
    save_project(ws2.project, ws2.path)
    svc = TranscriptService(ProjectWorkspace.open(ws.path))
    svc.export(["srt", "vtt"])
    assert [e.current for e in svc.exported()] == [True, True]


def test_moving_words_in_time_makes_captions_stale(ws):
    def shift(proj):
        for t in proj.transcripts:
            for w in t.words:
                w.start += 4.0
                w.end += 4.0

    assert _current(ws, shift) == [False, False]


def test_exported_current_stale_and_scope(ws):
    svc = TranscriptService(ws)
    assert svc.exported() == []
    svc.export(["txt", "srt"])
    # bounces/ and clips/ never count, nor do other stems or other suffixes.
    for sub in ("bounces", "clips"):
        (_export_dir(ws) / sub).mkdir()
        (_export_dir(ws) / sub / f"{ws.project.name}.srt").write_text("x")
    (_export_dir(ws) / f"{ws.project.name}.wav").write_bytes(b"RIFF")
    (_export_dir(ws) / "other.srt").write_text("x")
    listed = svc.exported()
    assert [e.format for e in listed] == ["txt", "srt"]
    assert [e.mime for e in listed] == ["text/plain", "application/x-subrip"]
    assert all(e.current and e.language == "en" for e in listed)
    assert listed[0].modified.endswith("Z") and listed[0].bytes > 0

    ws2 = ProjectWorkspace.open(ws.path)
    ws2.project.transcripts[0].words[0].text = "Howdy"
    assert [e.current for e in TranscriptService(ws2).exported()] == [False, False]
    # Reading the list neither saved nor changed the in-memory project.
    assert ws2.project.transcripts[0].words[0].text == "Howdy"


def _rewrite_crlf(ws, edit=None):
    for fmt in ("txt", "md"):
        path = _export_dir(ws) / f"{ws.project.name}.{fmt}"
        lf = path.read_bytes()
        if edit:
            lf = lf.replace(*edit, 1)
        path.write_bytes(lf.replace(b"\n", b"\r\n"))


def test_crlf_export_stays_current(ws):
    svc = TranscriptService(ws)
    svc.export(["txt", "md"])
    _rewrite_crlf(ws)
    assert [e.current for e in svc.exported()] == [True, True]


def test_crlf_with_changed_word_is_stale(ws):
    svc = TranscriptService(ws)
    svc.export(["txt", "md"])
    _rewrite_crlf(ws, (b"Hello", b"Howdy"))
    assert [e.current for e in svc.exported()] == [False, False]


def test_mime_for_every_format(ws):
    TranscriptService(ws).export(["txt", "md", "srt", "vtt"])
    mimes = {e.format: e.mime for e in TranscriptService(ws).exported()}
    assert mimes == {
        "txt": "text/plain",
        "md": "text/markdown",
        "srt": "application/x-subrip",
        "vtt": "text/vtt",
    }


@pytest.mark.parametrize("stage", ["before-read", "before-stat"])
def test_exported_omits_file_deleted_during_listing(ws, monkeypatch, stage):
    svc = TranscriptService(ws)
    exported = svc.export(["txt", "md", "srt", "vtt"])
    txt = Path(exported.files[0].path)
    txt.write_text("old transcript", encoding="utf-8")
    ws.project.combined_transcript = None
    expected = svc.exported()
    assert [row.format for row in expected] == ["txt", "md", "srt", "vtt"]
    assert [row.current for row in expected] == [False, True, True, True]
    target = Path(exported.files[1].path)
    project_before = ws.project.model_dump_json()
    files_before = {path: path.read_bytes() for path in ws.path.parent.rglob("*") if path.is_file()}
    read_bytes = Path.read_bytes
    deleted = False

    def read_with_deletion(path):
        nonlocal deleted
        if path == target and not deleted and stage == "before-read":
            path.unlink()
            deleted = True
        data = read_bytes(path)
        if path == target and not deleted and stage == "before-stat":
            path.unlink()
            deleted = True
        return data

    def refuse_lock(*args, **kwargs):
        raise AssertionError("listing must not take the render lock")

    with monkeypatch.context() as patch:
        patch.setattr(Path, "read_bytes", read_with_deletion)
        patch.setattr("podcast_mcp.services.document.transcript.render_lock", refuse_lock)
        listed = svc.exported()

    assert deleted
    assert listed == [row for row in expected if row.format != "md"]
    assert ws.project.model_dump_json() == project_before
    assert {path: path.read_bytes() for path in ws.path.parent.rglob("*") if path.is_file()} == {
        path: data for path, data in files_before.items() if path != target
    }


@pytest.mark.parametrize("stage", ["read", "stat"])
@pytest.mark.parametrize(
    "error_type, error_number", [(PermissionError, errno.EACCES), (OSError, errno.EIO)]
)
def test_exported_propagates_other_file_io_errors(ws, monkeypatch, stage, error_type, error_number):
    svc = TranscriptService(ws)
    exported = svc.export(["txt", "md", "srt", "vtt"])
    target = Path(exported.files[1].path)
    failure = error_type(error_number, "cannot access transcript", str(target))
    read_bytes = Path.read_bytes
    stat = Path.stat
    target_read = False

    def read_with_error(path):
        nonlocal target_read
        if path == target and stage == "read":
            raise failure
        data = read_bytes(path)
        if path == target:
            target_read = True
        return data

    def stat_with_error(path, *args, **kwargs):
        if path == target and target_read and stage == "stat":
            raise failure
        return stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_bytes", read_with_error)
    monkeypatch.setattr(Path, "stat", stat_with_error)
    with pytest.raises(error_type) as err:
        svc.exported()
    assert err.value is failure


def test_exported_propagates_renderer_file_not_found(ws, monkeypatch):
    svc = TranscriptService(ws)
    svc.export(["txt", "md", "srt", "vtt"])
    failure = FileNotFoundError(errno.ENOENT, "renderer input is missing")

    def missing_input(*args, **kwargs):
        raise failure

    monkeypatch.setattr(
        "podcast_mcp.services.document.transcript.render_transcript_formats", missing_input
    )
    with pytest.raises(FileNotFoundError) as err:
        svc.exported()
    assert err.value is failure


def test_language_follows_transcripts(ws):
    for t in ws.project.transcripts:
        t.language = "de"
    result = TranscriptService(ws).export(["txt"])
    assert result.language == "de"
    assert result.files[0].language == "de"
    assert "Language: de" in Path(result.files[0].path).read_text(encoding="utf-8")
    assert TranscriptService(ws).exported()[0].language == "de"


def test_audio_export_uses_shared_renderers(ws):
    """Audio Export's md+srt are byte-identical to the explicit transcript export."""
    from podcast_mcp.export.transcript import render_transcript_formats, resolve_caption_limits

    defaults = load_defaults()
    rendered = render_transcript_formats(
        ws.project, defaults, ("md", "srt"), resolve_caption_limits(defaults.get("export", {}))
    )
    result = TranscriptService(ws).export(["md", "srt"])
    for f in result.files:
        assert Path(f.path).read_text(encoding="utf-8") == rendered[f.format]


def test_new_project_has_no_state_mutation_on_dry_run(ws):
    proj: EpisodeProject = ws.project
    snapshot = proj.model_dump_json()
    TranscriptService(ws).export(["md"], dry_run=True)
    assert proj.model_dump_json() == snapshot


# --- routes ------------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_routes_are_host_only(ws, client):
    relayed = {"x-sharecut-relayed": "1"}
    listed = client.get("/api/transcript/exports", params={"path": str(ws.path)}, headers=relayed)
    posted = client.post(
        "/api/transcript/export", json={"path": str(ws.path), "formats": ["txt"]}, headers=relayed
    )
    assert (listed.status_code, posted.status_code) == (403, 403)
    assert not list(_export_dir(ws).glob("*.txt"))


def test_export_persists_a_combined_transcript_it_had_to_build(ws):
    assert ws.project.combined_transcript is None
    TranscriptService(ws).export(["md"])
    assert load_project(ws.path).combined_transcript is not None


def test_route_export_and_list(ws, client):
    path = str(ws.path)
    dry = client.post("/api/transcript/export", json={"path": path, "dry_run": True})
    assert dry.status_code == 200 and dry.json()["files"] == []
    res = client.post(
        "/api/transcript/export",
        json={"path": path, "formats": ["txt", "vtt"], "with_text": True},
    )
    assert res.status_code == 200
    body = res.json()
    assert [f["format"] for f in body["files"]] == ["txt", "vtt"]
    assert body["text"]
    listed = client.get("/api/transcript/exports", params={"path": path})
    assert listed.status_code == 200
    assert [e["format"] for e in listed.json()] == ["txt", "vtt"]
    assert all(e["current"] for e in listed.json())
    json.dumps(listed.json())


def test_route_default_formats_are_md_and_srt(ws, client):
    res = client.post("/api/transcript/export", json={"path": str(ws.path)})
    assert [f["format"] for f in res.json()["files"]] == ["md", "srt"]


def test_route_error_codes(ws, client, monkeypatch):
    bad = client.post("/api/transcript/export", json={"path": str(ws.path), "formats": ["html"]})
    assert bad.status_code == 400
    assert bad.headers["X-Sharecut-Error-Code"] == "invalid_format"

    from contextlib import contextmanager

    @contextmanager
    def busy(*_a, **_k):
        raise RenderBusyError("lock")
        yield

    monkeypatch.setattr("podcast_mcp.services.document.transcript.render_lock", busy)
    res = client.post("/api/transcript/export", json={"path": str(ws.path)})
    assert res.status_code == 503
    assert res.headers["X-Sharecut-Error-Code"] == "export_busy"


def test_route_empty_transcript_is_coded(tmp_path, client):
    project = EpisodeProject.create("empty-ep", str(tmp_path / "ws"))
    project.ensure_dirs()
    path = save_project(project)
    res = client.post("/api/transcript/export", json={"path": str(path)})
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "transcript_empty"
