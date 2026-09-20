"""Tests for conversation-clock alignment scorer."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.edits.conversation_align import (
    AlignResult,
    ClipAlignPlan,
    acoustic_clip_offset,
    apply_alignment_plans,
    bleed_phrase_offsets,
    durations_match,
    first_utterance_end,
    late_join_offset,
    offset_to_clip_geometry,
    own_speech_tokens,
    plan_conversation_alignment,
    restore_clip_geometry,
    run_conversation_align,
    snapshot_clip_geometry,
)
from podcast_mcp.engines.transcript_align import WordToken
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProjectMeta,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _project(
    tmp_path: Path, tracks: list[tuple[str, float, list[TranscriptWord]]]
) -> EpisodeProject:
    p = EpisodeProject(
        meta=ProjectMeta(name="align-test", workspace_dir=str(tmp_path)),
    )
    for tid, dur, words in tracks:
        p.tracks.append(
            Track(
                id=tid,
                label=tid.title(),
                role=TrackRole.DIALOGUE,
                speaker=tid.title(),
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=dur),
            )
        )
        p.clips.append(
            Clip(
                id=f"clip_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=dur,
                timeline_start=0.0,
            )
        )
        p.transcripts.append(Transcript(track_id=tid, words=words))
    return p


def test_bleed_phrase_offsets_median() -> None:
    ref = [
        WordToken("hello", 10.0, 10.3, 0.9),
        WordToken("there", 10.3, 10.6, 0.9),
        WordToken("friend", 10.6, 11.0, 0.9),
        WordToken("yes", 20.0, 20.2, 0.9),
        WordToken("indeed", 20.2, 20.5, 0.9),
        WordToken("okay", 20.5, 20.8, 0.9),
    ]
    # Same phrases 5s earlier in guest file → guest offset +5 (plays later)
    src = [
        WordToken("hello", 5.0, 5.3, 0.9),
        WordToken("there", 5.3, 5.6, 0.9),
        WordToken("friend", 5.6, 6.0, 0.9),
        WordToken("yes", 15.0, 15.2, 0.9),
        WordToken("indeed", 15.2, 15.5, 0.9),
        WordToken("okay", 15.5, 15.8, 0.9),
    ]
    off, clustered, detail = bleed_phrase_offsets(ref, src, min_matches=2)
    assert off is not None
    assert abs(off - 5.0) < 0.05
    assert len(clustered) >= 2
    assert detail


def test_own_speech_drops_bleed_ngrams() -> None:
    host = [
        WordToken("the", 0.0, 0.2, 0.9),
        WordToken("quick", 0.2, 0.4, 0.9),
        WordToken("brown", 0.4, 0.6, 0.9),
    ]
    guest = [
        WordToken("the", 0.0, 0.2, 0.9),
        WordToken("quick", 0.2, 0.4, 0.9),
        WordToken("brown", 0.4, 0.6, 0.9),
        WordToken("fox", 1.0, 1.2, 0.9),
    ]
    own = own_speech_tokens(guest, [host], n=3)
    texts = [w.text for w in own]
    assert "fox" in texts
    assert texts.count("the") + texts.count("quick") + texts.count("brown") < 3


def test_offset_to_clip_geometry() -> None:
    assert offset_to_clip_geometry(5.0, media_duration=100.0) == (0.0, 100.0, 5.0)
    assert offset_to_clip_geometry(-30.0, media_duration=100.0) == (30.0, 100.0, 0.0)


def test_durations_match_epsilon() -> None:
    assert durations_match(60.0, 60.04)
    # Near-exact only — multi-second ISO skew is not a same-length prior.
    assert not durations_match(60.0, 60.2)
    assert not durations_match(60.0, 65.0)
    assert not durations_match(466.0, 474.0)
    assert durations_match(474.0, 474.02)
    assert not durations_match(400.0, 474.0)


def test_whisper_jitter_bleed_holds_identity(tmp_path: Path) -> None:
    """Sub-second bleed with acoustic ~0 stays at identity (true sync)."""
    from podcast_mcp.edits.conversation_align import AcousticOffset

    host_words = [
        TranscriptWord(text="hello", start=10.0, end=10.3, confidence=0.9),
        TranscriptWord(text="there", start=10.3, end=10.6, confidence=0.9),
        TranscriptWord(text="friend", start=10.6, end=11.0, confidence=0.9),
        TranscriptWord(text="yes", start=20.0, end=20.2, confidence=0.9),
        TranscriptWord(text="indeed", start=20.2, end=20.5, confidence=0.9),
        TranscriptWord(text="okay", start=20.5, end=20.8, confidence=0.9),
        TranscriptWord(text="unique", start=30.0, end=30.4, confidence=0.9),
        TranscriptWord(text="host", start=30.4, end=30.7, confidence=0.9),
        TranscriptWord(text="only", start=30.7, end=31.0, confidence=0.9),
    ]
    # Same phrases ~0.4s earlier on guest (Whisper mic bias), not a late join
    guest_words = [
        TranscriptWord(text="hello", start=9.6, end=9.9, confidence=0.9),
        TranscriptWord(text="there", start=9.9, end=10.2, confidence=0.9),
        TranscriptWord(text="friend", start=10.2, end=10.6, confidence=0.9),
        TranscriptWord(text="yes", start=19.56, end=19.76, confidence=0.9),
        TranscriptWord(text="indeed", start=19.76, end=20.06, confidence=0.9),
        TranscriptWord(text="okay", start=20.06, end=20.36, confidence=0.9),
        TranscriptWord(text="guest", start=25.0, end=25.3, confidence=0.9),
        TranscriptWord(text="reply", start=25.3, end=25.6, confidence=0.9),
        TranscriptWord(text="here", start=25.6, end=25.9, confidence=0.9),
    ]
    proj = _project(
        tmp_path,
        [
            ("host", 100.0, host_words),
            ("guest", 90.0, guest_words),
        ],
    )

    def synced_acoustic(_ref: Path, _src: Path) -> AcousticOffset:
        return AcousticOffset(0.01, peak=0.2, n_windows=3, detail="synced")

    result = plan_conversation_alignment(
        proj,
        defaults={"align": {}, "_align_acoustic_fn": synced_acoustic},
    )
    guest = next(p for p in result.plans if p.track_id == "guest")
    assert guest.method == "bleed_near_identity"
    assert abs(guest.offset_sec) < 1e-6
    assert guest.bleed_offset_sec is not None
    assert abs(guest.bleed_offset_sec) < 1.0
    apply_alignment_plans(proj, result)
    gclip = next(c for c in proj.clips if c.track_id == "guest")
    assert abs(gclip.timeline_start) < 1e-6
    assert abs(gclip.source_start) < 1e-6


def test_small_bleed_applies_when_acoustic_agrees(tmp_path: Path) -> None:
    """Sub-second bleed confirmed by acoustic lag advances the late source."""
    from podcast_mcp.edits.conversation_align import AcousticOffset

    host_words = [
        TranscriptWord(text="hello", start=10.0, end=10.3, confidence=0.9),
        TranscriptWord(text="there", start=10.3, end=10.6, confidence=0.9),
        TranscriptWord(text="friend", start=10.6, end=11.0, confidence=0.9),
        TranscriptWord(text="yes", start=20.0, end=20.2, confidence=0.9),
        TranscriptWord(text="indeed", start=20.2, end=20.5, confidence=0.9),
        TranscriptWord(text="okay", start=20.5, end=20.8, confidence=0.9),
        TranscriptWord(text="unique", start=30.0, end=30.4, confidence=0.9),
        TranscriptWord(text="host", start=30.4, end=30.7, confidence=0.9),
        TranscriptWord(text="only", start=30.7, end=31.0, confidence=0.9),
    ]
    guest_words = [
        TranscriptWord(text="hello", start=10.46, end=10.76, confidence=0.9),
        TranscriptWord(text="there", start=10.76, end=11.06, confidence=0.9),
        TranscriptWord(text="friend", start=11.06, end=11.46, confidence=0.9),
        TranscriptWord(text="yes", start=20.46, end=20.66, confidence=0.9),
        TranscriptWord(text="indeed", start=20.66, end=20.96, confidence=0.9),
        TranscriptWord(text="okay", start=20.96, end=21.26, confidence=0.9),
        TranscriptWord(text="guest", start=25.0, end=25.3, confidence=0.9),
        TranscriptWord(text="reply", start=25.3, end=25.6, confidence=0.9),
        TranscriptWord(text="here", start=25.6, end=25.9, confidence=0.9),
    ]
    proj = _project(
        tmp_path,
        [
            ("host", 100.0, host_words),
            ("guest", 90.0, guest_words),
        ],
    )

    def late_acoustic(_ref: Path, _src: Path) -> AcousticOffset:
        return AcousticOffset(-0.45, peak=0.25, n_windows=5, detail="acoustic median=-0.450s")

    result = plan_conversation_alignment(
        proj,
        defaults={"align": {}, "_align_acoustic_fn": late_acoustic},
    )
    guest = next(p for p in result.plans if p.track_id == "guest")
    assert guest.method == "bleed_acoustic"
    assert abs(guest.offset_sec - (-0.45)) < 0.02
    apply_alignment_plans(proj, result)
    gclip = next(c for c in proj.clips if c.track_id == "guest")
    assert abs(gclip.source_start - 0.45) < 0.02
    assert abs(gclip.timeline_start) < 1e-6


def test_near_equal_iso_durations_not_same_length_prior(tmp_path: Path) -> None:
    # Multi-second stop-time skew must not set same_length_prior.
    host_words = [
        TranscriptWord(text="aaa", start=0.0, end=1.0, confidence=0.9),
        TranscriptWord(text="bbb", start=0.2, end=0.8, confidence=0.9),
        TranscriptWord(text="ccc", start=0.4, end=0.9, confidence=0.9),
        TranscriptWord(text="one", start=0.0, end=2.0, confidence=0.9),
        TranscriptWord(text="two", start=4.0, end=6.0, confidence=0.9),
        TranscriptWord(text="three", start=8.0, end=10.0, confidence=0.9),
        TranscriptWord(text="four", start=12.0, end=14.0, confidence=0.9),
        TranscriptWord(text="five", start=16.0, end=18.0, confidence=0.9),
        TranscriptWord(text="six", start=20.0, end=22.0, confidence=0.9),
    ]
    guest_words = [
        TranscriptWord(text="xxx", start=2.0, end=4.0, confidence=0.9),
        TranscriptWord(text="yyy", start=6.0, end=8.0, confidence=0.9),
        TranscriptWord(text="zzz", start=10.0, end=12.0, confidence=0.9),
        TranscriptWord(text="ggg", start=2.1, end=3.9, confidence=0.9),
        TranscriptWord(text="hhh", start=6.1, end=7.9, confidence=0.9),
        TranscriptWord(text="iii", start=10.1, end=11.9, confidence=0.9),
        TranscriptWord(text="jjj", start=14.1, end=15.9, confidence=0.9),
        TranscriptWord(text="kkk", start=18.1, end=19.9, confidence=0.9),
        TranscriptWord(text="lll", start=22.1, end=23.9, confidence=0.9),
    ]
    proj = _project(
        tmp_path,
        [
            ("host", 466.0, host_words),
            ("guest", 474.0, guest_words),
        ],
    )
    result = plan_conversation_alignment(proj)
    guest = next(p for p in result.plans if p.track_id == "guest")
    assert not guest.same_length_prior


def test_first_utterance_end_merges_close_islands() -> None:
    tokens = [
        WordToken("its", 30.0, 30.3, 0.9),
        WordToken("me", 30.3, 30.5, 0.9),
        WordToken("hello", 30.5, 31.0, 0.9),
        WordToken("friend", 31.0, 33.5, 0.9),
        # Short gap — still same utterance
        WordToken("again", 35.6, 35.9, 0.9),
        # Long gap — new utterance
        WordToken("later", 50.0, 50.4, 0.9),
    ]
    assert first_utterance_end(tokens, max_gap_sec=2.5) == pytest.approx(35.9)
    assert first_utterance_end(tokens, max_gap_sec=1.0) == pytest.approx(33.5)


def test_late_join_offset_parks_first_island_in_host_silence() -> None:
    """Interval-only: delay places first utterance center in a fitting host silence."""
    # Host speaks through where guest would land at identity; silence later.
    host = [(0.0, 45.0), (55.0, 80.0)]
    # Guest first island after leading silence; needs ~+15-25s into [45, 55].
    guest = [(30.0, 35.0), (75.0, 78.0)]
    off, detail = late_join_offset(host, guest, max_offset_sec=120.0)
    assert off is not None
    assert detail is not None
    assert abs(off) > 2.0
    assert abs(off) < 100.0
    center = (30.0 + 35.0) / 2.0 + off
    assert 45.0 <= center <= 55.0


def test_late_join_occupancy_into_host_silence(tmp_path: Path) -> None:
    """Nameless late join: park first real island in a host silence that fits it."""
    host_words = [
        TranscriptWord(text="welcome", start=1.0, end=1.4, confidence=0.9),
        TranscriptWord(text="everyone", start=1.4, end=1.9, confidence=0.9),
        TranscriptWord(text="today", start=1.9, end=2.3, confidence=0.9),
        TranscriptWord(text="we", start=10.0, end=10.2, confidence=0.9),
        TranscriptWord(text="have", start=10.2, end=10.5, confidence=0.9),
        TranscriptWord(text="news", start=10.5, end=10.9, confidence=0.9),
        # Continuous host speech through where guest would land at identity
        *[
            TranscriptWord(
                text=f"h{i}",
                start=float(i),
                end=float(i) + 0.8,
                confidence=0.9,
            )
            for i in range(12, 46, 2)
        ],
        # Host silence ~46-66s (room for guest first island)
        TranscriptWord(text="unique", start=66.0, end=66.4, confidence=0.9),
        TranscriptWord(text="host", start=66.4, end=66.7, confidence=0.9),
        TranscriptWord(text="line", start=66.7, end=67.0, confidence=0.9),
        TranscriptWord(text="more", start=80.0, end=80.4, confidence=0.9),
        TranscriptWord(text="host", start=80.4, end=80.7, confidence=0.9),
        TranscriptWord(text="talk", start=80.7, end=81.0, confidence=0.9),
    ]
    guest_words = [
        # Whisper silence hallucination — must not be first island
        TranscriptWord(text="you.", start=0.9, end=9.0, confidence=0.5),
        TranscriptWord(text="its", start=30.0, end=30.3, confidence=0.9),
        TranscriptWord(text="me", start=30.3, end=30.5, confidence=0.9),
        TranscriptWord(text="the", start=31.28, end=31.36, confidence=0.9),
        TranscriptWord(text="favorite", start=31.36, end=31.72, confidence=0.9),
        TranscriptWord(text="speaker", start=31.72, end=33.46, confidence=0.9),
        TranscriptWord(text="here", start=35.64, end=35.92, confidence=0.9),
        TranscriptWord(text="friend", start=75.0, end=75.4, confidence=0.9),
        TranscriptWord(text="again", start=75.4, end=75.8, confidence=0.9),
        TranscriptWord(text="today", start=75.8, end=76.2, confidence=0.9),
        TranscriptWord(text="more", start=90.0, end=90.3, confidence=0.9),
        TranscriptWord(text="guest", start=90.3, end=90.6, confidence=0.9),
        TranscriptWord(text="talk", start=90.6, end=91.0, confidence=0.9),
    ]
    # First utterance ~[30, 35.92], silence mid ~56 -> delay ~20-26s (not 0 / wall).
    proj = _project(
        tmp_path,
        [
            ("host", 474.0, host_words),
            ("guest", 463.0, guest_words),
        ],
    )
    result = plan_conversation_alignment(proj)
    guest = next(p for p in result.plans if p.track_id == "guest")
    assert guest.method in {"gaps_late", "gaps"}
    assert abs(guest.offset_sec) > 2.0
    assert abs(guest.offset_sec) < 100.0
    # Session placement of first island center should sit in host silence [46, 66].
    island_center_file = (30.0 + 35.92) / 2.0
    session_center = island_center_file + guest.offset_sec
    assert 46.0 <= session_center <= 66.0
    apply_alignment_plans(proj, result)
    gclip = next(c for c in proj.clips if c.track_id == "guest")
    assert abs(gclip.timeline_start - guest.offset_sec) < 0.05


def test_same_length_exact_holds_wall_occupancy(tmp_path: Path) -> None:
    """Exact equal duration: do not apply ±max_offset wall."""
    host_words = [
        TranscriptWord(text=f"h{i}", start=float(i), end=float(i) + 0.5, confidence=0.9)
        for i in range(0, 40, 2)
    ]
    guest_words = [
        TranscriptWord(text=f"g{i}", start=float(i), end=float(i) + 0.5, confidence=0.9)
        for i in range(0, 40, 2)
    ]
    proj = _project(
        tmp_path,
        [
            ("host", 50.0, host_words),
            ("guest", 50.0, guest_words),
        ],
    )
    result = plan_conversation_alignment(
        proj,
        defaults={"align": {"max_offset_sec": 5.0, "coarse_step_sec": 1.0, "fine_step_sec": 0.5}},
    )
    guest = next(p for p in result.plans if p.track_id == "guest")
    assert abs(guest.offset_sec) < 1.0
    assert guest.method in {"same_length", "weak_hold", "gaps", "gaps_prior"}


def test_plan_bleed_preferred(tmp_path: Path) -> None:
    host_words = [
        TranscriptWord(text="hello", start=10.0, end=10.3, confidence=0.9),
        TranscriptWord(text="there", start=10.3, end=10.6, confidence=0.9),
        TranscriptWord(text="friend", start=10.6, end=11.0, confidence=0.9),
        TranscriptWord(text="yes", start=20.0, end=20.2, confidence=0.9),
        TranscriptWord(text="indeed", start=20.2, end=20.5, confidence=0.9),
        TranscriptWord(text="okay", start=20.5, end=20.8, confidence=0.9),
        TranscriptWord(text="unique", start=30.0, end=30.4, confidence=0.9),
        TranscriptWord(text="host", start=30.4, end=30.7, confidence=0.9),
        TranscriptWord(text="only", start=30.7, end=31.0, confidence=0.9),
    ]
    guest_words = [
        TranscriptWord(text="hello", start=5.0, end=5.3, confidence=0.9),
        TranscriptWord(text="there", start=5.3, end=5.6, confidence=0.9),
        TranscriptWord(text="friend", start=5.6, end=6.0, confidence=0.9),
        TranscriptWord(text="yes", start=15.0, end=15.2, confidence=0.9),
        TranscriptWord(text="indeed", start=15.2, end=15.5, confidence=0.9),
        TranscriptWord(text="okay", start=15.5, end=15.8, confidence=0.9),
        TranscriptWord(text="guest", start=25.0, end=25.3, confidence=0.9),
        TranscriptWord(text="reply", start=25.3, end=25.6, confidence=0.9),
        TranscriptWord(text="here", start=25.6, end=25.9, confidence=0.9),
    ]
    proj = _project(
        tmp_path,
        [
            ("host", 100.0, host_words),
            ("guest", 90.0, guest_words),
        ],
    )
    result = plan_conversation_alignment(proj)
    assert result.skipped_reason is None
    guest = next(p for p in result.plans if p.track_id == "guest")
    assert guest.method == "bleed"
    assert abs(guest.offset_sec - 5.0) < 0.1
    apply_alignment_plans(proj, result)
    gclip = next(c for c in proj.clips if c.track_id == "guest")
    assert abs(gclip.timeline_start - 5.0) < 0.1


def test_same_length_prior_holds(tmp_path: Path) -> None:
    # Alternating speech already at offset 0; same duration → keep identity
    host_words = [
        TranscriptWord(text="aaa", start=0.0, end=1.0, confidence=0.9),
        TranscriptWord(text="bbb", start=0.2, end=0.8, confidence=0.9),
        TranscriptWord(text="ccc", start=0.4, end=0.9, confidence=0.9),
        TranscriptWord(text="one", start=0.0, end=2.0, confidence=0.9),
        TranscriptWord(text="two", start=4.0, end=6.0, confidence=0.9),
        TranscriptWord(text="three", start=8.0, end=10.0, confidence=0.9),
    ]
    guest_words = [
        TranscriptWord(text="xxx", start=2.0, end=4.0, confidence=0.9),
        TranscriptWord(text="yyy", start=6.0, end=8.0, confidence=0.9),
        TranscriptWord(text="zzz", start=10.0, end=12.0, confidence=0.9),
        TranscriptWord(text="four", start=2.1, end=3.9, confidence=0.9),
        TranscriptWord(text="five", start=6.1, end=7.9, confidence=0.9),
        TranscriptWord(text="six", start=10.1, end=11.9, confidence=0.9),
    ]
    proj = _project(
        tmp_path,
        [
            ("host", 60.0, host_words),
            ("guest", 60.0, guest_words),
        ],
    )
    result = plan_conversation_alignment(proj)
    guest = next(p for p in result.plans if p.track_id == "guest")
    assert abs(guest.offset_sec) < 1.0 or guest.same_length_prior


def test_gap_at_max_offset_holds_zero(tmp_path: Path) -> None:
    """Hitting the search wall is treated as weak — keep identity."""
    host_words = [
        TranscriptWord(text=f"h{i}", start=float(i), end=float(i) + 0.5, confidence=0.9)
        for i in range(0, 40, 2)
    ]
    # Guest speech islands that only "fit" when shifted to the wall (no bleed overlap).
    guest_words = [
        TranscriptWord(text=f"g{i}", start=float(i), end=float(i) + 0.5, confidence=0.9)
        for i in range(0, 40, 2)
    ]
    proj = _project(
        tmp_path,
        [
            ("host", 50.0, host_words),
            ("guest", 50.0, guest_words),
        ],
    )
    result = plan_conversation_alignment(
        proj,
        defaults={"align": {"max_offset_sec": 5.0, "coarse_step_sec": 1.0, "fine_step_sec": 0.5}},
    )
    guest = next(p for p in result.plans if p.track_id == "guest")
    # Same-length prior or weak_hold — never leave a wall-hit large offset applied.
    assert abs(guest.offset_sec) < 1.0 or guest.method in {"same_length", "weak_hold", "bleed"}


def test_skip_single_track(tmp_path: Path) -> None:
    proj = _project(
        tmp_path,
        [("solo", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.5, confidence=0.9)])],
    )
    result = plan_conversation_alignment(proj)
    assert result.skipped_reason is not None


def test_three_speakers_n_way(tmp_path: Path) -> None:
    def words(offset: float, label: str) -> list[TranscriptWord]:
        return [
            TranscriptWord(text=f"{label}a", start=offset, end=offset + 1, confidence=0.9),
            TranscriptWord(text=f"{label}b", start=offset + 0.2, end=offset + 0.8, confidence=0.9),
            TranscriptWord(text=f"{label}c", start=offset + 0.4, end=offset + 0.9, confidence=0.9),
            TranscriptWord(text="shared", start=offset + 5, end=offset + 5.3, confidence=0.9),
            TranscriptWord(text="phrase", start=offset + 5.3, end=offset + 5.6, confidence=0.9),
            TranscriptWord(text="here", start=offset + 5.6, end=offset + 5.9, confidence=0.9),
        ]

    # Guest starts 10s later in file than host/third for shared phrase
    host_w = words(0.0, "h")
    guest_w = words(10.0, "g")  # shared at 15 vs host 5 → offset -10?
    # bleed: ref_start - src_start for "shared phrase here"
    # host shared at 5, guest at 15 → offset = 5-15 = -10 → lead-in trim
    third_w = words(0.0, "t")
    proj = _project(
        tmp_path,
        [
            ("host", 80.0, host_w),
            ("guest", 90.0, guest_w),
            ("third", 80.0, third_w),
        ],
    )
    result = plan_conversation_alignment(proj)
    assert len(result.plans) == 3
    assert result.reference_track_id == "host"
    assert {p.track_id for p in result.plans} == {"host", "guest", "third"}


def test_multi_file_clips_plan_independently(tmp_path: Path) -> None:
    """Several whole-file clips on one speaker each get their own plan."""
    from podcast_mcp.models import SourceRecording

    host_words = [
        TranscriptWord(text="hello", start=10.0, end=10.3, confidence=0.9),
        TranscriptWord(text="there", start=10.3, end=10.6, confidence=0.9),
        TranscriptWord(text="friend", start=10.6, end=11.0, confidence=0.9),
        TranscriptWord(text="yes", start=20.0, end=20.2, confidence=0.9),
        TranscriptWord(text="indeed", start=20.2, end=20.5, confidence=0.9),
        TranscriptWord(text="okay", start=20.5, end=20.8, confidence=0.9),
    ]
    # Guest part A: shared phrase early in file → offset ~+5 vs host
    guest_a = [
        TranscriptWord(text="hello", start=5.0, end=5.3, confidence=0.9),
        TranscriptWord(text="there", start=5.3, end=5.6, confidence=0.9),
        TranscriptWord(text="friend", start=5.6, end=6.0, confidence=0.9),
    ]
    # Guest part B: different shared phrase, later → offset ~+20
    guest_b = [
        TranscriptWord(text="yes", start=0.0, end=0.2, confidence=0.9),
        TranscriptWord(text="indeed", start=0.2, end=0.5, confidence=0.9),
        TranscriptWord(text="okay", start=0.5, end=0.8, confidence=0.9),
    ]
    p = EpisodeProject(meta=ProjectMeta(name="multi", workspace_dir=str(tmp_path)))
    p.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=100.0),
        )
    )
    p.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=30.0),
        )
    )
    p.sources.extend(
        [
            SourceRecording(
                id="guest_a", path="raw/guest_a.wav", speaker="Guest", duration_sec=30.0
            ),
            SourceRecording(
                id="guest_b", path="raw/guest_b.wav", speaker="Guest", duration_sec=20.0
            ),
        ]
    )
    p.clips.extend(
        [
            Clip(
                id="clip_host",
                track_id="host",
                source_start=0.0,
                source_end=100.0,
                timeline_start=0.0,
            ),
            Clip(
                id="clip_ga",
                track_id="guest",
                source_start=0.0,
                source_end=30.0,
                timeline_start=0.0,
                source_id="guest_a",
            ),
            Clip(
                id="clip_gb",
                track_id="guest",
                source_start=0.0,
                source_end=20.0,
                timeline_start=0.0,
                source_id="guest_b",
            ),
        ]
    )
    p.transcripts.extend(
        [
            Transcript(track_id="host", words=host_words),
            Transcript(track_id="guest", source_id="guest_a", words=guest_a),
            Transcript(track_id="guest", source_id="guest_b", words=guest_b),
        ]
    )
    result = plan_conversation_alignment(p)
    guest_plans = [pl for pl in result.plans if pl.track_id == "guest"]
    assert len(guest_plans) == 2
    assert {pl.clip_id for pl in guest_plans} == {"clip_ga", "clip_gb"}
    # Do not invent extra clips from one file — count stays 2 guest + 1 host
    assert len(result.plans) == 3


def test_plan_honors_cancel_check(tmp_path: Path) -> None:
    host_words = [TranscriptWord(text="hello", start=0.0, end=0.4, confidence=0.9)]
    guest_words = [TranscriptWord(text="hello", start=0.0, end=0.4, confidence=0.9)]
    proj = _project(
        tmp_path,
        [
            ("host", 10.0, host_words),
            ("guest", 10.0, guest_words),
        ],
    )
    with pytest.raises(RuntimeError, match="cancelled"):
        plan_conversation_alignment(
            proj,
            defaults={"_pipeline_cancel_check": lambda: True},
        )


def test_align_result_summary_skip_and_overflow() -> None:
    assert AlignResult(skipped_reason="skipped (<2 dialogue clips)").summary().startswith("skipped")
    plans = [
        ClipAlignPlan(track_id=f"t{i}", clip_id=f"c{i}", offset_sec=float(i + 1), method="gap")
        for i in range(8)
    ]
    text = AlignResult(plans=plans, reference_track_id="t0").summary()
    assert "+2 more" in text


def test_snapshot_restore_clip_geometry(tmp_path: Path) -> None:
    proj = _project(tmp_path, [("host", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)])])
    snap = snapshot_clip_geometry(proj)
    proj.clips[0].timeline_start = 9.0
    restore_clip_geometry(proj, [*snap, ("missing", 0.0, 1.0, 0.0)])
    assert proj.clips[0].timeline_start == 0.0


def test_run_conversation_align_skip_writes_artifact(tmp_path: Path) -> None:
    proj = _project(tmp_path, [("host", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)])])
    result = run_conversation_align(proj)
    assert result.skipped_reason
    artifact = tmp_path / "artifacts" / "alignment" / "conversation_align.json"
    assert artifact.is_file()
    assert apply_alignment_plans(proj, result) == 0


def test_apply_alignment_plans_creates_missing_clip(tmp_path: Path) -> None:
    p = EpisodeProject(meta=ProjectMeta(name="apply", workspace_dir=str(tmp_path)))
    p.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=8.0),
        )
    )
    result = AlignResult(
        plans=[
            ClipAlignPlan(
                track_id="host",
                clip_id="clip_host",
                offset_sec=2.0,
                method="gap",
            )
        ],
        reference_track_id="host",
    )
    assert apply_alignment_plans(p, result) == 1
    assert p.clips[0].id == "clip_host"
    assert p.clips[0].timeline_start == pytest.approx(2.0)


def test_acoustic_clip_offset_early_stop_and_fail_hard(tmp_path: Path) -> None:
    from podcast_mcp.engines.align import AlignmentResult

    ref = tmp_path / "ref.wav"
    src = tmp_path / "src.wav"
    ref.write_bytes(b"x")
    src.write_bytes(b"y")
    audio = np.ones(8000, dtype=np.float32) * 0.5
    hits = {"n": 0}

    def load_ok(*_a, **_k):
        return audio

    def estimate(_ref, _src, **_k):
        hits["n"] += 1
        return AlignmentResult(reference=ref, source=src, offset_sec=0.04, correlation_peak=0.9)

    with (
        patch("podcast_mcp.edits.conversation_align._probe_duration_sec", return_value=600.0),
        patch("podcast_mcp.engines.align.load_mono_window", side_effect=load_ok),
        patch("podcast_mcp.engines.align.estimate_offset_from_arrays", side_effect=estimate),
    ):
        out = acoustic_clip_offset(ref, src, starts=[15.0, 25.0, 35.0, 45.0, 55.0, 65.0])
    assert out is not None
    assert out.n_windows == 5
    assert hits["n"] == 5

    with (
        patch("podcast_mcp.edits.conversation_align._probe_duration_sec", return_value=600.0),
        patch("podcast_mcp.engines.align.load_mono_window", side_effect=OSError("decode")),
    ):
        with pytest.raises(RuntimeError, match="could not decode"):
            acoustic_clip_offset(ref, src, starts=[15.0, 25.0])

    with pytest.raises(ValueError, match="source_starts"):
        acoustic_clip_offset(ref, src, starts=[1.0], source_starts=[1.0, 2.0])

    with (
        patch("podcast_mcp.edits.conversation_align._probe_duration_sec", return_value=600.0),
        patch("podcast_mcp.engines.align.load_mono_window", return_value=audio),
    ):
        with pytest.raises(RuntimeError, match="cancelled"):
            acoustic_clip_offset(ref, src, starts=[15.0], cancel_check=lambda: True)


def test_acoustic_clip_offset_skips_quiet_and_low_peak(tmp_path: Path) -> None:
    from podcast_mcp.engines.align import AlignmentResult

    ref = tmp_path / "ref.wav"
    src = tmp_path / "src.wav"
    quiet = np.zeros(8000, dtype=np.float32)
    loud = np.ones(8000, dtype=np.float32)
    with (
        patch("podcast_mcp.edits.conversation_align._probe_duration_sec", return_value=80.0),
        patch("podcast_mcp.engines.align.load_mono_window", return_value=quiet),
    ):
        assert acoustic_clip_offset(ref, src, starts=[15.0]) is None

    def estimate(_ref, _src, **_k):
        return AlignmentResult(reference=ref, source=src, offset_sec=0.2, correlation_peak=0.01)

    with (
        patch("podcast_mcp.edits.conversation_align._probe_duration_sec", return_value=80.0),
        patch("podcast_mcp.engines.align.load_mono_window", return_value=loud),
        patch("podcast_mcp.engines.align.estimate_offset_from_arrays", side_effect=estimate),
    ):
        assert acoustic_clip_offset(ref, src, starts=[15.0]) is None


def test_align_tracks_restores_clips_on_failure(tmp_path: Path) -> None:
    from podcast_mcp.pipeline import steps

    proj = _project(
        tmp_path,
        [
            ("host", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)]),
            ("guest", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)]),
        ],
    )
    orig = proj.clips[0].timeline_start

    def boom(_project, **_k):
        _project.clips[0].timeline_start = 42.0
        raise RuntimeError("align failed")

    with patch(
        "podcast_mcp.edits.conversation_align.run_conversation_align",
        side_effect=boom,
    ):
        with pytest.raises(RuntimeError, match="align failed"):
            steps.align_tracks(proj, {})
    assert proj.clips[0].timeline_start == orig


def test_words_to_tokens_skips_suppressed_and_zero_width() -> None:
    from podcast_mcp.edits.conversation_align import words_to_tokens

    tokens = words_to_tokens(
        [
            TranscriptWord(text="gone", start=0.0, end=0.2, suppressed=True),
            TranscriptWord(text="bad", start=1.0, end=1.0, confidence=0.9),
            TranscriptWord(text="ok", start=2.0, end=2.2),
        ]
    )
    assert [t.text for t in tokens] == ["ok"]


def test_identity_summary_and_fingerprint_meta(tmp_path: Path) -> None:
    from podcast_mcp.edits.conversation_align import alignment_fingerprint
    from podcast_mcp.models import SpeakerIngestAlignment

    text = AlignResult(
        plans=[ClipAlignPlan(track_id="h", clip_id="c", offset_sec=0.0, method="reference")],
        reference_track_id="h",
    ).summary()
    assert "identity" in text
    proj = _project(
        tmp_path,
        [
            ("host", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)]),
            ("guest", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)]),
        ],
    )
    result = run_conversation_align(proj)
    assert not result.skipped_reason
    assert proj.clips
    proj.meta.ingest_alignment = {
        "Host": SpeakerIngestAlignment(
            session_start_in_file_sec=0.0,
            content_align_sec=0.0,
            align_method="reference",
        )
    }
    assert len(alignment_fingerprint(proj)) == 16


def test_resolve_clip_wav_and_probe_missing(tmp_path: Path) -> None:
    from podcast_mcp.edits.conversation_align import _probe_duration_sec, resolve_clip_wav

    proj = _project(tmp_path, [("host", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)])])
    assert resolve_clip_wav(proj, proj.tracks[0], proj.clips[0]) is None
    assert _probe_duration_sec(tmp_path / "missing.wav") is None


def test_acoustic_clip_offset_default_starts_and_estimate_error(tmp_path: Path) -> None:
    ref = tmp_path / "ref.wav"
    src = tmp_path / "src.wav"
    loud = np.ones(8000, dtype=np.float32)
    with (
        patch("podcast_mcp.edits.conversation_align._probe_duration_sec", return_value=20.0),
        patch("podcast_mcp.engines.align.load_mono_window", return_value=loud),
        patch(
            "podcast_mcp.engines.align.estimate_offset_from_arrays",
            side_effect=ValueError("too short"),
        ),
    ):
        with pytest.raises(RuntimeError, match="could not decode"):
            acoustic_clip_offset(ref, src)
    with (
        patch("podcast_mcp.edits.conversation_align._probe_duration_sec", return_value=600.0),
        patch("podcast_mcp.engines.align.load_mono_window", return_value=loud),
        patch(
            "podcast_mcp.engines.align.estimate_offset_from_arrays",
            side_effect=ValueError("too short"),
        ),
    ):
        with pytest.raises(RuntimeError, match="could not decode"):
            acoustic_clip_offset(ref, src, starts=[-1.0, 15.0], source_starts=[-1.0, 15.0])


def test_apply_alignment_skips_music_and_uses_source_duration(tmp_path: Path) -> None:
    from podcast_mcp.models import SourceRecording

    p = EpisodeProject(meta=ProjectMeta(name="apply2", workspace_dir=str(tmp_path)))
    p.tracks.append(
        Track(
            id="music",
            label="Music",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/m.wav", duration_sec=4.0),
        )
    )
    p.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/g.wav", duration_sec=8.0),
        )
    )
    p.sources.append(SourceRecording(id="g1", path="raw/g.wav", speaker="Guest", duration_sec=9.0))
    p.clips.append(
        Clip(
            id="cg",
            track_id="guest",
            source_start=0.0,
            source_end=8.0,
            timeline_start=0.0,
            source_id="g1",
        )
    )
    result = AlignResult(
        plans=[
            ClipAlignPlan(track_id="guest", clip_id="cg", offset_sec=-1.0, method="gap"),
        ],
        reference_track_id="guest",
    )
    assert apply_alignment_plans(p, result) == 1
    assert p.clips[0].source_start == pytest.approx(1.0)
    assert p.clips[0].timeline_start == 0.0


def test_align_tracks_marks_pending_when_not_skipped(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import load_status
    from podcast_mcp.pipeline import steps

    proj = _project(
        tmp_path,
        [
            ("host", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)]),
            ("guest", 10.0, [TranscriptWord(text="hi", start=0.0, end=0.2)]),
        ],
    )
    proj.ensure_dirs()
    summary = steps.align_tracks(proj, {})
    assert summary
    data = load_status(proj)
    assert data is not None
    assert data["status"] == "pending"


def test_acoustic_window_fits_short_files() -> None:
    from podcast_mcp.edits.conversation_align import _acoustic_window_and_starts

    win, starts = _acoustic_window_and_starts(20.0, window_sec=8.0, max_lag_sec=1.0, starts=None)
    assert 2.0 <= win <= 8.0
    assert 0.0 in starts
    assert all(s + win <= 20.0 + 1e-6 for s in starts)


def test_acoustic_clip_offset_counts_called_process_error(tmp_path: Path) -> None:
    import subprocess

    ref = tmp_path / "ref.wav"
    src = tmp_path / "src.wav"
    ref.write_bytes(b"x")
    src.write_bytes(b"y")
    err = subprocess.CalledProcessError(1, "ffmpeg")
    with (
        patch("podcast_mcp.edits.conversation_align._probe_duration_sec", return_value=80.0),
        patch("podcast_mcp.engines.align.load_mono_window", side_effect=err),
    ):
        with pytest.raises(RuntimeError, match="could not decode"):
            acoustic_clip_offset(ref, src, starts=[15.0])


def test_apply_keeps_identity_sequential_reference_clips(tmp_path: Path) -> None:
    p = EpisodeProject(meta=ProjectMeta(name="seq", workspace_dir=str(tmp_path)))
    p.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    )
    p.clips.extend(
        [
            Clip(
                id="h1",
                track_id="host",
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            ),
            Clip(
                id="h2",
                track_id="host",
                source_start=0.0,
                source_end=8.0,
                timeline_start=12.0,
            ),
        ]
    )
    result = AlignResult(
        plans=[
            ClipAlignPlan(track_id="host", clip_id="h1", offset_sec=0.0, method="reference"),
            ClipAlignPlan(track_id="host", clip_id="h2", offset_sec=0.0, method="reference"),
        ],
        reference_track_id="host",
    )
    assert apply_alignment_plans(p, result) == 2
    by_id = {c.id: c for c in p.clips}
    assert by_id["h1"].timeline_start == pytest.approx(0.0)
    assert by_id["h2"].timeline_start == pytest.approx(12.0)


def test_bleed_scores_against_reference_not_concatenated_peers(tmp_path: Path) -> None:
    """A third speaker sharing the phrase at a distant time must not steal the clock."""
    host = [
        TranscriptWord(text="hello", start=10.0, end=10.3, confidence=0.9),
        TranscriptWord(text="there", start=10.3, end=10.6, confidence=0.9),
        TranscriptWord(text="friend", start=10.6, end=11.0, confidence=0.9),
        TranscriptWord(text="yes", start=20.0, end=20.2, confidence=0.9),
        TranscriptWord(text="indeed", start=20.2, end=20.5, confidence=0.9),
        TranscriptWord(text="okay", start=20.5, end=20.8, confidence=0.9),
    ]
    guest = [
        TranscriptWord(text="hello", start=5.0, end=5.3, confidence=0.9),
        TranscriptWord(text="there", start=5.3, end=5.6, confidence=0.9),
        TranscriptWord(text="friend", start=5.6, end=6.0, confidence=0.9),
        TranscriptWord(text="yes", start=15.0, end=15.2, confidence=0.9),
        TranscriptWord(text="indeed", start=15.2, end=15.5, confidence=0.9),
        TranscriptWord(text="okay", start=15.5, end=15.8, confidence=0.9),
    ]
    third = [
        TranscriptWord(text="hello", start=80.0, end=80.3, confidence=0.9),
        TranscriptWord(text="there", start=80.3, end=80.6, confidence=0.9),
        TranscriptWord(text="friend", start=80.6, end=81.0, confidence=0.9),
        TranscriptWord(text="yes", start=90.0, end=90.2, confidence=0.9),
        TranscriptWord(text="indeed", start=90.2, end=90.5, confidence=0.9),
        TranscriptWord(text="okay", start=90.5, end=90.8, confidence=0.9),
    ]
    proj = _project(
        tmp_path,
        [
            ("host", 100.0, host),
            ("guest", 40.0, guest),
            ("third", 100.0, third),
        ],
    )
    result = plan_conversation_alignment(proj)
    guest_plan = next(p for p in result.plans if p.track_id == "guest")
    assert guest_plan.method.startswith("bleed")
    assert abs(guest_plan.offset_sec - 5.0) < 0.5
