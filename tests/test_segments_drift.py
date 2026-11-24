"""Which inserted segments have drifted from the library, on every surface."""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import segments as tools
from podcast_mcp.models import Clip, EpisodeProject, Track, save_project
from podcast_mcp.models.episode import MediaAsset, ProjectUnreadableError, SegmentRef
from podcast_mcp.project.io import RETIRED_PROJECT_FILENAME
from podcast_mcp.segments.model import SEGMENT_JSON, SegmentFile
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import report_segment_drift
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER
from segment_helpers import make_segment_dir

runner = CliRunner()
ZERO = "0" * 64


@pytest.fixture(autouse=True)
def _config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config = tmp_path / "config"
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(config))
    return config


@pytest.fixture
def store() -> SegmentStore:
    return SegmentStore()


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


def _put(store: SegmentStore, tmp_path: Path, audio: bytes, name: str = "Warm Intro") -> str:
    folder = make_segment_dir(tmp_path / "source", name=name, audio=audio)
    return store.add(folder).id


def _ref(store: SegmentStore, segment_id: str, version: int, **over: object) -> SegmentRef:
    sha = store.read_version(segment_id, version).content_sha256
    return SegmentRef.model_validate(
        {"segment_id": segment_id, "version": version, "content_sha256": sha, **over}
    )


def _only(path: Path, store: SegmentStore) -> dict:
    rows = report_segment_drift(path, store)
    assert len(rows) == 1
    return rows[0]


def test_a_project_without_inserted_segments_has_no_rows(
    make_project: Callable[..., Path], store: SegmentStore
) -> None:
    assert report_segment_drift(make_project(None, None), store) == []


