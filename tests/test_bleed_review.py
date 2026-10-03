from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, Transcript, TranscriptWord
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService


def stereo_project(tmp_path: Path) -> ProjectWorkspace:
    project = EpisodeProject.create("review", str(tmp_path))
    project.ensure_dirs()
    rng = np.random.default_rng(945)
    peer = rng.normal(0, 0.08, (144_000, 2))
    owner = 0.12 * peer + 0.025 * np.roll(peer, 768, axis=0)
    owner[:19_200] += rng.normal(0, 0.04, (19_200, 2))
    owner[96_000:115_200] += rng.normal(0, 0.002, (19_200, 2))
    owner[81_600:81_648] += 0.2
    for tid, samples in (("host", owner), ("guest", peer)):
        path = tmp_path / "raw" / f"{tid}.wav"
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(2)
            audio.setsampwidth(2)
            audio.setframerate(48_000)
            audio.writeframes(np.rint(samples * 32768).astype("<i2").tobytes())
        project.tracks.append(
            Track(id=tid, label=tid, media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=3))
        )
        project.clips.append(
            Clip(id=tid, track_id=tid, source_start=0, source_end=3, timeline_start=0)
        )
    project.timeline.duration_sec = 3
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="owner", start=0, end=0.4),
                TranscriptWord(
                    text="foreign",
                    start=0.5,
                    end=0.9,
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
                TranscriptWord(text="retained", start=0.9, end=1.1),
                TranscriptWord(
                    text="possible mixture",
                    start=2,
                    end=2.4,
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
            ],
        ),
        Transcript(track_id="guest", words=[TranscriptWord(text="foreign", start=0.5, end=2.4)]),
    ]
    ws = ProjectWorkspace(tmp_path / "episode.project.json", project)
    ws.save()
    return ws


def test_stereo_refusal_offers_exact_review_without_stem(tmp_path: Path) -> None:
    ws = stereo_project(tmp_path)
    result = EditService(ws).apply_bleed_mute(
        track_id="host", apply=False, align_retained_bleed=False
    )
    assert result["applied_count"] == 0
    assert result["review_candidate_count"] == 2
    row = result["review_candidates"][0]
    assert row["requires_review"] is True
    assert row["peer_track_id"] == "guest"
    assert row["timeline_start"] == 0.5
    assert row["timeline_end"] == 0.9
    target = ExactRangeTarget.model_validate(row["target"])
    assert [(i.start, i.end) for i in target.intervals] == [(0.5, 0.9)]
    assert target.track_ids == ["host"]
    assert "missing_stem" in row["automatic_refusal_reasons"]
    assert result["review_truncated"] is False
    assert not ws.project.edit_decisions
    assert not ws.project.clips[0].mute_regions


def review(ws: ProjectWorkspace, start: float = 0, end: float = 3) -> dict:
    return EditService(ws).apply_bleed_mute(
        track_id="host", start_sec=start, end_sec=end, apply=False, align_retained_bleed=False
    )


