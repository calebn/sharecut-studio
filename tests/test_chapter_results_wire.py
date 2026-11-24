from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import ChapterMarker
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync.handlers import markers
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok


def _ws(tmp_path) -> ProjectWorkspace:
    return ProjectWorkspace.create(tmp_path / "episode")


def _seed_with_image(ws: ProjectWorkspace, time: float, title: str, url: str) -> None:
    ws.mutate(
        "before seed",
        "after seed",
        lambda p: p.chapters.append(ChapterMarker(time=time, title=title, image_url=url)),
    )


def _labels(path) -> list[str]:
    return [e.label for e in ProjectWorkspace.open(path).project.history.entries]


def _pin(value: dict, keys: list[str], text: str) -> None:
    assert list(value) == keys
    assert json.dumps(value) == text


def test_service_add_chapter_int_time(tmp_path):
    ws = _ws(tmp_path)
    result = TimelineService(ws).add_chapter(5, "Intro")
    result = result.model_dump()
    _pin(
        result, ["time", "title", "image_url"], '{"time": 5.0, "title": "Intro", "image_url": null}'
    )
    assert isinstance(result["time"], float)
    assert json.dumps(result, indent=2) == (
        '{\n  "time": 5.0,\n  "title": "Intro",\n  "image_url": null\n}'
    )


def test_service_add_chapter_non_ascii_title(tmp_path):
    ws = _ws(tmp_path)
    result = TimelineService(ws).add_chapter(61.5, "Café ☕ 日本語")
    _pin(
        result.model_dump(),
        ["time", "title", "image_url"],
        '{"time": 61.5, "title": "Caf\\u00e9 \\u2615 \\u65e5\\u672c\\u8a9e", "image_url": null}',
    )


def test_service_update_chapter_changes_time_and_title(tmp_path):
    ws = _ws(tmp_path)
    svc = TimelineService(ws)
    svc.add_chapter(1, "Old")
    result = svc.update_chapter(1, "Old", time=2.5, title="New")
    _pin(
        result.model_dump(),
        ["time", "title", "image_url"],
        '{"time": 2.5, "title": "New", "image_url": null}',
    )


def test_service_update_chapter_with_image_url(tmp_path):
    ws = _ws(tmp_path)
    _seed_with_image(ws, 3.0, "Pic", "https://cdn.example/a.jpg")
    result = TimelineService(ws).update_chapter(3.0, "Pic", time=4.0, title="Pic2")
    _pin(
        result.model_dump(),
        ["time", "title", "image_url"],
        '{"time": 4.0, "title": "Pic2", "image_url": null}',
    )


def test_service_remove_chapter_found_and_missing(tmp_path):
    ws = _ws(tmp_path)
    svc = TimelineService(ws)
    svc.add_chapter(1, "Intro")
    found = svc.remove_chapter("Intro")
    _pin(found.model_dump(), ["removed", "title"], '{"removed": true, "title": "Intro"}')
    missing = svc.remove_chapter("Intro")
    _pin(missing.model_dump(), ["removed", "title"], '{"removed": false, "title": "Intro"}')


def test_service_remove_chapter_non_ascii(tmp_path):
    ws = _ws(tmp_path)
    svc = TimelineService(ws)
    svc.add_chapter(1, "Café")
    _pin(
        svc.remove_chapter("Café").model_dump(),
        ["removed", "title"],
        '{"removed": true, "title": "Caf\\u00e9"}',
    )


def test_service_delete_chapter_found_and_missing(tmp_path):
    ws = _ws(tmp_path)
    svc = TimelineService(ws)
    svc.add_chapter(2, "Intro")
    found = svc.delete_chapter(2, "Intro")
    _pin(
        found.model_dump(),
        ["deleted", "time", "title"],
        '{"deleted": true, "time": 2, "title": "Intro"}',
    )
    assert isinstance(found.time, int)
    with pytest.raises(CodedValueError, match="chapter not found") as err:
        svc.delete_chapter(2.5, "Intro")
    assert err.value.code == "chapter_not_found"


def test_service_history_labels(tmp_path):
    ws = _ws(tmp_path)
    svc = TimelineService(ws)
    svc.add_chapter(1, "A")
    svc.update_chapter(1, "A", time=2, title="B")
    svc.remove_chapter("B")
    svc.add_chapter(3, "C")
    svc.delete_chapter(3, "C")
    labels = _labels(ws.path)
    assert [x for x in labels if "chapter" in x] == [
        "after add chapter",
        "after update chapter",
        "after remove chapter",
        "after add chapter",
        "after delete chapter",
    ]


def test_handler_add_chapter(tmp_path):
    ws = _ws(tmp_path)
    result = markers.add_chapter(ws, {"time": 5, "title": "Café"})
    _pin(
        result,
        ["time", "title", "image_url"],
        '{"time": 5.0, "title": "Caf\\u00e9", "image_url": null}',
    )


def test_handler_update_chapter(tmp_path):
    ws = _ws(tmp_path)
    markers.add_chapter(ws, {"time": 1, "title": "Old"})
    result = markers.update_chapter(
        ws, {"old_time": 1, "old_title": "Old", "time": 9, "title": "Nouveau ☕"}
    )
    _pin(
        result,
        ["time", "title", "image_url"],
        '{"time": 9.0, "title": "Nouveau \\u2615", "image_url": null}',
    )


def test_handler_update_chapter_with_image_url(tmp_path):
    ws = _ws(tmp_path)
    _seed_with_image(ws, 3.0, "Pic", "https://cdn.example/a.jpg")
    result = markers.update_chapter(
        ws, {"old_time": 3, "old_title": "Pic", "time": 6, "title": "Pic"}
    )
    _pin(
        result,
        ["time", "title", "image_url"],
        '{"time": 6.0, "title": "Pic", "image_url": null}',
    )


def test_handler_delete_chapter_found_and_missing(tmp_path):
    ws = _ws(tmp_path)
    markers.add_chapter(ws, {"time": 2, "title": "Intro"})
    found = markers.delete_chapter(ws, {"time": 2, "title": "Intro"})
    _pin(
        found,
        ["deleted", "time", "title"],
        '{"deleted": true, "time": 2.0, "title": "Intro"}',
    )
    with pytest.raises(CodedValueError, match="chapter not found") as err:
        markers.delete_chapter(ws, {"time": 2, "title": "Intro"})
    assert err.value.code == "chapter_not_found"


def _remove_cli(path, title: str):
    return CliRunner().invoke(
        app, ["edit", "remove-chapter", "--project", str(path), "--title", title]
    )


def test_cli_remove_chapter_found_and_missing(tmp_path):
    ws = _ws(tmp_path)
    TimelineService(ws).add_chapter(1, "Café")
    found = _remove_cli(ws.path, "Café")
    assert found.exit_code == 0
    assert found.stdout == '{\n  "removed": true,\n  "title": "Caf\\u00e9"\n}\n'
    missing = _remove_cli(ws.path, "Café")
    assert missing.exit_code == 0
    assert missing.stdout == '{\n  "removed": false,\n  "title": "Caf\\u00e9"\n}\n'
