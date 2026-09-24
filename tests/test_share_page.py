"""Share SPA HTML head injection (title + Open Graph audio)."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.share import ShareService
from podcast_mcp.services.share_page import (
    build_share_head_tags,
    inject_share_document_head,
    render_share_spa_html,
    share_public_origin,
)


def test_render_share_spa_html_restricted_omits_audio(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setenv("PODCAST_SHARE_ACCOUNTS", "1")
    ws = ProjectWorkspace.open(minimal_project)
    art = Path(ws.project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="RestrictedOG")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        public_base_url="https://share.example",
        general_access="restricted",
    )
    html = render_share_spa_html(
        share["token"],
        index_html="<html><head></head><body></body></html>",
        public_origin="https://share.example",
    )
    assert "og:audio" not in html
    assert "Podcast review" in html


def test_build_share_head_tags_with_audio():
    head = build_share_head_tags(
        title="Shot of Truth - Eladio",
        description="Review mix: Vicky",
        page_url="https://sudo.science/r/tok",
        audio_url="https://cdn.example/mix.mp3",
    )
    assert "<title>Shot of Truth - Eladio</title>" in head
    assert 'property="og:title"' in head
    assert "Shot of Truth" in head
    assert 'property="og:audio"' in head
    assert "https://cdn.example/mix.mp3" in head
    assert 'property="og:type" content="music.song"' in head
    assert 'name="twitter:card" content="player"' in head


def test_build_share_head_tags_escapes_and_no_audio():
    head = build_share_head_tags(
        title='A <B> & "C"',
        description="desc",
        page_url="https://example.test/r/x",
    )
    assert "&lt;B&gt;" in head
    assert "&amp;" in head
    assert 'property="og:type" content="website"' in head
    assert "og:audio" not in head
    assert 'name="twitter:card" content="summary"' in head


def test_inject_replaces_vite_title():
    shell = (
        "<!doctype html><html><head>"
        "<title>web</title>"
        '<meta charset="UTF-8" />'
        '<script type="module" crossorigin src="./assets/index.js"></script>'
        "</head><body></body></html>"
    )
    out = inject_share_document_head(
        shell,
        build_share_head_tags(
            title="Episode",
            description="d",
            page_url="https://x/r/t",
            audio_url="https://x/api/review/t/audio",
        ),
    )
    assert out.count("<title>") == 1
    assert "<title>Episode</title>" in out
    assert "<title>web</title>" not in out
    assert 'property="og:audio"' in out
    assert '<base href="/" />' in out
    # Base must precede module scripts so ./assets resolves under /.
    assert out.index('<base href="/" />') < out.index('src="./assets/')


def test_render_share_spa_html_uses_episode_name(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: None,
    )
    proj = load_project(minimal_project)
    proj.meta.name = "Shot of Truth - Eladio"
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="Vicky review pass")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment", "reply"],
    )
    shell = "<html><head><title>web</title></head><body></body></html>"
    html = render_share_spa_html(
        share["token"],
        index_html=shell,
        public_origin="https://sudo.science",
    )
    assert "<title>Shot of Truth - Eladio</title>" in html
    assert "Review mix: Vicky review pass" in html
    assert f'content="https://sudo.science/api/review/{share["token"]}/audio"' in html
    assert f'content="https://sudo.science/r/{share["token"]}"' in html


def test_share_public_origin_prefers_relay(monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.share_page.load_relay_config",
        lambda **_kwargs: type("Relay", (), {"public_base_url": "https://sudo.science"})(),
    )
    assert share_public_origin("http://127.0.0.1:8765/") == "https://sudo.science"


def test_share_public_origin_fallbacks(monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.share_page.load_relay_config",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("no cfg")),
    )
    assert share_public_origin("http://example.test/") == "http://example.test"
    assert share_public_origin(None) == "http://127.0.0.1:8765"


def test_build_share_head_tags_with_image():
    head = build_share_head_tags(
        title="T",
        description="d",
        page_url="https://x/r/t",
        image_url="https://cdn.example/cover.jpg",
    )
    assert 'property="og:image"' in head
    assert "cover.jpg" in head


def test_inject_without_head_marker():
    out = inject_share_document_head("<html><body></body></html>", "<title>X</title>")
    assert "<title>X</title>" in out


def test_share_audio_url_requires_play_and_https_object_store(monkeypatch):
    from podcast_mcp.services.share_page import share_audio_url_for_preview

    assert (
        share_audio_url_for_preview(
            "tok",
            public_origin="https://x",
            row={"capabilities": ["comment"], "review_version_id": "v"},
            project=None,
        )
        is None
    )
    assert (
        share_audio_url_for_preview(
            "tok",
            public_origin="https://x",
            row={"capabilities": ["play"]},
            project=None,
        )
        == "https://x/api/review/tok/audio"
    )

    monkeypatch.setattr(
        "podcast_mcp.services.review_media.presigned_review_audio_url",
        lambda *a, **k: "https://object-store.example.test/a.mp3",
    )
    assert (
        share_audio_url_for_preview(
            "tok",
            public_origin="https://x",
            row={"capabilities": ["play"], "review_version_id": "v1"},
            project=object(),
        )
        == "https://object-store.example.test/a.mp3"
    )

    monkeypatch.setattr(
        "podcast_mcp.services.review_media.presigned_review_audio_url",
        lambda *a, **k: "http://insecure.example/a.mp3",
    )
    assert (
        share_audio_url_for_preview(
            "tok",
            public_origin="https://x",
            row={"capabilities": ["play"], "review_version_id": "v1"},
            project=object(),
        )
        == "https://x/api/review/tok/audio"
    )

    monkeypatch.setattr(
        "podcast_mcp.services.review_media.presigned_review_audio_url",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    assert (
        share_audio_url_for_preview(
            "tok",
            public_origin="https://x",
            row={"capabilities": ["play"], "review_version_id": "v1"},
            project=object(),
        )
        == "https://x/api/review/tok/audio"
    )


def test_render_share_spa_html_empty_label_and_audio_type(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: None,
    )
    proj = load_project(minimal_project)
    proj.meta.name = "Named Ep"
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="temp")
    # Simulate an empty review-mix label on the frozen version.
    monkeypatch.setattr(
        "podcast_mcp.services.share_page.get_version",
        lambda project, vid: type("V", (), {"label": ""})(),
    )
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.media_type_for_path",
        lambda path: "audio/wav",
    )
    html = render_share_spa_html(
        share["token"],
        index_html="<html><head><title>web</title></head></html>",
        public_origin="https://sudo.science",
    )
    assert "Review of Named Ep" in html
    assert "og:audio" in html

    monkeypatch.setattr(
        "podcast_mcp.services.review_media.review_guest_audio_path",
        lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()),
    )
    html2 = render_share_spa_html(
        share["token"],
        index_html="<html><head><title>web</title></head></html>",
        public_origin="https://sudo.science",
    )
    assert "og:audio" in html2


def test_render_record_spa_html_no_audio_tags(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.share_page import render_record_spa_html

    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    room = ShareService(ws).create_record_room(public_base_url="https://share.example")
    html = render_record_spa_html(
        room["guest"]["token"],
        index_html="<html><head></head><body></body></html>",
        public_origin="https://share.example",
    )
    assert "Join the recording | test_episode" in html
    assert "og:audio" not in html
    assert 'property="og:type"' in html
    assert "website" in html
    assert f"/rec/{room['guest']['token']}" in html

    producer_html = render_record_spa_html(
        room["producer"]["token"],
        index_html="<html><head></head><body></body></html>",
        public_origin="https://share.example",
    )
    assert "Producer (not recorded) | test_episode" in producer_html


def test_share_public_origin_empty_relay(monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.share_page.load_relay_config",
        lambda **_kwargs: type("Relay", (), {"public_base_url": "  "})(),
    )
    assert share_public_origin("http://fallback.test/") == "http://fallback.test"


def test_render_share_spa_html_fallback_token(monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.share.open_share_workspace",
        lambda token: (_ for _ in ()).throw(KeyError("missing")),
    )
    html = render_share_spa_html(
        "missing-tok",
        index_html="<html><head><title>web</title></head></html>",
        public_origin="https://sudo.science",
    )
    assert "<title>Podcast review</title>" in html