def read_pcm(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as audio:
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").reshape(-1, 2)


def render(ws: ProjectWorkspace, path: Path, start: float = 0, end: float = 3) -> np.ndarray:
    from podcast_mcp.engines.timeline_render import render_track_segment

    render_track_segment(ws.project, "host", start, end, path, {})
    return read_pcm(path)


def host_approve(path: Path, command_id: str):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    return TestClient(create_app()).post(
        "/api/document/command",
        params={"path": str(path)},
        json={
            "type": "ApproveEdits",
            "payload": {"ids": [command_id]},
            "client_id": "reviewing-host",
            "role": "viewer",
            "client_seq": 1,
        },
    )


@pytest.mark.asyncio
async def test_registered_proposal_pending_repeat_host_approve_and_undo(tmp_path: Path) -> None:
    from mcp.client import Client

    from podcast_mcp.mcp import server
    from podcast_mcp.mcp.tools.edits import approve_edits_tool
    from podcast_mcp.services.document import HistoryService

    ws = stereo_project(tmp_path)
    target = review(ws)["review_candidates"][0]["target"]
    before = render(ws, tmp_path / "before.wav")
    words = ws.project.transcripts[0].model_dump()
    async with Client(server.mcp) as client:
        for _ in range(2):
            result = await client.call_tool(
                "propose_range_mute_tool",
                {
                    "project_path": str(ws.path),
                    "target": target,
                    "command_id": "review-945",
                },
            )
            assert not result.is_error
    pending = ProjectWorkspace.open(ws.path)
    assert len(pending.project.edit_decisions) == 1
    assert not pending.project.clips[0].mute_regions
    np.testing.assert_array_equal(render(pending, tmp_path / "pending.wav"), before)
    with pytest.raises(PermissionError, match="host"):
        approve_edits_tool(str(ws.path), json.dumps(["review-945"]))
    response = host_approve(ws.path, "review-945")
    assert response.status_code == 200, response.text
    applied = ProjectWorkspace.open(ws.path)
    after = render(applied, tmp_path / "after.wav")
    assert applied.project.transcripts[0].model_dump() == words
    np.testing.assert_array_equal(after[:24000], before[:24000])
    np.testing.assert_array_equal(after[43200:], before[43200:])
    assert not np.any(after[24240:42960])
    assert np.any(before[24240:42960])
    np.testing.assert_array_equal(after[81600:81648], before[81600:81648])
    HistoryService(applied).undo()
    np.testing.assert_array_equal(
        render(ProjectWorkspace.open(ws.path), tmp_path / "undo.wav"), before
    )


@pytest.mark.parametrize(
    "protection", ["retained", "locked", "ignored", "deferred", "audible", "unset"]
)
def test_protected_footprints_are_subtracted(tmp_path: Path, protection: str) -> None:
    ws = stereo_project(tmp_path)
    word = TranscriptWord(text="protected", start=0.6, end=0.7, suppressed=True)
    if protection == "retained":
        word.suppressed = False
    elif protection == "locked":
        word.audibility_status = "bleed"
        word.dominant_track = "guest"
        word.audibility_locked = True
    elif protection == "ignored":
        word.ignored = True
    elif protection != "unset":
        word.audibility_status = protection
    ws.project.transcripts[0].words.append(word)
    rows = review(ws, 0.5, 0.9)["review_candidates"]
    assert [(r["timeline_start"], r["timeline_end"]) for r in rows] == [(0.5, 0.6), (0.7, 0.9)]


def test_contradictory_peers_and_missing_media_refuse_targets(tmp_path: Path) -> None:
    ws = stereo_project(tmp_path)
    ws.project.tracks.append(Track(id="third", label="third", media=ws.project.tracks[1].media))
    ws.project.clips.append(
        Clip(id="third", track_id="third", source_start=0, source_end=3, timeline_start=0)
    )
    ws.project.transcripts[0].words.append(
        TranscriptWord(
            text="contradiction",
            start=0.6,
            end=0.7,
            suppressed=True,
            audibility_status="bleed",
            dominant_track="third",
        )
    )
    result = review(ws, 0.5, 0.9)
    assert [(r["timeline_start"], r["timeline_end"]) for r in result["review_candidates"]] == [
        (0.5, 0.6),
        (0.7, 0.9),
    ]
    assert "contradictory_foreign_peers" in {r["reason"] for r in result["review_exclusions"]}
    (tmp_path / "raw" / "guest.wav").unlink()
    assert not review(ws)["review_candidates"]


def test_overlap_is_excluded_and_repeat_occurrences_stay_separate(tmp_path: Path) -> None:
    ws = stereo_project(tmp_path)
    ws.project.clips.append(
        Clip(id="repeat", track_id="host", source_start=0.5, source_end=0.9, timeline_start=1.2)
    )
    result = review(ws)
    assert not any(
        r["timeline_start"] <= 1.2 < r["timeline_end"] for r in result["review_candidates"]
    )
    ws.project.clips[0].source_end = 1.1
    result = review(ws)
    assert [(r["timeline_start"], r["timeline_end"]) for r in result["review_candidates"]] == [
        (0.5, 0.9),
        (1.2, 1.6),
    ]


def test_preview_count_and_diagnostics_are_bounded(tmp_path: Path) -> None:
    ws = stereo_project(tmp_path)
    ws.project.transcripts[0].words = [
        TranscriptWord(
            text="foreign",
            start=i / 100,
            end=(i + 0.4) / 100,
            suppressed=True,
            audibility_status="bleed",
            dominant_track="guest",
        )
        for i in range(200)
    ] + [
        TranscriptWord(text="protected", start=2 + i / 1000, end=2 + (i + 0.2) / 1000)
        for i in range(200)
    ]
    result = review(ws)
    assert result["review_candidate_count"] == 16
    assert result["review_truncated"]
    assert len(result["review_exclusions"]) == 128
    assert result["review_exclusions_truncated"]
    assert all("preserved_exclusions" not in row for row in result["review_candidates"])
    assert not review(ws, 0, 0.2)["review_exclusions"]


@pytest.mark.parametrize("change", ["geometry", "media"])
def test_public_host_approval_rejects_stale_target(tmp_path: Path, change: str) -> None:
    from podcast_mcp.mcp.tools.edits import propose_range_mute_tool

    ws = stereo_project(tmp_path)
    target = review(ws)["review_candidates"][0]["target"]
    propose_range_mute_tool(str(ws.path), target, "stale-review")
    if change == "geometry":
        current = ProjectWorkspace.open(ws.path)
        current.project.clips[0].timeline_start = 0.1
        current.save()
    else:
        with (tmp_path / "raw" / "host.wav").open("ab") as audio:
            audio.write(b"changed")
    response = host_approve(ws.path, "stale-review")
    assert response.status_code == 409, response.text
    assert not ProjectWorkspace.open(ws.path).project.clips[0].mute_regions


def test_segment_start_inside_mute_preserves_original_envelope(tmp_path: Path) -> None:
    from podcast_mcp.models import ClipMuteRegion

    ws = stereo_project(tmp_path)
    ws.project.clips[0].mute_regions = [ClipMuteRegion(start_s=0.5, end_s=0.9)]
    full = render(ws, tmp_path / "full.wav")
    for index, start in enumerate((0.501, 0.50225, 0.7, 0.898)):
        segment = render(ws, tmp_path / f"segment-{index}.wav", start, 1.1)
        expected = full[round(start * 48000) : 52800]
        np.testing.assert_array_equal(segment, expected)


def test_nonzero_source_offset_and_segment_ends_inside_envelope(tmp_path: Path) -> None:
    from podcast_mcp.models import ClipMuteRegion

    ws = stereo_project(tmp_path)
    ws.project.clips[0].source_start = 0.2
    ws.project.clips[0].mute_regions = [ClipMuteRegion(start_s=0.5, end_s=0.9)]
    full = render(ws, tmp_path / "offset-full.wav", 0, 2.8)
    for index, (start, end) in enumerate(
        ((0.301, 0.303), (0.5, 0.698), (0.698, 0.699), (0.30302, 0.6))
    ):
        segment = render(ws, tmp_path / f"offset-{index}.wav", start, end)
        expected = full[round(start * 48000) : round(end * 48000)]
        np.testing.assert_array_equal(segment, expected)


def test_zero_length_locked_word_protects_boundary(tmp_path: Path) -> None:
    ws = stereo_project(tmp_path)
    ws.project.transcripts[0].words.append(
        TranscriptWord(
            text="boundary",
            start=0.6,
            end=0.6,
            suppressed=True,
            audibility_locked=True,
        )
    )
    rows = review(ws, 0.5, 0.9)["review_candidates"]
    assert len(rows) == 2
    assert rows[0]["timeline_end"] <= 0.6
    assert rows[1]["timeline_start"] >= 0.601


@pytest.mark.parametrize("sample_rate", [44100, 48000])
def test_short_mute_changes_only_half_open_interval(tmp_path: Path, sample_rate: int) -> None:
    from podcast_mcp.models import ClipMuteRegion

    ws = stereo_project(tmp_path)
    if sample_rate != 48000:
        path = tmp_path / "raw" / "host.wav"
        samples = read_pcm(path)[: 3 * sample_rate]
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(2)
            audio.setsampwidth(2)
            audio.setframerate(sample_rate)
            audio.writeframes(samples.tobytes())
    before = render(ws, tmp_path / "short-before.wav")
    ws.project.clips[0].mute_regions = [ClipMuteRegion(start_s=0.5, end_s=0.505)]
    after = render(ws, tmp_path / "short-after.wav")
    first = int(np.floor(0.5 * sample_rate + 0.5))
    last = int(np.floor(0.505 * sample_rate + 0.5))
    np.testing.assert_array_equal(after[:first], before[:first])
    np.testing.assert_array_equal(after[last:], before[last:])
    assert not np.any(after[first:last])


def test_merged_envelopes_match_direct_stereo_pcm_truth(tmp_path: Path) -> None:
    from podcast_mcp.models import ClipMuteRegion

    ws = stereo_project(tmp_path)
    before = render(ws, tmp_path / "truth-before.wav")
    ws.project.clips[0].mute_regions = [
        ClipMuteRegion(start_s=0.5, end_s=0.7),
        ClipMuteRegion(start_s=0.6, end_s=0.9),
        ClipMuteRegion(start_s=1.2, end_s=1.4),
    ]
    after = render(ws, tmp_path / "truth-after.wav")
    gain = np.ones(len(before))
    for a, b in ((24000, 43200), (57600, 67200)):
        gain[a : a + 240] = np.arange(240, 0, -1) / 240
        gain[a + 240 : b - 240] = 0
        gain[b - 240 : b] = np.arange(240) / 240
    truth = np.rint(before * gain[:, None]).astype(np.int16)
    assert np.max(np.abs(after.astype(np.int32) - truth)) <= 1
    np.testing.assert_array_equal(after[gain == 1], before[gain == 1])
    assert not np.any(after[gain == 0])


@pytest.mark.parametrize(
    "start, first, count", [(14544.5 / 48000, 14544, 14255), (14545.5 / 48000, 14545, 14254)]
)
def test_half_sample_source_seek_clock_is_separate_from_envelope(
    tmp_path: Path, start: float, first: int, count: int
) -> None:
    from podcast_mcp.models import ClipMuteRegion

    ws = stereo_project(tmp_path)
    ws.project.clips[0].source_start = 0.2
    ws.project.clips[0].mute_regions = [ClipMuteRegion(start_s=0.5, end_s=0.9)]
    full = render(ws, tmp_path / "half-full.wav", 0, 2.8)
    segment = render(ws, tmp_path / "half-segment.wav", start, 0.6)
    assert len(segment) == count
    np.testing.assert_array_equal(segment, full[first : first + count])


@pytest.mark.parametrize("layout", ["overlap", "crossfade"])
def test_unavailable_named_peer_raw_mapping_refuses_review(tmp_path: Path, layout: str) -> None:
    ws = stereo_project(tmp_path)
    if layout == "overlap":
        ws.project.clips.append(
            Clip(
                id="peer-overlap",
                track_id="guest",
                source_start=0.5,
                source_end=0.9,
                timeline_start=0.5,
            )
        )
    else:
        ws.project.clips[1].join_in_mode = "crossfade"
        ws.project.clips[1].fade_in_ms = 10
    result = review(ws, 0.5, 0.9)
    assert not result["review_candidates"]
    assert "unavailable_peer_review_media" in {row["reason"] for row in result["review_reasons"]}


@pytest.mark.parametrize("seek_start, count", [(0.1000007, 4656), (0.10001048, 4655)])
def test_shared_source_seek_and_trim_envelope_uses_actual_ramp_origin(
    tmp_path: Path, seek_start: float, count: int
) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine, PlacedSegment

    raw = tmp_path / "ramp.wav"
    ramp = np.column_stack((np.arange(48000) % 30000, -(np.arange(48000) % 30000))).astype("<i2")
    with wave.open(str(raw), "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(48000)
        audio.writeframes(ramp.tobytes())
    source_start = 0.5030112 if seek_start == 0.1000007 else 0.50302048
    placed = [
        PlacedSegment(src_start=seek_start, src_end=seek_start + 0.001, source_path=raw),
        PlacedSegment(src_start=source_start, src_end=0.6, source_path=raw),
    ]
    before = tmp_path / "ramp-before.wav"
    FFmpegEngine().render_timeline(raw, before, placed, "anull")
    plain = read_pcm(before)
    assert plain[48, 0] == 24144
    placed[1].mute_spans = ((0.5 - source_start, 0.6 - source_start),)
    after = tmp_path / "ramp-after.wav"
    FFmpegEngine().render_timeline(raw, after, placed, "anull")
    muted = read_pcm(after)
    assert len(muted) == len(plain) == count + 48
    np.testing.assert_array_equal(muted[:48], plain[:48])
    source_frames = np.arange(count) + 24144
    gain = np.where(
        source_frames < 24240,
        (24240 - source_frames) / 240,
        np.where(source_frames >= 28560, (source_frames - 28560) / 240, 0),
    )
    truth = np.rint(plain[48:] * gain[:, None]).astype(np.int16)
    assert np.max(np.abs(muted[48:].astype(np.int32) - truth)) <= 1


def test_selected_recording_controls_coverage_and_protection(tmp_path: Path) -> None:
    from podcast_mcp.models import SourceRecording

    ws = stereo_project(tmp_path)
    (tmp_path / "raw" / "alternate.wav").write_bytes((tmp_path / "raw" / "host.wav").read_bytes())
    ws.project.sources.append(
        SourceRecording(id="alternate", path="raw/alternate.wav", duration_sec=3)
    )
    ws.project.clips[0].source_id = "alternate"
    assert not review(ws, 0.5, 0.9)["review_candidates"]
    ws.project.transcripts[0].words.append(
        TranscriptWord(text="unselected owner", start=0.5, end=0.9)
    )
    ws.project.transcripts.append(
        Transcript(
            track_id="host",
            source_id="alternate",
            words=[
                TranscriptWord(
                    text="selected foreign",
                    start=0.5,
                    end=0.9,
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
            ],
        )
    )
    result = review(ws, 0.5, 0.9)
    assert len(result["review_candidates"]) == 1
    assert result["review_candidates"][0]["source_id"] == "alternate"


@pytest.mark.parametrize("coverage", ["absent", "partial", "gap", "overlap", "missing_peer"])
def test_peer_coverage_refusal_agrees_for_broad_and_narrow_requests(
    tmp_path: Path, coverage: str
) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates

    ws = stereo_project(tmp_path)
    peer = ws.project.clips[1]
    if coverage == "missing_peer":
        ws.project.transcripts[0].words[1].dominant_track = "missing"
    elif coverage == "absent":
        peer.source_end = 0.4
    elif coverage == "partial":
        peer.source_end = 0.7
    elif coverage == "gap":
        peer.source_end = 0.65
        ws.project.clips.append(
            Clip(
                id="peer-after-gap",
                track_id="guest",
                source_start=0.7,
                source_end=3,
                timeline_start=0.7,
            )
        )
    else:
        ws.project.clips.append(
            Clip(
                id="peer-overlap",
                track_id="guest",
                source_start=0.6,
                source_end=0.8,
                timeline_start=0.6,
            )
        )
    for start, end in ((0, 3), (0.5, 0.9)):
        result = bleed_review_candidates(ws.project, "host", start, end)
        assert not any(row["timeline_start"] < 0.9 for row in result.candidates)
        assert (
            "missing_foreign_peer"
            if coverage == "missing_peer"
            else "unavailable_peer_review_media"
        ) in result.reasons


def test_peer_coverage_can_cross_adjacent_placements_and_ignores_remote_overlap(
    tmp_path: Path,
) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates

    ws = stereo_project(tmp_path)
    ws.project.clips[1].source_end = 0.7
    ws.project.clips.extend(
        [
            Clip(
                id="peer-next", track_id="guest", source_start=0.7, source_end=3, timeline_start=0.7
            ),
            Clip(
                id="peer-remote-overlap",
                track_id="guest",
                source_start=2,
                source_end=2.4,
                timeline_start=2,
            ),
        ]
    )
    for start, end in ((0, 3), (0.5, 0.9)):
        result = bleed_review_candidates(ws.project, "host", start, end)
        assert [(r["timeline_start"], r["timeline_end"]) for r in result.candidates] == [(0.5, 0.9)]


@pytest.mark.parametrize("tid", ["host", "guest"])
def test_review_uses_actual_source_duration_for_owner_and_peer(tmp_path: Path, tid: str) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates

    ws = stereo_project(tmp_path)
    path = tmp_path / "raw" / f"{tid}.wav"
    pcm = read_pcm(path)[:33_600]
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(48_000)
        audio.writeframes(pcm.tobytes())
    for start, end in ((0, 3), (0.5, 0.9)):
        result = bleed_review_candidates(ws.project, "host", start, end)
        assert not result.candidates
        assert f"unavailable_{'owner' if tid == 'host' else 'peer'}_review_media" in result.reasons
    result = bleed_review_candidates(ws.project, "host", 0.5, 0.7)
    assert [(r["source_start"], r["source_end"]) for r in result.candidates] == [(0.5, 0.7)]


def test_repeated_alternate_media_is_probed_once_per_resolved_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.models import SourceRecording

    ws = stereo_project(tmp_path)
    alternate = tmp_path / "raw" / "alternate.wav"
    alternate.write_bytes((tmp_path / "raw" / "host.wav").read_bytes())
    ws.project.sources.append(
        SourceRecording(id="alternate", path="raw/alternate.wav", duration_sec=3)
    )
    ws.project.clips[0].source_id = "alternate"
    ws.project.clips[0].source_end = 1.1
    ws.project.clips.append(
        Clip(
            id="repeat",
            track_id="host",
            source_id="alternate",
            source_start=0.5,
            source_end=0.9,
            timeline_start=1.2,
        )
    )
    ws.project.transcripts[0].source_id = "alternate"
    calls: list[Path] = []
    original = FFmpegEngine.probe

    def probe(engine: FFmpegEngine, path: Path):
        calls.append(path)
        return original(engine, path)

    monkeypatch.setattr(FFmpegEngine, "probe", probe)
    result = bleed_review_candidates(ws.project, "host", 0, 3)
    assert [(r["clip_id"], r["source_id"]) for r in result.candidates] == [
        ("host", "alternate"),
        ("repeat", "alternate"),
    ]
    assert calls == [alternate.resolve(), (tmp_path / "raw" / "guest.wav").resolve()]


@pytest.mark.parametrize("blocked", ["retained", "protected", "outside"])
def test_no_eligible_intervals_do_not_probe_media(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    blocked: str,
) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    ws = stereo_project(tmp_path)
    if blocked == "retained":
        for word in ws.project.transcripts[0].words:
            word.suppressed = False
    elif blocked == "protected":
        ws.project.transcripts[0].words.append(TranscriptWord(text="owner", start=0, end=3))
    else:
        for word in ws.project.transcripts[0].words:
            word.start += 4
            word.end += 4

    def probe(*args, **kwargs):
        pytest.fail("No eligible interval may cause a media probe")

    monkeypatch.setattr(FFmpegEngine, "probe", probe)
    assert not bleed_review_candidates(ws.project, "host", 0, 3).candidates


def test_diagnostic_truncation_retains_late_protection(tmp_path: Path) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates

    ws = stereo_project(tmp_path)
    ws.project.transcripts[0].words.extend(
        TranscriptWord(text="protected", start=1.2 + i / 1000, end=1.2002 + i / 1000)
        for i in range(129)
    )
    ws.project.transcripts[0].words.append(TranscriptWord(text="late owner", start=2.1, end=2.2))
    result = bleed_review_candidates(ws.project, "host", 0, 3)
    assert result.exclusions_truncated
    assert not any(r["start"] == 2.1 for r in result.exclusions)
    assert [(r["timeline_start"], r["timeline_end"]) for r in result.candidates] == [
        (0.5, 0.9),
        (2, 2.1),
        (2.2, 2.4),
    ]


@pytest.mark.parametrize("tid", ["host", "guest"])
def test_selected_alternate_source_bounds_use_source_clock(tmp_path: Path, tid: str) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates
    from podcast_mcp.models import SourceRecording

    ws = stereo_project(tmp_path)
    alternate = tmp_path / "raw" / "alternate.wav"
    alternate.write_bytes((tmp_path / "raw" / f"{tid}.wav").read_bytes())
    ws.project.sources.append(
        SourceRecording(id="alternate", path="raw/alternate.wav", duration_sec=10)
    )
    clip = next(c for c in ws.project.clips if c.track_id == tid)
    clip.source_id = "alternate"
    clip.source_start = 8
    clip.source_end = 8.4
    clip.timeline_start = 0.5
    if tid == "host":
        ws.project.transcripts.append(
            Transcript(
                track_id="host",
                source_id="alternate",
                words=[
                    TranscriptWord(
                        text="foreign",
                        start=8,
                        end=8.4,
                        suppressed=True,
                        audibility_status="bleed",
                        dominant_track="guest",
                    )
                ],
            )
        )
    for start, end in ((0, 3), (0.5, 0.9)):
        result = bleed_review_candidates(ws.project, "host", start, end)
        assert not result.candidates
        assert f"unavailable_{'owner' if tid == 'host' else 'peer'}_review_media" in result.reasons


@pytest.mark.parametrize("tid", ["host", "guest"])
@pytest.mark.parametrize("container", ["m4a", "mov"])
def test_review_requires_selected_audio_extent_with_other_longer_streams(
    tmp_path: Path, tid: str, container: str
) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.util.process import run

    ws = stereo_project(tmp_path)
    engine = FFmpegEngine()
    selected = tmp_path / "raw" / f"selected.{container}"
    inputs = ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.7"]
    if container == "m4a":
        inputs += [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=3",
            "-map",
            "0:a",
            "-map",
            "1:a",
        ]
    else:
        inputs += ["-f", "lavfi", "-i", "color=c=black:s=16x16:r=10:d=3", "-c:v", "mpeg4"]
    run(
        [engine.ffmpeg, "-v", "error", *inputs, "-c:a", "aac", "-y", str(selected)],
        check=True,
        timeout=30,
    )
    probe = engine.probe(selected)
    assert probe.duration_sec > 2.9
    assert probe.audio_duration_sec is not None
    assert 0.65 < probe.audio_duration_sec < 0.8
    assert probe.duration_estimated is (container == "m4a")
    track = ws.project.track_by_id(tid)
    assert track is not None
    track.media = MediaAsset(path=f"raw/selected.{container}", duration_sec=3)
    for start, end in ((0, 3), (0.5, 0.9)):
        result = bleed_review_candidates(ws.project, "host", start, end)
        assert not result.candidates
        assert f"unavailable_{'owner' if tid == 'host' else 'peer'}_review_media" in result.reasons
    interior = bleed_review_candidates(ws.project, "host", 0.5, 0.6)
    if container == "m4a":
        assert not interior.candidates
    else:
        assert [(r["timeline_start"], r["timeline_end"]) for r in interior.candidates] == [
            (0.5, 0.6)
        ]


@pytest.mark.parametrize("tid", ["host", "guest"])
@pytest.mark.parametrize("extent", ["unknown", "estimated"])
def test_review_refuses_unknown_or_estimated_selected_extent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tid: str, extent: str
) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates
    from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine

    ws = stereo_project(tmp_path)
    original = FFmpegEngine.probe

    def probe(engine: FFmpegEngine, path: Path) -> AudioProbe:
        if path.name == f"{tid}.wav":
            return AudioProbe(
                duration_sec=3,
                sample_rate=48000,
                channels=2,
                audio_duration_sec=None if extent == "unknown" else 3,
                duration_estimated=extent == "estimated",
            )
        return original(engine, path)

    monkeypatch.setattr(FFmpegEngine, "probe", probe)
    result = bleed_review_candidates(ws.project, "host", 0, 3)
    assert not result.candidates
    assert f"unavailable_{'owner' if tid == 'host' else 'peer'}_review_media" in result.reasons


def test_discovery_memoizes_failed_probe_and_next_call_retries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits.bleed_review import bleed_review_candidates
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    ws = stereo_project(tmp_path)
    original = FFmpegEngine.probe
    calls: list[Path] = []

    def probe(engine: FFmpegEngine, path: Path):
        calls.append(path)
        if len(calls) == 1:
            raise RuntimeError("unavailable media")
        return original(engine, path)

    monkeypatch.setattr(FFmpegEngine, "probe", probe)
    assert not bleed_review_candidates(ws.project, "host", 0, 3).candidates
    assert len(calls) == 1
    assert len(bleed_review_candidates(ws.project, "host", 0, 3).candidates) == 2
    assert calls == [
        (tmp_path / "raw" / "host.wav").resolve(),
        (tmp_path / "raw" / "host.wav").resolve(),
        (tmp_path / "raw" / "guest.wav").resolve(),
    ]
