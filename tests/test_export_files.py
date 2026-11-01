"""The exported-files listing and download, on the host and Editor routes."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from podcast_mcp.export.chapters import render_chapters_json
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.gui.host_reveal import reveal_in_file_manager
from podcast_mcp.gui.routes import export_ticket
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    ChapterMarker,
    EpisodeProject,
    ReviewMixVersion,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import ExportFilesService, ServedFile, TranscriptService
from podcast_mcp.services.jobs import Job
from podcast_mcp.util.coded_error import CodedFileNotFoundError

CODE = "x-sharecut-error-code"
GUEST = "/api/review/{token}/daw/export/files"
GONE = "That file is no longer there. Refresh to see what is available."
RUNNING = "Exporting now. Download when it finishes."
MP3 = b"mp3-bytes-" * 100
WAV = bytes(range(256)) * 40


def _chapters() -> list[ChapterMarker]:
    return [ChapterMarker(time=0.0, title="Cold open"), ChapterMarker(time=61.5, title="Main")]


@pytest.fixture
def ws(tmp_workspace: Path) -> ProjectWorkspace:
    created = EpisodeProject.create("test_episode", str(tmp_workspace))
    created.ensure_dirs()
    minimal_project = save_project(created)
    proj = load_project(minimal_project)
    proj.chapters = _chapters()
    proj.review.versions = [
        ReviewMixVersion(
            id="files-version",
            label="Files",
            created_at="2026-01-01T00:00:00Z",
            audio_relpath="artifacts/review/files-version/mix.wav",
        )
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=w, start=i * 0.5, end=i * 0.5 + 0.4)
                for i, w in enumerate(["Hello", "there."])
            ],
        )
    ]
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


@pytest.fixture
def folder(ws: ProjectWorkspace) -> Path:
    export = ws.project.export_dir()
    stem = sanitize_export_stem(ws.project.name)
    export.mkdir(parents=True, exist_ok=True)
    (export / f"{stem}.wav").write_bytes(WAV)
    (export / f"{stem}.mp3").write_bytes(MP3)
    (export / f"{stem}.chapters.json").write_text(
        render_chapters_json(_chapters()), encoding="utf-8"
    )
    (export / "notes.txt").write_text("not an export", encoding="utf-8")
    (export / f"{stem}.json").write_text("{}", encoding="utf-8")
    (export / "clips").mkdir()
    (export / "clips" / "cold-open_c1.wav").write_bytes(WAV[:512])
    (export / "clips" / "cold-open_c1.json").write_text("{}", encoding="utf-8")
    (export / "bounces").mkdir()
    (export / "bounces" / "range.wav").write_bytes(WAV[:64])
    TranscriptService(ws).export(["md", "srt"])
    return export


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _ids(files: list[dict]) -> list[str]:
    return [f["id"] for f in files]


def test_the_listing_is_the_export_files_and_nothing_else(ws, folder) -> None:
    stem = sanitize_export_stem(ws.project.name)

    files = ExportFilesService(ws).list()

    assert [(f.id, f.kind, f.label) for f in files] == [
        (f"{stem}.mp3", "audio", "Listening file"),
        (f"{stem}.wav", "audio", "Lossless master"),
        ("clips/cold-open_c1.wav", "audio", "Clip"),
        (f"{stem}.md", "transcript", "Markdown"),
        (f"{stem}.srt", "transcript", "Captions"),
        (f"{stem}.chapters.json", "chapters", "Chapters"),
    ]
    sizes = {f.id: f.bytes for f in files}
    assert sizes[f"{stem}.mp3"] == len(MP3)
    assert sizes["clips/cold-open_c1.wav"] == 512
    assert next(f for f in files if f.id == "clips/cold-open_c1.wav").name == "cold-open_c1.wav"


def test_current_follows_what_each_writer_supports(ws, folder) -> None:
    stem = sanitize_export_stem(ws.project.name)
    assert {f.id: f.current for f in ExportFilesService(ws).list()} == {
        f"{stem}.mp3": True,
        f"{stem}.wav": True,
        "clips/cold-open_c1.wav": True,
        f"{stem}.md": True,
        f"{stem}.srt": True,
        f"{stem}.chapters.json": True,
    }

    proj = load_project(ws.path)
    proj.chapters = [ChapterMarker(time=0.0, title="Renamed")]
    proj.transcripts[0].words[0].text = "Howdy"
    save_project(proj, ws.path)
    after = {f.id: f.current for f in ExportFilesService(ProjectWorkspace.open(ws.path)).list()}

    assert after[f"{stem}.chapters.json"] is False
    assert after[f"{stem}.md"] is False
    assert after[f"{stem}.mp3"] is True


def test_a_stale_feed_file_is_listed_as_not_current(ws, folder) -> None:
    stem = sanitize_export_stem(ws.project.name)
    (folder / f"{stem}.feed.xml").write_text("<rss/>", encoding="utf-8")

    feed = next(f for f in ExportFilesService(ws).list() if f.kind == "feed")

    assert (feed.id, feed.label, feed.current) == (f"{stem}.feed.xml", "Feed file", False)


@pytest.mark.parametrize(
    "file_id", ["../notes.txt", "clips/../notes.txt", "./clips/cold-open_c1.wav"]
)
def test_an_id_is_matched_as_a_whole_never_joined_to_a_path(ws, folder, file_id) -> None:
    with pytest.raises(CodedFileNotFoundError) as refused:
        ExportFilesService(ws).open(file_id)

    assert refused.value.code == "export_file_gone"


def test_an_empty_export_folder_lists_nothing(ws) -> None:
    assert ExportFilesService(ws).list() == []


def test_the_host_lists_and_downloads_with_no_host_path(ws, folder, client) -> None:
    res = client.get("/api/export/files", params={"path": str(ws.path)})

    assert res.status_code == 200
    assert set(res.json()["files"][0]) == {
        "id",
        "name",
        "kind",
        "label",
        "bytes",
        "current",
        "ticket",
    }
    assert str(ws.path.parent) not in res.text


@pytest.mark.parametrize(
    "file_id",
    [
        "notes.txt",
        "test_episode.json",
        "clips/cold-open_c1.json",
        "bounces/range.wav",
        "clips/../notes.txt",
        "..%2fnotes.txt",
        "/etc/passwd",
        "clips",
        "missing.mp3",
    ],
)
def test_an_unlisted_id_is_a_404_on_the_host(ws, folder, client, file_id) -> None:
    res = client.get(f"/api/export/files/{file_id}", params={"path": str(ws.path)})

    assert (res.status_code, res.headers[CODE], res.json()["detail"]) == (
        404,
        "export_file_gone",
        GONE,
    )


def test_a_symlink_cannot_reach_outside_the_export_folder(ws, folder, client, tmp_path) -> None:
    stem = sanitize_export_stem(ws.project.name)
    secret = tmp_path / "secret.mp3"
    secret.write_bytes(b"secret")
    (folder / f"{stem}.mp3").unlink()
    (folder / f"{stem}.mp3").symlink_to(secret)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "leak.wav").write_bytes(b"leak")
    (folder / "clips" / "cold-open_c1.wav").unlink()
    (folder / "clips").rename(folder / "clips-real")
    (folder / "clips").symlink_to(outside)

    ids = _ids(client.get("/api/export/files", params={"path": str(ws.path)}).json()["files"])

    assert f"{stem}.mp3" not in ids and not any(i.startswith("clips/") for i in ids)
    for file_id in (f"{stem}.mp3", "clips/leak.wav"):
        res = client.get(f"/api/export/files/{file_id}", params={"path": str(ws.path)})
        assert (res.status_code, res.headers[CODE]) == (404, "export_file_gone")
        assert b"secret" not in res.content and b"leak" not in res.content


def test_a_download_is_an_attachment_with_range_and_etag(ws, folder, client) -> None:
    stem = sanitize_export_stem(ws.project.name)
    url, params = f"/api/export/files/{stem}.wav", {"path": str(ws.path)}

    full = client.get(url, params=params)

    assert full.status_code == 200 and full.content == WAV
    assert full.headers["content-disposition"] == f'attachment; filename="{stem}.wav"'
    assert full.headers["content-type"] == "audio/wav"
    assert full.headers["accept-ranges"] == "bytes"
    assert full.headers["x-content-type-options"] == "nosniff"
    assert full.headers["etag"]

    part = client.get(url, params=params, headers={"Range": "bytes=10-19"})
    assert part.status_code == 206 and part.content == WAV[10:20]
    assert part.headers["content-range"] == f"bytes 10-19/{len(WAV)}"

    again = client.get(url, params=params, headers={"If-None-Match": full.headers["etag"]})
    assert again.status_code == 304


def test_media_types_follow_the_kind(ws, folder, client) -> None:
    stem = sanitize_export_stem(ws.project.name)
    params = {"path": str(ws.path)}

    types = {
        name: client.get(f"/api/export/files/{name}", params=params).headers["content-type"]
        for name in (
            f"{stem}.mp3",
            f"{stem}.srt",
            f"{stem}.chapters.json",
            "clips/cold-open_c1.wav",
        )
    }

    assert types[f"{stem}.mp3"] == "audio/mpeg"
    assert types[f"{stem}.srt"].startswith("application/x-subrip")
    assert types[f"{stem}.chapters.json"].startswith("application/json")
    assert types["clips/cold-open_c1.wav"] == "audio/wav"


def test_a_clip_downloads_under_its_own_file_name(ws, folder, client) -> None:
    res = client.get("/api/export/files/clips/cold-open_c1.wav", params={"path": str(ws.path)})

    assert res.status_code == 200 and res.content == WAV[:512]
    assert res.headers["content-disposition"] == 'attachment; filename="cold-open_c1.wav"'


def test_the_host_routes_refuse_a_relayed_request(ws, folder, client) -> None:
    relayed = {"x-sharecut-relayed": "1"}
    params = {"path": str(ws.path)}
    stem = sanitize_export_stem(ws.project.name)

    listed = client.get("/api/export/files", params=params, headers=relayed)
    file = client.get(f"/api/export/files/{stem}.mp3", params=params, headers=relayed)

    assert (listed.status_code, file.status_code) == (403, 403)


REMOTE = ("203.0.113.9", 5000)
SESSION = {"X-Podcast-Token": "s3cret"}


@pytest.fixture
def strict(monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "s3cret")


@pytest.fixture
def remote(strict) -> TestClient:
    return TestClient(create_app(), client=REMOTE)


def _tickets(client: TestClient, ws: ProjectWorkspace) -> dict[str, str]:
    res = client.get("/api/export/files", params={"path": str(ws.path)}, headers=SESSION)
    assert res.status_code == 200
    return {f["id"]: f["ticket"] for f in res.json()["files"]}


def test_a_ticket_downloads_a_file_where_no_session_token_is_sent(ws, folder, remote) -> None:
    stem = sanitize_export_stem(ws.project.name)
    ticket = _tickets(remote, ws)[f"{stem}.mp3"]
    url = f"/api/export/files/{stem}.mp3"

    res = remote.get(url, params={"path": str(ws.path), "ticket": ticket})
    bare = remote.get(url, params={"path": str(ws.path)})

    assert (res.status_code, res.content) == (200, MP3)
    assert res.headers["content-disposition"].startswith("attachment")
    assert bare.status_code == 403
    assert remote.head(url, params={"path": str(ws.path), "ticket": "junk"}).status_code == 403


def test_a_ticket_opens_only_its_own_file(ws, folder, remote) -> None:
    stem = sanitize_export_stem(ws.project.name)
    tickets = _tickets(remote, ws)

    res = remote.get(
        f"/api/export/files/{stem}.wav",
        params={"path": str(ws.path), "ticket": tickets[f"{stem}.mp3"]},
    )

    assert (res.status_code, res.headers[CODE]) == (403, "export_ticket_invalid")


def test_a_ticket_does_not_open_the_listing_or_reveal(ws, folder, remote) -> None:
    stem = sanitize_export_stem(ws.project.name)
    ticket = _tickets(remote, ws)[f"{stem}.mp3"]

    listed = remote.get("/api/export/files", params={"path": str(ws.path), "ticket": ticket})
    revealed = remote.post(
        "/api/export/files/reveal",
        params={"ticket": ticket},
        json={"path": str(ws.path), "id": f"{stem}.mp3"},
    )

    assert (listed.status_code, revealed.status_code) == (403, 403)


def test_a_changed_signature_is_refused(ws, folder, remote) -> None:
    stem = sanitize_export_stem(ws.project.name)
    ticket = _tickets(remote, ws)[f"{stem}.mp3"]
    forged = ticket[:-1] + ("0" if ticket[-1] != "0" else "1")

    res = remote.get(
        f"/api/export/files/{stem}.mp3", params={"path": str(ws.path), "ticket": forged}
    )

    assert (res.status_code, res.headers[CODE]) == (403, "export_ticket_invalid")


def test_an_expired_ticket_is_a_410(ws, folder, remote, monkeypatch) -> None:
    stem = sanitize_export_stem(ws.project.name)
    ticket = _tickets(remote, ws)[f"{stem}.mp3"]
    monkeypatch.setattr(
        export_ticket, "_now", lambda: time.time() + export_ticket.TICKET_TTL_SEC + 5
    )

    res = remote.get(
        f"/api/export/files/{stem}.mp3", params={"path": str(ws.path), "ticket": ticket}
    )

    assert (res.status_code, res.headers[CODE]) == (410, "export_ticket_expired")


def test_a_file_rewritten_after_the_listing_voids_its_ticket(ws, folder, remote) -> None:
    stem = sanitize_export_stem(ws.project.name)
    ticket = _tickets(remote, ws)[f"{stem}.mp3"]
    (folder / f"{stem}.mp3").write_bytes(MP3 + b"more")

    res = remote.get(
        f"/api/export/files/{stem}.mp3", params={"path": str(ws.path), "ticket": ticket}
    )

    assert (res.status_code, res.headers[CODE]) == (410, "export_file_changed")


def test_a_ticket_is_refused_on_a_relayed_request(ws, folder, remote) -> None:
    stem = sanitize_export_stem(ws.project.name)
    ticket = _tickets(remote, ws)[f"{stem}.mp3"]

    res = remote.get(
        f"/api/export/files/{stem}.mp3",
        params={"path": str(ws.path), "ticket": ticket},
        headers={"x-sharecut-relayed": "1"},
    )

    assert res.status_code == 403


def test_the_session_token_in_the_query_still_downloads_without_a_ticket(
    ws, folder, remote
) -> None:
    stem = sanitize_export_stem(ws.project.name)
    url = f"/api/export/files/{stem}.mp3"

    res = remote.get(url, params={"path": str(ws.path), "token": "s3cret"})

    assert (res.status_code, res.content) == (200, MP3)


def test_a_ticket_lives_thirty_minutes(ws, folder, remote, monkeypatch) -> None:
    stem = sanitize_export_stem(ws.project.name)
    ticket = _tickets(remote, ws)[f"{stem}.mp3"]
    params = {"path": str(ws.path), "ticket": ticket}
    url = f"/api/export/files/{stem}.mp3"
    issued = int(ticket.partition(".")[0]) - export_ticket.TICKET_TTL_SEC

    monkeypatch.setattr(export_ticket, "_now", lambda: issued + 30 * 60 - 1)
    inside = remote.get(url, params=params)
    monkeypatch.setattr(export_ticket, "_now", lambda: issued + 30 * 60 + 1)
    outside = remote.get(url, params=params)

    assert (inside.status_code, outside.status_code) == (200, 410)


def test_an_unresolvable_path_with_a_ticket_is_a_403(ws, folder, remote) -> None:
    stem = sanitize_export_stem(ws.project.name)
    version = ExportFilesService(ws).open(f"{stem}.mp3").version
    minted = export_ticket.mint(ws.path, f"{stem}.mp3", version)

    res = remote.get(
        f"/api/export/files/{stem}.mp3", params={"path": "~nosuchuser/x", "ticket": minted}
    )

    assert (res.status_code, res.headers[CODE]) == (403, "export_ticket_invalid")


@pytest.mark.parametrize("ticket", ["x", ".", "..", "1.2.é", "é.2.sig", "9" * 5000 + ".2.sig", ""])
def test_a_junk_ticket_is_a_403_before_anything_else_is_read(ws, folder, remote, ticket) -> None:
    stem = sanitize_export_stem(ws.project.name)
    _run_export(remote.app, ws)

    res = remote.get(
        f"/api/export/files/{stem}.mp3", params={"path": str(ws.path), "ticket": ticket}
    )

    assert (res.status_code, res.headers[CODE]) == (403, "export_ticket_invalid")


def test_a_ticket_belongs_to_one_project(ws, folder, tmp_path) -> None:
    stem = sanitize_export_stem(ws.project.name)
    version = ExportFilesService(ws).open(f"{stem}.mp3").version
    ticket = export_ticket.mint(ws.path, f"{stem}.mp3", version)

    with pytest.raises(HTTPException) as refused:
        export_ticket.verified_version(ticket, str(tmp_path / "other.json"), f"{stem}.mp3")

    assert refused.value.status_code == 403


def _run_export(app, ws: ProjectWorkspace, status: str = "running") -> None:
    app.state.jobs._catalog._job = Job(
        id="export-1", kind="export", status=status, project_path=str(ws.path)
    )


def test_a_download_is_a_409_while_an_export_runs_and_the_list_still_loads(
    ws, folder, client
) -> None:
    stem = sanitize_export_stem(ws.project.name)
    _run_export(client.app, ws)

    res = client.get(f"/api/export/files/{stem}.mp3", params={"path": str(ws.path)})
    listed = client.get("/api/export/files", params={"path": str(ws.path)})

    assert (res.status_code, res.headers[CODE], res.json()["detail"]) == (
        409,
        "export_running",
        RUNNING,
    )
    assert listed.status_code == 200

    _run_export(client.app, ws, status="done")
    assert (
        client.get(f"/api/export/files/{stem}.mp3", params={"path": str(ws.path)}).status_code
        == 200
    )


@pytest.fixture
def world(ws, folder):
    review = "files-version"
    tokens = {
        role: ShareService(ws).create(
            review_version_id=review, capabilities=capabilities_for_role(role)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    app = create_app()
    return SimpleNamespace(
        client=TestClient(app), app=app, ws=ws, tokens=tokens, share=ShareService(ws)
    )


def test_an_editor_lists_and_downloads_without_the_render_opt_in(world, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_GUEST_RENDER", raising=False)
    base = GUEST.format(token=world.tokens["editor"])
    stem = sanitize_export_stem(world.ws.project.name)

    listed = world.client.get(base)
    file = world.client.get(f"{base}/{stem}.mp3", headers={"Range": "bytes=0-9"})
    clip = world.client.get(f"{base}/clips/cold-open_c1.wav")

    assert listed.status_code == 200 and f"{stem}.mp3" in _ids(listed.json()["files"])
    assert all("ticket" not in f for f in listed.json()["files"])
    assert str(world.ws.path.parent) not in listed.text
    assert (file.status_code, file.content) == (206, MP3[:10])
    assert file.headers["content-disposition"].startswith("attachment;")
    assert (clip.status_code, clip.content) == (200, WAV[:512])


@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_a_lesser_role_is_refused_on_both_routes(world, role) -> None:
    base = GUEST.format(token=world.tokens[role])
    stem = sanitize_export_stem(world.ws.project.name)

    for url in (base, f"{base}/{stem}.mp3"):
        res = world.client.get(url)
        assert (res.status_code, res.headers[CODE]) == (403, "share_capability_required")
        assert MP3 not in res.content


def test_an_editor_is_refused_an_unlisted_id_and_a_revoked_link(world) -> None:
    base = GUEST.format(token=world.tokens["editor"])

    for file_id in ("notes.txt", "..%2ftest_episode.sharecut", "bounces/range.wav"):
        res = world.client.get(f"{base}/{file_id}")
        assert (res.status_code, res.headers[CODE], res.json()["detail"]) == (
            404,
            "export_file_gone",
            GONE,
        )

    world.share.revoke(world.tokens["editor"])
    assert world.client.get(base).headers[CODE] == "share_not_found"


def test_an_editor_download_is_a_409_while_an_export_runs(world) -> None:
    base = GUEST.format(token=world.tokens["editor"])
    stem = sanitize_export_stem(world.ws.project.name)
    _run_export(world.app, world.ws)

    res = world.client.get(f"{base}/{stem}.mp3")

    assert (res.status_code, res.headers[CODE], res.json()["detail"]) == (
        409,
        "export_running",
        RUNNING,
    )
    assert world.client.get(base).status_code == 200


@pytest.fixture
def local() -> TestClient:
    return TestClient(create_app(), client=("127.0.0.1", 50000))


def test_reveal_shows_a_listed_file_and_refuses_everything_else(
    ws, folder, local, client, monkeypatch
) -> None:
    shown: list[Path] = []
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.export_files.reveal_in_file_manager",
        lambda path: shown.append(path) or True,
    )
    stem = sanitize_export_stem(ws.project.name)
    url = "/api/export/files/reveal"

    ok = local.post(url, json={"path": str(ws.path), "id": f"{stem}.mp3"})
    gone = local.post(url, json={"path": str(ws.path), "id": "notes.txt"})
    relayed = local.post(
        url, json={"path": str(ws.path), "id": f"{stem}.mp3"}, headers={"x-sharecut-relayed": "1"}
    )
    lan = client.post(url, json={"path": str(ws.path), "id": f"{stem}.mp3"})

    assert (ok.status_code, ok.json()) == (200, {"revealed": True})
    assert shown == [(folder / f"{stem}.mp3").resolve()]
    assert (gone.status_code, gone.headers[CODE]) == (404, "export_file_gone")
    assert (relayed.status_code, lan.status_code) == (403, 403)
    assert lan.headers[CODE] == "reveal_not_allowed"
    assert len(shown) == 1


def test_reveal_reports_a_computer_with_no_file_manager(ws, folder, local, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.export_files.reveal_in_file_manager", lambda path: False
    )
    stem = sanitize_export_stem(ws.project.name)

    res = local.post("/api/export/files/reveal", json={"path": str(ws.path), "id": f"{stem}.mp3"})

    assert (res.status_code, res.headers[CODE]) == (409, "reveal_unavailable")


@pytest.mark.parametrize(
    ("system", "argv"),
    [
        ("Darwin", ["open", "-R", "/x/e/a.mp3"]),
        ("Windows", ["explorer", "/select,/x/e/a.mp3"]),
        ("Linux", ["xdg-open", "/x/e"]),
    ],
)
def test_the_file_manager_is_launched_with_an_argv_list(monkeypatch, system, argv) -> None:
    calls: list[list[str]] = []

    def run(args, **_kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr("podcast_mcp.gui.host_reveal.process.run", run)

    assert reveal_in_file_manager(Path("/x/e/a.mp3"), system=system) is True
    assert calls == [argv]
    assert reveal_in_file_manager(Path("/x/e/a.mp3"), system="Plan9") is False


@pytest.mark.parametrize(
    ("system", "opened"), [("Darwin", False), ("Linux", False), ("Windows", True)]
)
def test_a_failed_file_manager_exit_is_reported_except_for_explorers_odd_code(
    monkeypatch, system, opened
) -> None:
    monkeypatch.setattr(
        "podcast_mcp.gui.host_reveal.process.run",
        lambda args, **_kw: subprocess.CompletedProcess(args, 1),
    )

    assert reveal_in_file_manager(Path("/x/e/a.mp3"), system=system) is opened


def test_a_name_with_a_control_or_bidi_character_is_not_listed(ws, folder) -> None:
    clips = folder / "clips"
    for name in (
        "flip\u202ecod.wav",
        "bell\x07.wav",
        "split\u2028line.wav",
        "plain.wav",
        "fam\U0001f468\u200d\U0001f469.wav",
    ):
        (clips / name).write_bytes(WAV[:512])

    ids = [f.id for f in ExportFilesService(ws).list()]

    assert "clips/plain.wav" in ids
    assert "clips/fam\U0001f468\u200d\U0001f469.wav" in ids
    assert not [i for i in ids if any(c in i for c in "\u202e\x07\u2028")]


def test_a_file_that_vanishes_between_the_scan_and_the_stat_is_skipped(
    ws, folder, monkeypatch
) -> None:
    stem = sanitize_export_stem(ws.project.name)
    service = ExportFilesService(ws)

    def gone(_path):
        raise FileNotFoundError

    monkeypatch.setattr("podcast_mcp.services.document.export_files.file_stamp", gone)
    assert service.list() == []
    with pytest.raises(CodedFileNotFoundError) as caught:
        service.open(f"{stem}.mp3")
    assert caught.value.code == "export_file_gone"


def test_the_listing_skips_a_found_file_whose_size_cannot_be_read(ws, folder, monkeypatch) -> None:
    service = ExportFilesService(ws)
    missing = ServedFile("x.mp3", "audio", folder / "missing.mp3", "audio/mpeg", "1-1")
    monkeypatch.setattr(service, "_found", lambda: [missing])

    assert service.listed() == []


def test_a_head_request_answers_with_the_headers_and_no_body(ws, folder, remote) -> None:
    stem = sanitize_export_stem(ws.project.name)
    ticket = _tickets(remote, ws)[f"{stem}.mp3"]
    url = f"/api/export/files/{stem}.mp3"
    params = {"path": str(ws.path), "ticket": ticket}

    head = remote.head(url, params=params)
    get = remote.get(url, params=params)
    bare = remote.head(url, params={"path": str(ws.path)})

    assert (head.status_code, head.content) == (200, b"")
    assert head.headers["content-length"] == str(len(MP3))
    assert head.headers["content-disposition"] == get.headers["content-disposition"]
    assert head.headers["etag"] == get.headers["etag"]
    assert bare.status_code == 403
    assert remote.head(url, params={"path": str(ws.path), "ticket": "junk"}).status_code == 403