def test_current(make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    row = _only(make_project(_ref(store, segment_id, 1)), store)
    assert row["state"] == "current"
    assert row["library_version"] == 1
    assert row["clips"] == ["c1"]
    assert "code" not in row and "problem" not in row


def test_newer(make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    ref = _ref(store, segment_id, 1)
    _put(store, tmp_path, b"fLaC-two")
    row = _only(make_project(ref), store)
    assert (row["state"], row["library_version"]) == ("newer", 2)
    assert "code" not in row


def test_missing_segment(make_project: Callable[..., Path], store: SegmentStore) -> None:
    ref = SegmentRef(segment_id="gone-00000000", version=1, content_sha256=ZERO)
    row = _only(make_project(ref), store)
    assert row["state"] == "missing"
    assert row["library_version"] is None
    assert row["code"] == "segment_unknown"
    assert row["problem"] == "There is no segment called gone-00000000."


def test_an_invalid_hand_edited_id_is_missing_and_never_read(
    make_project: Callable[..., Path], store: SegmentStore
) -> None:
    ref = SegmentRef(segment_id="../etc", version=1, content_sha256=ZERO)
    row = _only(make_project(ref), store)
    assert (row["state"], row["code"]) == ("missing", "segment_unknown")


def test_edge_a_ref_version_removed_by_hand_is_missing(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    _put(store, tmp_path, b"fLaC-two")
    ref = _ref(store, segment_id, 2)
    _put(store, tmp_path, b"fLaC-three")
    shutil.rmtree(store.path(segment_id, 2))
    row = _only(make_project(ref), store)
    assert (row["state"], row["library_version"]) == ("missing", 3)
    assert row["code"] == "segment_unknown"
    assert row["problem"] == "Version 2 is not in the library."


def test_edge_b_a_reimport_that_reuses_the_number_is_missing(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    _put(store, tmp_path, b"fLaC-two")
    _put(store, tmp_path, b"fLaC-three")
    ref = _ref(store, segment_id, 3)
    store.remove(segment_id)
    _put(store, tmp_path, b"fLaC-other")
    assert store.versions(segment_id) == [1]
    row = _only(make_project(ref), store)
    assert (row["state"], row["library_version"]) == ("missing", 1)


def test_edge_c_the_same_content_under_a_later_number_is_current(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    ref = _ref(store, segment_id, 1)
    _put(store, tmp_path, b"fLaC-two")
    shutil.rmtree(store.path(segment_id, 1))
    assert _put(store, tmp_path, b"fLaC-one") == segment_id
    assert store.versions(segment_id) == [2, 3]
    row = _only(make_project(ref), store)
    assert (row["state"], row["library_version"]) == ("current", 3)


def test_edge_d_a_damaged_newest_is_damaged_though_the_ref_is_intact(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    ref = _ref(store, segment_id, 1)
    _put(store, tmp_path, b"fLaC-two")
    (store.path(segment_id, 2) / "clip-01.flac").unlink()
    row = _only(make_project(ref), store)
    assert (row["state"], row["library_version"]) == ("damaged", 2)
    assert row["code"] == "segment_hash_mismatch"
    assert row["problem"].startswith("Version 2 (newest)")


def test_edge_e_the_ref_version_holding_other_content_is_changed(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    _put(store, tmp_path, b"fLaC-two")
    row = _only(make_project(_ref(store, segment_id, 1, content_sha256="a" * 64)), store)
    assert (row["state"], row["library_version"]) == ("changed", 2)
    assert "code" not in row


def test_the_refs_own_damaged_copy_is_damaged_while_the_newest_is_current(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    _put(store, tmp_path, b"fLaC-two")
    ref = _ref(store, segment_id, 2).model_copy(update={"version": 1})
    (store.path(segment_id, 1) / "clip-01.flac").write_bytes(b"x")
    row = _only(make_project(ref), store)
    assert row["state"] == "damaged"
    assert row["problem"].startswith("Version 1 (the one used)")


@pytest.mark.parametrize(
    ("damage", "code"),
    [
        (
            lambda folder: (folder / SEGMENT_JSON).write_text("{", encoding="utf-8"),
            "segment_invalid",
        ),
        (
            lambda folder: (folder / SEGMENT_JSON).write_text(
                json.dumps(
                    {**json.loads((folder / SEGMENT_JSON).read_text()), "schema_version": 9}
                ),
                encoding="utf-8",
            ),
            "segment_schema_unsupported",
        ),
        (lambda folder: (folder / SEGMENT_JSON).unlink(), "segment_unreadable"),
        (lambda folder: (folder / "clip-01.flac").write_bytes(b"xx"), "segment_hash_mismatch"),
    ],
)
def test_a_damaged_row_carries_the_code_the_store_raised(
    make_project: Callable[..., Path],
    store: SegmentStore,
    tmp_path: Path,
    damage: Callable[[Path], object],
    code: str,
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    ref = _ref(store, segment_id, 1)
    damage(store.path(segment_id, 1))
    row = _only(make_project(ref), store)
    assert (row["state"], row["code"]) == ("damaged", code)


def test_rows_are_one_per_ref_with_their_clips_and_sorted(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    zed = _put(store, tmp_path, b"fLaC-z", name="Zed")
    alpha = _put(store, tmp_path, b"fLaC-a", name="Alpha")
    _put(store, tmp_path, b"fLaC-a2", name="Alpha")
    ref_zed = _ref(store, zed, 1)
    ref_a1, ref_a2 = _ref(store, alpha, 1), _ref(store, alpha, 2)
    path = make_project(ref_zed, ref_a2, None, ref_a1, ref_zed)
    rows = report_segment_drift(path, store)
    assert [(r["ref"]["segment_id"], r["ref"]["version"]) for r in rows] == [
        (alpha, 1),
        (alpha, 2),
        (zed, 1),
    ]
    assert [r["clips"] for r in rows] == [["c4"], ["c2"], ["c1", "c5"]]
    assert [r["state"] for r in rows] == ["newer", "current", "current"]
    assert set(rows[0]["ref"]) == {"segment_id", "version", "content_sha256"}


class _Hooked(SegmentStore):
    """A store that runs ``on_read`` before its first ``read_version`` calls and ``on_list``
    in place of ``versions`` while ``list_failures`` remain."""

    def __init__(self) -> None:
        super().__init__()
        self.on_read: Callable[[str], None] | None = None
        self.read_failures = 0
        self.list_failures = 0
        self.list_calls = 0

    def read_version(
        self, segment_id: str, version: int, *, hash_content: bool = False
    ) -> SegmentFile:
        if self.on_read is not None and self.read_failures > 0:
            self.read_failures -= 1
            self.on_read(segment_id)
        return super().read_version(segment_id, version, hash_content=hash_content)

    def versions(self, segment_id: str) -> Sequence[int]:
        self.list_calls += 1
        if self.list_failures > 0:
            self.list_failures -= 1
            raise FileNotFoundError(segment_id)
        return super().versions(segment_id)


def test_a_segment_removed_mid_call_is_missing(
    make_project: Callable[..., Path], tmp_path: Path
) -> None:
    hooked = _Hooked()
    segment_id = _put(hooked, tmp_path, b"fLaC-one")
    project = make_project(_ref(hooked, segment_id, 1))
    hooked.on_read = lambda sid: shutil.rmtree(hooked.directory / sid)
    hooked.read_failures = 1
    row = _only(project, hooked)
    assert (row["state"], row["code"]) == ("missing", "segment_unknown")
    assert row["library_version"] is None


def test_a_version_still_listed_but_gone_on_the_last_try_is_missing_not_damaged(
    make_project: Callable[..., Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hooked = _Hooked()
    segment_id = _put(hooked, tmp_path, b"fLaC-one")
    project = make_project(_ref(hooked, segment_id, 1))
    shutil.rmtree(hooked.directory / segment_id / "v1")
    monkeypatch.setattr(hooked, "versions", lambda sid: [1])
    row = _only(project, hooked)
    assert (row["state"], row["code"]) == ("missing", "segment_unknown")


def test_a_newest_version_removed_mid_call_is_judged_against_the_new_newest(
    make_project: Callable[..., Path], tmp_path: Path
) -> None:
    hooked = _Hooked()
    segment_id = _put(hooked, tmp_path, b"fLaC-one")
    ref = _ref(hooked, segment_id, 1)
    _put(hooked, tmp_path, b"fLaC-two")
    project = make_project(ref)
    hooked.on_read = lambda sid: shutil.rmtree(hooked.directory / sid / "v2")
    hooked.read_failures = 1
    row = _only(project, hooked)
    assert (row["state"], row["library_version"]) == ("current", 1)


def test_an_oserror_listing_versions_is_checked_again(
    make_project: Callable[..., Path], tmp_path: Path
) -> None:
    hooked = _Hooked()
    segment_id = _put(hooked, tmp_path, b"fLaC-one")
    project = make_project(_ref(hooked, segment_id, 1))
    hooked.list_failures = 1
    calls_before = hooked.list_calls
    assert _only(project, hooked)["state"] == "current"
    assert hooked.list_calls - calls_before == 2


def test_a_segment_that_cannot_be_listed_three_times_is_left_out_as_scan_does(
    make_project: Callable[..., Path], tmp_path: Path
) -> None:
    hooked = _Hooked()
    segment_id = _put(hooked, tmp_path, b"fLaC-one")
    project = make_project(_ref(hooked, segment_id, 1))
    hooked.list_failures = 3
    calls_before = hooked.list_calls
    assert report_segment_drift(project, hooked) == []
    assert hooked.list_calls - calls_before == 3


def test_a_cheap_drift_call_reads_no_audio(
    make_project: Callable[..., Path],
    store: SegmentStore,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    path = make_project(_ref(store, segment_id, 1))
    audio = store.path(segment_id) / "clip-01.flac"
    reads: list[Path] = []
    real_open = Path.open

    def observe_open(self: Path, *args, **kwargs):  # type: ignore[no-untyped-def]
        if self == audio:
            reads.append(self)
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", observe_open)
    result = runner.invoke(app, ["segment", "drift", str(path), "--json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)[0]["state"] == "current"
    assert reads == []


def _tree(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_drift_writes_nothing_and_opens_without_adopting(
    make_project: Callable[..., Path],
    store: SegmentStore,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    path = make_project(_ref(store, segment_id, 1))
    retired = path.with_name(RETIRED_PROJECT_FILENAME)
    path.rename(retired)
    opened: list[bool] = []
    real_open = ProjectWorkspace.open.__func__  # type: ignore[attr-defined]

    def spy(cls: type[ProjectWorkspace], p: Path | str, *, adopt: bool = True, **kw: object):
        opened.append(adopt)
        return real_open(cls, p, adopt=adopt, **kw)

    monkeypatch.setattr(ProjectWorkspace, "open", classmethod(spy))
    before = _tree(retired.parent)
    assert _only(retired, store)["state"] == "current"
    assert opened == [False]
    assert retired.exists() and not path.exists()
    assert _tree(retired.parent) == before


def test_the_cli_mcp_and_http_return_the_same_json(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    segment_id = _put(store, tmp_path, b"fLaC-one")
    ref = _ref(store, segment_id, 1)
    _put(store, tmp_path, b"fLaC-two")
    gone = SegmentRef(segment_id="gone-00000000", version=1, content_sha256=ZERO)
    path = make_project(ref, gone)
    expected = report_segment_drift(path, store)
    assert [r["state"] for r in expected] == ["missing", "newer"]
    cli = json.loads(runner.invoke(app, ["segment", "drift", str(path), "--json"]).stdout)
    mcp = json.loads(tools.segment_drift_tool(str(path)))
    http = TestClient(create_app(), client=("127.0.0.1", 50000)).get(
        "/api/segments/drift", params={"path": str(path)}
    )
    assert http.status_code == 200, http.text
    assert cli == mcp == http.json() == expected


def test_the_cli_text_report(
    make_project: Callable[..., Path], store: SegmentStore, tmp_path: Path
) -> None:
    empty = runner.invoke(app, ["segment", "drift", str(make_project(None))])
    assert empty.exit_code == 0
    assert "No clip" in empty.stdout
    gone = SegmentRef(segment_id="gone-00000000", version=2, content_sha256=ZERO)
    result = runner.invoke(app, ["segment", "drift", str(make_project(gone))])
    assert result.exit_code == 0
    assert "gone-00000000  v2  MISSING  1 clips" in result.stdout


def test_the_drift_route_is_not_read_as_a_segment_id(tmp_path: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    res = client.get("/api/segments/drift", params={"path": str(tmp_path / "nope.sharecut")})
    assert res.status_code == 404
    assert res.headers["X-Sharecut-Error-Code"] != "segment_unknown"


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
    res = client.get("/api/segments/drift", params={"path": str(path)}, headers=headers)
    assert res.status_code == 403


def test_a_relayed_non_host_peer_is_refused(make_project: Callable[..., Path]) -> None:
    path = make_project(None)
    relayed = TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )
    res = relayed.get("/api/segments/drift", params={"path": str(path)})
    assert res.status_code in (401, 403)


@pytest.fixture
def parses_but_is_not_a_project(tmp_workspace: Path) -> Path:
    path = tmp_workspace / "episode.sharecut"
    path.write_text('{"version": "2.4"}', encoding="utf-8")
    return path


def test_a_project_that_parses_but_is_invalid_is_project_unreadable_everywhere(
    parses_but_is_not_a_project: Path,
) -> None:
    path = parses_but_is_not_a_project
    with pytest.raises(ProjectUnreadableError):
        report_segment_drift(path, SegmentStore())
    cli = runner.invoke(app, ["segment", "drift", str(path)])
    assert cli.exit_code == 1
    assert "project_unreadable" in cli.output
    http = TestClient(create_app(), client=("127.0.0.1", 50000)).get(
        "/api/segments/drift", params={"path": str(path)}
    )
    assert http.headers["X-Sharecut-Error-Code"] == "project_unreadable"
    with pytest.raises(ProjectUnreadableError):
        tools.segment_drift_tool(str(path))
