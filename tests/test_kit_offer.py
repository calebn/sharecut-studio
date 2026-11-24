"""Whether an episode should be offered the show kit, on every surface."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import kits as tools
from podcast_mcp.models import Clip, EpisodeProject, Track, save_project
from podcast_mcp.models.episode import MediaAsset, ProjectUnreadableError, SegmentRef
from podcast_mcp.segments import store as store_module
from podcast_mcp.segments.kit import KitEntry, KitFile, KitListing, KitStore, kit_id_for
from podcast_mcp.segments.kit_offer import offer_report
from podcast_mcp.segments.kit_summary import failing_entries, resolve_kit
from podcast_mcp.segments.model import SEGMENT_JSON
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.document import report_kit_offer
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER
from segment_helpers import make_segment_dir

runner = CliRunner()


@pytest.fixture(autouse=True)
def _config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config = tmp_path / "config"
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(config))
    return config


@pytest.fixture
def segments() -> SegmentStore:
    return SegmentStore()


@pytest.fixture
def kits() -> KitStore:
    return KitStore()


@pytest.fixture
def make_project(tmp_workspace: Path, sample_wav: Path) -> Callable[..., Path]:
    def build(*refs: SegmentRef | None) -> Path:
        raw = tmp_workspace / "raw"
        raw.mkdir(exist_ok=True)
        (raw / "host.wav").write_bytes(sample_wav.read_bytes())
        episode = EpisodeProject.create("episode", str(tmp_workspace))
        episode.ensure_dirs()
        episode.tracks = [Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav"))]
        episode.clips = [
            Clip(
                id=f"c{index}",
                track_id="host",
                source_start=0.0,
                source_end=1.0,
                timeline_start=float(index * 2),
                segment_ref=ref,
            )
            for index, ref in enumerate(refs, start=1)
        ]
        return save_project(episode)

    return build


def _put(segments: SegmentStore, tmp_path: Path, name: str, audio: bytes = b"fLaC-one") -> str:
    return segments.add(make_segment_dir(tmp_path / "source", name=name, audio=audio)).id


def _kit(kits: KitStore, name: str, *specs: tuple[str, object, int | None]) -> KitFile:
    kit = KitFile(
        id=kit_id_for(name),
        name=name,
        entries=[KitEntry(segment_id=s, at=at, version=v) for s, at, v in specs],  # type: ignore[arg-type]
    )
    kits.add(kit)
    return kit


def _offer(path: Path) -> dict:
    return report_kit_offer(path, KitStore(), SegmentStore())


def _tree(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_no_clips(make_project: Callable[..., Path], kits: KitStore) -> None:
    assert _offer(make_project()) == {
        "offer": False,
        "reason": "no_clips",
        "kits": [],
        "unusable": [],
    }


def test_no_clips_is_checked_before_already_has_segments() -> None:
    report = offer_report(False, True, KitListing([], []), {}, {})
    assert report["reason"] == "no_clips"


def test_already_has_segments(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    segment_id = _put(segments, tmp_path, "Warm Intro")
    _kit(kits, "Show Kit", (segment_id, "start", None))
    sha = segments.read_version(segment_id, 1).content_sha256
    ref = SegmentRef(segment_id=segment_id, version=1, content_sha256=sha)
    report = _offer(make_project(None, ref))
    assert report == {"offer": False, "reason": "already_has_segments", "kits": [], "unusable": []}


def test_no_kits(make_project: Callable[..., Path]) -> None:
    report = _offer(make_project(None))
    assert report == {"offer": False, "reason": "no_kits", "kits": [], "unusable": []}


def test_offer_lists_usable_kits_sorted_by_name_with_resolved_versions(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    _put(segments, tmp_path, "Warm Intro", b"fLaC-two")
    outro = _put(segments, tmp_path, "Sign Off", b"fLaC-out")
    zed = _kit(kits, "Zed Kit", (intro, "start", None))
    alpha = _kit(kits, "Alpha Kit", (intro, "start", 1), (outro, "end", None))
    report = _offer(make_project(None))
    assert report["offer"] is True and report["reason"] == "offer"
    assert report["unusable"] == []
    assert [k["id"] for k in report["kits"]] == [alpha.id, zed.id]
    assert report["kits"][0] == {
        "id": alpha.id,
        "name": "Alpha Kit",
        "version": 1,
        "entries": [
            {"segment_id": intro, "version": 1, "at": "start", "note": None},
            {"segment_id": outro, "version": 1, "at": "end", "note": None},
        ],
    }
    assert report["kits"][1]["entries"][0]["version"] == 2


def test_a_kit_with_missing_segments_is_unusable_with_a_count(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    good = _kit(kits, "Good Kit", (intro, "start", None))
    bad = _kit(
        kits, "Bad Kit", (intro, "start", None), ("gone-00000000", "end", None), (intro, 9, 7)
    )
    report = _offer(make_project(None))
    assert report["reason"] == "offer"
    assert [k["id"] for k in report["kits"]] == [good.id]
    [row] = report["unusable"]
    assert (row["id"], row["name"], row["version"], row["missing"]) == (bad.id, "Bad Kit", 1, 2)
    assert row["problem"] == "There is no segment called gone-00000000."
    assert set(row) == {"id", "name", "version", "missing", "problem"}


def test_no_usable_kits(make_project: Callable[..., Path], kits: KitStore) -> None:
    bad = _kit(kits, "Bad Kit", ("gone-00000000", "start", None))
    report = _offer(make_project(None))
    assert (report["offer"], report["reason"], report["kits"]) == (False, "no_usable_kits", [])
    assert [(r["id"], r["missing"]) for r in report["unusable"]] == [(bad.id, 1)]


def test_a_damaged_newest_kit_version_is_ignored(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    broken = _kit(kits, "Broken Kit", (intro, "start", None))
    (kits.directory / broken.id / "v1" / "kit.json").write_text("{", encoding="utf-8")
    assert kits.scan().damaged
    assert _offer(make_project(None))["reason"] == "no_kits"
    fine = _kit(kits, "Fine Kit", (intro, "start", None))
    report = _offer(make_project(None))
    assert [k["id"] for k in report["kits"]] == [fine.id] and report["unusable"] == []


def test_a_damaged_segment_json_makes_the_kit_unusable(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    _kit(kits, "Show Kit", (intro, "start", None))
    (segments.path(intro, 1) / SEGMENT_JSON).write_text("{", encoding="utf-8")
    report = _offer(make_project(None))
    assert report["reason"] == "no_usable_kits"
    assert report["unusable"][0]["missing"] == 1
    assert report["unusable"][0]["problem"]


def test_a_changed_file_size_makes_the_kit_unusable(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    _kit(kits, "Show Kit", (intro, "start", None))
    (segments.path(intro, 1) / "clip-01.flac").write_bytes(b"fLaC-one-and-more")
    report = _offer(make_project(None))
    assert report["reason"] == "no_usable_kits"
    assert report["unusable"][0]["missing"] == 1
    assert "clip-01.flac" in report["unusable"][0]["problem"]


def test_a_same_size_audio_change_is_still_offered_and_apply_refuses_it(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    kit = _kit(kits, "Show Kit", (intro, "start", None))
    (segments.path(intro, 1) / "clip-01.flac").write_bytes(b"fLaC-ONE")
    report = _offer(make_project(None))
    assert report["reason"] == "offer" and report["unusable"] == []
    with pytest.raises(CodedValueError) as err:
        resolve_kit(kit, segments)
    assert err.value.code == "segment_hash_mismatch"


def test_a_pinned_version_that_is_missing_is_unusable(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    _kit(kits, "Show Kit", (intro, "start", 5))
    assert (
        _offer(make_project(None))["unusable"][0]["problem"]
        == f"The segment {intro} has no version 5."
    )


@pytest.mark.parametrize("name", ["resolve_version", "read_version"])
def test_an_oserror_makes_that_kit_unusable_with_its_message(
    name: str,
    make_project: Callable[..., Path],
    segments: SegmentStore,
    kits: KitStore,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    kit = _kit(kits, "Show Kit", (intro, "start", None))
    path = make_project(None)

    def boom(*args: object, **kwargs: object) -> int:
        raise OSError("disk went away")

    monkeypatch.setattr(SegmentStore, name, boom)
    report = _offer(path)
    assert report["reason"] == "no_usable_kits"
    assert report["unusable"] == [
        {"id": kit.id, "name": "Show Kit", "version": 1, "missing": 1, "problem": "disk went away"}
    ]
    failing, versions = failing_entries(kit, segments)
    assert [m.position for m in failing] == [1] and versions == []


def test_an_oserror_on_the_file_stat_makes_that_entry_fail(
    make_project: Callable[..., Path],
    segments: SegmentStore,
    kits: KitStore,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    kit = _kit(kits, "Show Kit", (intro, "start", None))
    path = make_project(None)
    real_stat = Path.stat

    def stat(self: Path, *args: object, **kwargs: object) -> object:
        if self.name == "clip-01.flac":
            raise OSError("stat failed")
        return real_stat(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "stat", stat)
    [row] = _offer(path)["unusable"]
    assert (row["id"], row["missing"], row["problem"]) == (kit.id, 1, "stat failed")


def test_an_oserror_kit_beside_a_usable_kit_is_one_report(
    make_project: Callable[..., Path],
    segments: SegmentStore,
    kits: KitStore,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    good = _put(segments, tmp_path, "Warm Intro")
    flaky = _put(segments, tmp_path, "Sign Off", b"fLaC-out")
    ok_kit = _kit(kits, "Good Kit", (good, "start", None))
    bad_kit = _kit(kits, "Flaky Kit", (good, "start", None), (flaky, "end", None))
    path = make_project(None)
    real = SegmentStore.resolve_version

    def resolve(self: SegmentStore, segment_id: str, version: int | None) -> int:
        if segment_id == flaky:
            raise OSError("disk went away")
        return real(self, segment_id, version)

    monkeypatch.setattr(SegmentStore, "resolve_version", resolve)
    report = _offer(path)
    assert report["reason"] == "offer"
    assert [k["id"] for k in report["kits"]] == [ok_kit.id]
    assert [(u["id"], u["missing"], u["problem"]) for u in report["unusable"]] == [
        (bad_kit.id, 1, "disk went away")
    ]


def test_a_kit_with_no_entries_has_nothing_failing(segments: SegmentStore) -> None:
    kit = KitFile.model_construct(id="empty-kit", name="Empty", entries=[])
    assert failing_entries(kit, segments) == ([], [])


def test_the_cheap_path_reads_no_audio(
    make_project: Callable[..., Path],
    segments: SegmentStore,
    kits: KitStore,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    _kit(kits, "Show Kit", (intro, "start", None))
    path = make_project(None)

    def no_hash(*args: object, **kwargs: object) -> str:
        raise AssertionError("audio was hashed")

    monkeypatch.setattr(store_module, "sha256_file", no_hash)
    assert _offer(path)["reason"] == "offer"


def test_the_offer_writes_nothing(
    make_project: Callable[..., Path],
    segments: SegmentStore,
    kits: KitStore,
    tmp_path: Path,
    _config_dir: Path,
) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    _kit(kits, "Show Kit", (intro, "start", None))
    _kit(kits, "Bad Kit", ("gone-00000000", "start", None))
    path = make_project(None)
    before = (_tree(path.parent), _tree(_config_dir))
    assert _offer(path)["reason"] == "offer"
    assert runner.invoke(app, ["kit", "offer", str(path)]).exit_code == 0
    assert (_tree(path.parent), _tree(_config_dir)) == before


def _seed(segments: SegmentStore, kits: KitStore, tmp_path: Path) -> None:
    intro = _put(segments, tmp_path, "Warm Intro")
    _kit(kits, "Show Kit", (intro, "start", None))
    _kit(kits, "Bad Kit", ("gone-00000000", "end", None))


def test_the_cli_mcp_and_http_return_the_same_json(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    _seed(segments, kits, tmp_path)
    path = make_project(None)
    expected = _offer(path)
    assert expected["reason"] == "offer" and expected["unusable"]
    cli = json.loads(runner.invoke(app, ["kit", "offer", str(path), "--json"]).stdout)
    mcp = json.loads(tools.kit_offer_tool(str(path)))
    http = TestClient(create_app(), client=("127.0.0.1", 50000)).get(
        "/api/kits/offer", params={"path": str(path)}
    )
    assert http.status_code == 200, http.text
    assert cli == mcp == http.json() == expected


def test_the_cli_text_report(
    make_project: Callable[..., Path], segments: SegmentStore, kits: KitStore, tmp_path: Path
) -> None:
    empty = runner.invoke(app, ["kit", "offer", str(make_project())])
    assert empty.exit_code == 0
    assert empty.stdout.strip() == "Offer: no (no_clips)"
    _seed(segments, kits, tmp_path)
    result = runner.invoke(app, ["kit", "offer", str(make_project(None))])
    assert result.exit_code == 0
    assert result.stdout.startswith("Offer: yes (offer)")
    assert "Show Kit" in result.stdout and "UNUSABLE  1 segment " in result.stdout


def test_a_path_that_is_not_a_project_is_project_not_found(tmp_path: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    res = client.get("/api/kits/offer", params={"path": str(tmp_path / "nope.sharecut")})
    assert res.status_code == 404
    assert res.headers["X-Sharecut-Error-Code"] == "project_not_found"


@pytest.mark.parametrize(
    ("foreign_served", "headers"),
    [(True, {}), (False, {"Origin": "https://evil.example"})],
    ids=["foreign-project-path", "foreign-origin"],
)
def test_a_refused_request_gets_403(
    make_project: Callable[..., Path],
    tmp_path: Path,
    foreign_served: bool,
    headers: dict[str, str],
) -> None:
    path = make_project(None)
    served = create_app()
    if foreign_served:
        served.state.served_project = tmp_path / "other.sharecut"
    client = TestClient(served, client=("127.0.0.1", 50000))
    res = client.get("/api/kits/offer", params={"path": str(path)}, headers=headers)
    assert res.status_code == 403


def test_a_relayed_non_host_peer_is_refused(make_project: Callable[..., Path]) -> None:
    path = make_project(None)
    relayed = TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )
    res = relayed.get("/api/kits/offer", params={"path": str(path)})
    assert res.status_code == 403


def test_a_project_that_parses_but_is_invalid_is_project_unreadable_everywhere(
    tmp_workspace: Path,
) -> None:
    path = tmp_workspace / "episode.sharecut"
    path.write_text('{"version": "2.4"}', encoding="utf-8")
    with pytest.raises(ProjectUnreadableError):
        _offer(path)
    cli = runner.invoke(app, ["kit", "offer", str(path)])
    assert cli.exit_code == 1
    assert "project_unreadable" in cli.output
    http = TestClient(create_app(), client=("127.0.0.1", 50000)).get(
        "/api/kits/offer", params={"path": str(path)}
    )
    assert http.headers["X-Sharecut-Error-Code"] == "project_unreadable"
    with pytest.raises(ProjectUnreadableError):
        tools.kit_offer_tool(str(path))
