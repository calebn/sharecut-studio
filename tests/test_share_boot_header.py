"""A review link's page names the episode before the script has loaded (#3891).

The server writes the loading header into the page's root for exactly the links
whose tab title it already sets to the episode's name. Every other answer is the
page it was.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import share_page
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService

ROOT = '<div id="root"></div>'
FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "gui"
    / "web"
    / "src"
    / "stage"
    / "frame"
    / "__fixtures__"
    / "review-boot-header.json"
)
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
SHELL = (
    "<!DOCTYPE html><html><head><title>ShareCut Studio</title>"
    '<script type="module" src="./assets/index.js"></script>'
    '<link rel="stylesheet" href="./assets/index.css"></head>'
    f"<body>\n    {ROOT}\n  </body></html>"
)


@pytest.fixture(autouse=True)
def _grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def _dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(SHELL, encoding="utf-8")
    return dist


def _seed(minimal_project, sample_wav, name: str | None):
    proj = load_project(minimal_project)
    if name is not None:
        proj.meta.name = name
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _review(ws, **kwargs) -> str:
    ver = ReviewService(ws).publish(label="Boot header")
    return ShareService(ws).create(review_version_id=ver["id"], **kwargs)["token"]


def _quiet_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.media.review_media.load_object_store_config",
        lambda config_path=None: None,
    )


def _spliced(markup: str) -> str:
    return f'<div id="root">{markup}</div>'


@pytest.mark.parametrize("case", CASES, ids=[c["label"] for c in CASES])
def test_the_header_is_the_fixtures_markup_for_every_case(case):
    out = share_page.inject_share_boot_header(f"<body>{ROOT}</body>", case["name"])
    assert out == f"<body>{_spliced(case['markup'])}</body>"


def test_a_name_with_markup_characters_is_text_in_the_page():
    out = share_page.inject_share_boot_header(ROOT, "A <B> & \"C\" 'D'")
    assert "<B>" not in out and "<b>" not in out.lower()
    assert "A &lt;B&gt; &amp; &quot;C&quot; &#x27;D&#x27;" in out


@pytest.mark.parametrize("blank", ["", "   ", "\t\n "])
def test_a_blank_name_leaves_the_page_as_it_came(blank):
    assert share_page.inject_share_boot_header(SHELL, blank) == SHELL


@pytest.mark.parametrize(
    "html",
    [
        "<html><body></body></html>",
        f"<body>{ROOT}{ROOT}</body>",
        '<body><div id="root" class="x"></div></body>',
        '<body><div id="root"> </div></body>',
    ],
    ids=["no marker", "two markers", "other attributes", "not empty"],
)
def test_a_page_without_exactly_one_root_marker_is_returned_unchanged(html):
    assert share_page.inject_share_boot_header(html, "Pilot episode") == html


def test_a_named_open_link_carries_the_header_once_and_the_rest_is_the_page(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _quiet_audio(monkeypatch)
    case = next(c for c in CASES if "markup characters" in c["label"])
    name, markup = case["name"], case["markup"]
    token = _review(_seed(minimal_project, sample_wav, name))
    page = share_page.render_share_spa_html(
        token, index_html=SHELL, public_origin="https://share.example"
    )
    assert page.count(_spliced(markup)) == 1
    assert page.count("guest-loading") == 1
    assert "<b>" not in page.lower()
    rest = page.replace(_spliced(markup), ROOT)
    assert rest.count(ROOT) == 1
    assert rest.endswith("\n    " + ROOT + "\n  </body></html>")
    assert "<title>A &lt;B&gt; &amp; &quot;C&quot; &#x27;D&#x27;</title>" in rest


def test_an_episode_named_like_the_fallback_title_still_gets_the_header(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _quiet_audio(monkeypatch)
    token = _review(_seed(minimal_project, sample_wav, "Podcast review"))
    page = share_page.render_share_spa_html(
        token, index_html=SHELL, public_origin="https://share.example"
    )
    assert page.count("guest-loading") == 1
    assert '<h1 class="sr-only">Podcast review</h1>' in page


def test_the_route_serves_the_header_for_a_named_open_link(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    _quiet_audio(monkeypatch)
    token = _review(_seed(minimal_project, sample_wav, "Pilot episode"))
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    text = client.get(f"/r/{token}").text
    assert text.count('<h1 class="sr-only">Pilot episode</h1>') == 1
    assert 'role="status" class="sr-only">Loading Pilot episode…</p>' in text
    assert "<title>Pilot episode</title>" in text


def _assert_unnamed(response) -> None:
    assert response.status_code == 200
    assert ROOT in response.text
    assert "guest-loading" not in response.text
    assert "sys-header-title" not in response.text


def test_a_restricted_link_names_nothing(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    monkeypatch.setenv("PODCAST_SHARE_ACCOUNTS", "1")
    _quiet_audio(monkeypatch)
    ws = _seed(minimal_project, sample_wav, "Pilot episode")
    token = _review(ws, general_access="restricted")
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    response = client.get(f"/r/{token}")
    _assert_unnamed(response)
    assert "Pilot episode" not in response.text


def test_an_episode_with_no_name_gets_no_header(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    _quiet_audio(monkeypatch)
    token = _review(_seed(minimal_project, sample_wav, "  "))
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    _assert_unnamed(client.get(f"/r/{token}"))


def test_dead_and_wrong_kind_links_name_nothing_and_answer_alike(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    _quiet_audio(monkeypatch)
    ws = _seed(minimal_project, sample_wav, "Pilot episode")
    ver = ReviewService(ws).publish(label="Boot header")
    service = ShareService(ws)
    revoked = service.create(review_version_id=ver["id"])["token"]
    live = service.create(review_version_id=ver["id"])["token"]
    room = service.create_record_room()["guest"]["token"]
    service.revoke(revoked)
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    answers = [
        client.get("/r/definitely-missing"),
        client.get("/r/%3Cscript%3Ealert(1)%3C"),
        client.get(f"/r/{revoked}"),
        client.get(f"/r/{room}"),
        client.get(f"/rec/{live}"),
    ]
    for answer in answers:
        _assert_unnamed(answer)
        assert "Pilot episode" not in answer.text
    assert len({answer.text for answer in answers[:1] + answers[2:]}) == 1


def test_the_recording_room_and_the_host_page_name_nothing(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    _quiet_audio(monkeypatch)
    ws = _seed(minimal_project, sample_wav, "Pilot episode")
    room = ShareService(ws).create_record_room()["guest"]["token"]
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    recording = client.get(f"/rec/{room}")
    _assert_unnamed(recording)
    assert "Join the recording" in recording.text
    host = client.get("/")
    assert host.status_code == 200
    assert ROOT in host.text and "guest-loading" not in host.text


def test_a_raising_hook_serves_the_plain_page_without_a_header(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    _quiet_audio(monkeypatch)
    token = _review(_seed(minimal_project, sample_wav, "Pilot episode"))

    def broken(*_args: object, **_kwargs: object) -> str:
        raise RuntimeError("no page")

    monkeypatch.setattr("podcast_mcp.services.collaboration.render_share_spa_html", broken)
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    response = client.get(f"/r/{token}")
    _assert_unnamed(response)
    assert response.text == SHELL
