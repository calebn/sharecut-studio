"""Real peaks on Home's Recent cards, folded from waveform pyramids already on disk."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.engines import waveform_media, waveform_pyramid
from podcast_mcp.engines.waveform_pyramid import write_synthetic_pyramid
from podcast_mcp.models import load_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import recent_peaks
from podcast_mcp.services.app import recent_projects as recent
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.collaboration import review_peaks
from podcast_mcp.util import peak_bins

RATE = 8000
SECONDS = 100


def _make(tmp_path: Path, name: str = "ep") -> Path:
    with write_grant(WriteGrantKind.DISPATCHER):
        return ProjectWorkspace.create(tmp_path / name, name=name).path


def _edit(path: Path, edit) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    edit(data)
    path.write_text(json.dumps(data), encoding="utf-8")


def _clip(cid="c1", track="t", start=0.0, end=float(SECONDS), at=0.0, **extra) -> dict:
    return {
        "id": cid,
        "track_id": track,
        "source_start": start,
        "source_end": end,
        "timeline_start": at,
        **extra,
    }


def _layout(project: Path, clips: list[dict], *, duration=float(SECONDS), sources=()) -> None:
    media = project.parent / "raw"
    media.mkdir(exist_ok=True)
    (media / "t.wav").write_bytes(b"not decoded")
    for sid in sources:
        (media / f"{sid}.wav").write_bytes(b"not decoded")

    def edit(data: dict) -> None:
        data["timeline"]["tracks"] = [{"id": "t", "label": "t", "media": {"path": "raw/t.wav"}}]
        data["timeline"]["clips"] = clips
        data["timeline"]["duration_sec"] = duration
        data["sources"] = [{"id": sid, "path": f"raw/{sid}.wav"} for sid in sources]

    _edit(project, edit)


def _pyramid(project: Path, ref: str, *, seed=1, seconds=SECONDS, silent=False) -> Path:
    loaded = load_project(project)
    entry = waveform_media.resolve_media_refs(loaded, [ref]).refs[ref]
    target = waveform_media.pyramid_target(loaded.artifacts_dir(), ref, entry)
    target.out.parent.mkdir(parents=True, exist_ok=True)
    return write_synthetic_pyramid(
        target.out, sample_rate=RATE, total_frames=RATE * seconds, seed=seed, silent=silent
    )


def _peaks(project: Path) -> list[float]:
    recent.record_recent(project)
    return recent.recent_project_cards()[0]["peaks"]


def test_ready_pyramid_gives_a_normalized_column_list(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    peaks = _peaks(project)
    assert len(peaks) == recent_peaks.COLUMNS
    assert max(peaks) == 1.0
    assert all(0.0 <= v <= 1.0 for v in peaks)
    assert len(set(peaks)) > 5


def test_a_clip_covering_half_the_timeline_leaves_the_rest_flat(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(end=50.0)])
    _pyramid(project, "track:t")
    peaks = _peaks(project)
    half = recent_peaks.COLUMNS // 2
    assert max(peaks[:half]) > 0.0
    assert peaks[half + 1 :] == [0.0] * (recent_peaks.COLUMNS - half - 1)


def test_a_clip_shifted_on_the_timeline_lands_in_later_columns(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(end=50.0, at=50.0)])
    _pyramid(project, "track:t")
    peaks = _peaks(project)
    half = recent_peaks.COLUMNS // 2
    assert peaks[: half - 1] == [0.0] * (half - 1)
    assert max(peaks[half:]) > 0.0


def test_a_clip_past_the_media_end_clamps_instead_of_going_flat(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(end=float(SECONDS))])
    _pyramid(project, "track:t", seconds=40)
    peaks = _peaks(project)
    assert len(peaks) == recent_peaks.COLUMNS
    assert max(peaks) > 0.0
    assert peaks[-1] == 0.0


def test_a_timed_clip_still_folds(tmp_path):
    project = _make(tmp_path)
    timing = {"steps": [{"at": 50.0, "delta_sec": 2.0}]}
    _layout(project, [_clip(timing=timing)], duration=float(SECONDS + 2))
    _pyramid(project, "track:t")
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def test_two_tracks_fill_their_own_stretches_of_the_timeline(tmp_path):
    project = _make(tmp_path)

    def edit(data: dict) -> None:
        data["timeline"]["tracks"] = [
            {"id": "t", "label": "t", "media": {"path": "raw/t.wav"}},
            {"id": "u", "label": "u", "media": {"path": "raw/u.wav"}},
        ]
        data["timeline"]["clips"] = [_clip(end=50.0), _clip("c2", "u", end=50.0, at=50.0)]
        data["timeline"]["duration_sec"] = float(SECONDS)

    (project.parent / "raw").mkdir(exist_ok=True)
    for name in ("t", "u"):
        (project.parent / "raw" / f"{name}.wav").write_bytes(b"x")
    _edit(project, edit)
    _pyramid(project, "track:t", seed=1)
    _pyramid(project, "track:u", seed=2)
    both = _peaks(project)
    half = recent_peaks.COLUMNS // 2
    assert max(both[: half - 1]) > 0.0
    assert max(both[half + 1 :]) > 0.0


def test_a_source_clip_reads_the_source_pyramid_not_the_track_one(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(source_id="s1")], sources=("s1",))
    _pyramid(project, "track:t")
    assert _peaks(project) == []
    _pyramid(project, "source:s1")
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def test_a_track_with_no_media_but_a_source_clip_draws(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(source_id="s1")], sources=("s1",))
    _edit(project, lambda d: d["timeline"]["tracks"][0].pop("media"))
    _pyramid(project, "source:s1")
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def test_an_unused_track_without_a_pyramid_does_not_flatten_the_card(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    (project.parent / "raw" / "idle.wav").write_bytes(b"x")
    _edit(
        project,
        lambda d: d["timeline"]["tracks"].append(
            {"id": "idle", "label": "idle", "media": {"path": "raw/idle.wav"}}
        ),
    )
    _pyramid(project, "track:t")
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def _no_pyramid(project: Path) -> None:
    return None


def _corrupt(project: Path) -> None:
    path = _pyramid(project, "track:t")
    path.write_bytes(b"WFPK" + b"\0" * 10)


def _silent(project: Path) -> None:
    _pyramid(project, "track:t", silent=True)


def _zero_frames(project: Path) -> None:
    _pyramid(project, "track:t", seconds=0)


@pytest.mark.parametrize(
    ("clips", "duration", "prepare"),
    [
        pytest.param([_clip()], float(SECONDS), _no_pyramid, id="missing-pyramid"),
        pytest.param([_clip()], 0.0, lambda p: _pyramid(p, "track:t"), id="zero-duration"),
        pytest.param([_clip()], None, lambda p: _pyramid(p, "track:t"), id="no-duration"),
        pytest.param([], float(SECONDS), lambda p: _pyramid(p, "track:t"), id="no-clips"),
        pytest.param([_clip()], float(SECONDS), _corrupt, id="corrupt-pyramid"),
        pytest.param([_clip()], float(SECONDS), _silent, id="silent-pyramid"),
        pytest.param([_clip()], float(SECONDS), _zero_frames, id="empty-pyramid"),
        pytest.param(
            [_clip(source_id="gone")], float(SECONDS), lambda p: _pyramid(p, "track:t"), id="source"
        ),
        pytest.param(
            [_clip(track="nope")], float(SECONDS), lambda p: _pyramid(p, "track:t"), id="track"
        ),
        pytest.param(
            [_clip(end=0.0)], float(SECONDS), lambda p: _pyramid(p, "track:t"), id="zero-width"
        ),
    ],
)
def test_flat_fallbacks_give_an_empty_list(tmp_path, clips, duration, prepare):
    project = _make(tmp_path)
    _layout(project, clips, duration=duration)
    prepare(project)
    peaks = _peaks(project)
    assert peaks == []
    assert recent.recent_project_cards()[0]["chip"]["text"] != "Needs attention"


def test_non_finite_clip_times_give_an_empty_list(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    text = project.read_text(encoding="utf-8").replace('"source_end": 100.0', '"source_end": NaN')
    project.write_text(text, encoding="utf-8")
    recent.record_recent(project)
    card = recent.recent_project_cards()[0]
    assert card["peaks"] == []
    assert card["chip"]["text"] != "Needs attention"


def test_a_pyramid_that_appears_later_refreshes_the_cached_card(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    assert _peaks(project) == []
    _pyramid(project, "track:t")
    assert len(recent.recent_project_cards()[0]["peaks"]) == recent_peaks.COLUMNS


def test_a_rebuilt_pyramid_replaces_the_cached_peaks(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t", seed=1)
    first = _peaks(project)
    _pyramid(project, "track:t", seed=9)
    assert recent.recent_project_cards()[0]["peaks"] != first


def test_replaced_media_stops_using_the_old_pyramid(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    assert _peaks(project)
    media = project.parent / "raw" / "t.wav"
    media.write_bytes(b"different media bytes")
    assert recent.recent_project_cards()[0]["peaks"] == []


def test_an_edit_to_the_project_replans_the_fold(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    full = _peaks(project)
    _edit(project, lambda d: d["timeline"]["clips"][0].update(source_end=50.0))
    assert recent.recent_project_cards()[0]["peaks"] != full


def test_the_request_path_never_decodes_or_builds(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")

    def refuse(*args, **kwargs):
        raise AssertionError("the recent list must not decode or build")

    for module in (waveform_pyramid, waveform_media):
        for name in ("build_pyramid", "schedule_pyramid_build"):
            if hasattr(module, name):
                monkeypatch.setattr(module, name, refuse)
    for name in ("build_pyramid", "schedule_pyramid_build", "decode_integer_pcm"):
        if hasattr(recent_peaks, name):
            monkeypatch.setattr(recent_peaks, name, refuse)
    monkeypatch.setattr(waveform_media, "schedule_media_ref", refuse)
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def test_an_unchanged_project_is_planned_once(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    calls = []
    real = recent_peaks.load_project
    monkeypatch.setattr(recent_peaks, "load_project", lambda p: calls.append(p) or real(p))
    _peaks(project)
    recent.recent_project_cards()
    assert len(calls) == 1


def test_a_peaks_fault_leaves_the_rest_of_the_card(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    monkeypatch.setattr(recent_peaks, "read_meta", lambda p: (_ for _ in ()).throw(RuntimeError))
    recent.record_recent(project)
    card = recent.recent_project_cards()[0]
    assert card["peaks"] == []
    assert card["chip"]["text"] == "Edited"
    assert card["duration_sec"] == float(SECONDS)


def test_a_forgotten_project_drops_its_cached_peaks(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    _peaks(project)
    assert recent._PEAKS
    recent.forget_recent(project)
    recent.recent_project_cards()
    assert not recent._PEAKS


def test_bin_peaks_lives_in_util_and_review_peaks_reexports_it():
    assert review_peaks.bin_peaks is peak_bins.bin_peaks
