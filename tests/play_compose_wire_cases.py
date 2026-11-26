"""The audition-context scenarios the wire pins run: a project builder and a window per name."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from play_compose_wire_helpers import (
    TrackSpec,
    build_project,
    delayed_copy,
    dialogue_pair,
    open_workspace,
    pending_cut,
    speech_like,
    voice,
    with_clipping,
    with_hum,
)
from podcast_mcp.edits.comments import add_comment
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    ProcessingEffect,
    SourceRecording,
    Track,
    TrackRole,
)
from podcast_mcp.models.clip_timing import ClipTiming, TimingStep
from podcast_mcp.services.app import ProjectWorkspace

ALL = ("service", "mcp", "cli")
SERVICE = ("service",)
Build = Callable[[Path], ProjectWorkspace]


@dataclass(frozen=True)
class Case:
    build: Build
    start: float
    end: float
    kwargs: dict[str, Any] = field(default_factory=dict)
    surfaces: tuple[str, ...] = ALL
    setup: Callable[[Any, ProjectWorkspace], None] | None = None


def _ws(tmp: Path, specs: list[TrackSpec], *, edit: Any = None, applied: bool = False):
    project = build_project(tmp, specs)
    if edit is not None:
        edit(project)
    return open_workspace(project, specs, applied=applied)


def pair(tmp: Path, **kwargs: Any) -> ProjectWorkspace:
    specs = dialogue_pair(**kwargs)
    return _ws(tmp, specs)


def pair_with_stems(host: str, guest: str) -> Build:
    def build(tmp: Path) -> ProjectWorkspace:
        specs = dialogue_pair()
        specs[0].stem, specs[1].stem = host, guest
        return _ws(tmp, specs)

    return build


def single(tmp: Path) -> ProjectWorkspace:
    return _ws(tmp, dialogue_pair()[:1])


def empty(tmp: Path) -> ProjectWorkspace:
    return _ws(tmp, [])


def skewed(shift: float) -> Build:
    """Guest's second clip follows a one-track ripple of ``shift`` seconds; window mid 6.0 is in it."""

    def build(tmp: Path) -> ProjectWorkspace:
        specs = dialogue_pair()
        specs[1].clips = [(0.0, 4.0, 0.0), (4.0, 8.0, 4.0 + shift)]
        return _ws(tmp, specs)

    return build


def whisper_only(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()
    specs[0].aligner = None
    return _ws(tmp, specs)


def suppressed(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()
    specs[0].suppressed = (0, 1, 2)
    return _ws(tmp, specs)


def partly_suppressed(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()
    specs[0].suppressed = (1,)
    return _ws(tmp, specs)


def muted_speaking(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()
    specs[1].muted = True
    return _ws(tmp, specs)


def uneven(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()
    specs[0].words = [(f"w{i}", 0.4 + i * 0.3, 0.6 + i * 0.3) for i in range(9)]
    specs[1].words = [("ok", 0.6, 0.9), ("yes", 1.0, 1.3)]
    return _ws(tmp, specs)


def long_text(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()
    specs[0].words = [(f"longword{i:02d}", 0.1 + i * 0.15, 0.2 + i * 0.15) for i in range(26)]
    return _ws(tmp, specs)


def effects_and_comments(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()
    specs[0].effects = [
        ProcessingEffect(effect="gate", params={"threshold": -40}),
        ProcessingEffect(effect="eq", params={}, bypass=True),
        ProcessingEffect(effect="deess", params={"amount": 0.5}),
    ]

    def edit(project: Any) -> None:
        add_comment(
            project,
            body="Check join",
            author="agent",
            timeline_start=1.5,
            timeline_end=3.0,
            track_ids=["host"],
            action_texts=["Listen", "Trim"],
        )
        add_comment(
            project, body="Point note", author="reviewer", timeline_start=2.0, track_ids=["guest"]
        )
        add_comment(project, body="Far away", author="agent", timeline_start=7.0, timeline_end=7.5)

    return _ws(tmp, specs, edit=edit)


def aux_tracks(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()

    def edit(project: Any) -> None:
        for track_id, role, muted in (
            ("music", TrackRole.MUSIC, False),
            ("sting", TrackRole.SFX, True),
            ("intro", TrackRole.INTRO, False),
        ):
            path = f"raw/{track_id}.wav"
            (tmp / path).write_bytes((tmp / "raw" / "host.wav").read_bytes())
            project.timeline.tracks.append(
                Track(
                    id=track_id,
                    label=track_id,
                    role=role,
                    media=MediaAsset(path=path, duration_sec=8.0),
                    muted=muted,
                )
            )
        project.sources = [SourceRecording(id="music-source", path="raw/music.wav", duration_sec=8)]
        project.timeline.clips.extend(
            [
                Clip(
                    id=clip_id,
                    track_id="music",
                    source_id="music-source",
                    source_start=1,
                    source_end=2,
                    timeline_start=start,
                )
                for clip_id, start in [("late", 3), ("early", 1)]
            ]
            + [
                Clip(
                    id="effect",
                    track_id="sting",
                    source_start=0,
                    source_end=1,
                    timeline_start=2,
                    timing=ClipTiming(steps=[TimingStep(at=0.5, delta_sec=0.25)]),
                ),
                Clip(id="intro", track_id="intro", source_start=0, source_end=1, timeline_start=2),
            ]
        )

    return _ws(tmp, specs, edit=edit)


def with_pending(*cuts: Any, applied: bool = False, silent: bool = True) -> Build:
    """Host/guest pair plus pending edits; the held-check needs the host's hole at 1.4 s."""

    def build(tmp: Path) -> ProjectWorkspace:
        specs = dialogue_pair()
        for spec in specs:
            spec.samples = spec.samples * 0.0
        specs[0].clips = [(0.0, 1.4, 0.0), (1.42, 8.0, 1.4)]

        def edit(project: Any) -> None:
            project.edit_decisions = [make() for make in cuts]

        return _ws(tmp, specs, edit=edit, applied=applied)

    return build


def review(edit_id: str, start: float, end: float, **kwargs: Any) -> Callable[[], Any]:
    return lambda: pending_cut(edit_id, "host", start, end, review_required=True, **kwargs)


def auto(edit_id: str, start: float, end: float, **kwargs: Any) -> Callable[[], Any]:
    return lambda: pending_cut(edit_id, "host", start, end, **kwargs)


def visual_events(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()
    for spec in specs:
        spec.samples = spec.samples * 0.0
    specs[0].clips = [(0.0, 1.4, 0.0), (1.42, 8.0, 1.4)]

    def edit(project: Any) -> None:
        project.edit_decisions = [pending_cut("ok", "host", 4.0, 4.4, review_required=True)]
        add_comment(
            project, body="Listen here", author="agent", timeline_start=2.0, timeline_end=2.5
        )

    return _ws(tmp, specs, edit=edit)


def unreadable_check(monkeypatch: Any, ws: ProjectWorkspace) -> None:
    from podcast_mcp.services.document import EditService

    def boom(self: Any, ids: Any = None) -> Any:
        raise OSError("audio unreadable")

    monkeypatch.setattr(EditService, "held_by_checks", boom)


def hum_and_clipping(tmp: Path) -> ProjectWorkspace:
    base = voice(12.0, 0.2, 11.8, f0=140.0)
    specs = [
        TrackSpec(
            "host",
            with_clipping(with_hum(base, 2.0, 5.0, level=0.3), 7.0, 10.0),
            words=[("hello", 0.5, 0.9), ("there", 3.0, 3.4), ("loud", 7.5, 8.0)],
            aligner="forced",
        ),
        TrackSpec("guest", voice(12.0, 0.2, 11.8, f0=210.0)),
    ]
    return _ws(tmp, specs)


def crossing_one_track(tmp: Path) -> ProjectWorkspace:
    specs = [
        TrackSpec(
            "host",
            voice(3.0, 1.0, 2.2),
            clips=[(0.0, 0.5, 0.0), (1.34, 3.0, 0.5)],
            words=[("Um,", 1.49, 1.9), ("what", 2.0, 2.2)],
            aligner="forced",
        )
    ]
    return _ws(tmp, specs)


def crossing_two_tracks(tmp: Path) -> ProjectWorkspace:
    specs = [
        TrackSpec(
            "host",
            voice(3.0, 1.0, 2.2),
            clips=[(0.0, 0.5, 0.0), (1.34, 3.0, 0.5)],
            words=[("Um,", 1.49, 1.9)],
            aligner="forced",
        ),
        TrackSpec("peer", voice(3.0, 1.0, 2.2, f0=210.0), clips=[(0.0, 3.0, 0.0)]),
    ]
    return _ws(tmp, specs)


def echo(stem: str) -> Build:
    def build(tmp: Path) -> ProjectWorkspace:
        host = speech_like(20.0, seed=3)
        guest = (
            delayed_copy(host, delay_samples=24, gain_db=-18.0) + speech_like(20.0, seed=4) * 0.05
        )
        specs = [TrackSpec("host", host, stem=stem), TrackSpec("guest", guest, stem=stem)]
        return _ws(tmp, specs)

    return build


def echo_long_delay(tmp: Path) -> ProjectWorkspace:
    host = speech_like(20.0, seed=23)
    guest = delayed_copy(host, delay_samples=1200, gain_db=-14) + speech_like(20.0, seed=27) * 0.03
    specs = [TrackSpec("host", host, stem="fresh"), TrackSpec("guest", guest, stem="fresh")]
    return _ws(tmp, specs)


def media_missing(tmp: Path) -> ProjectWorkspace:
    ws = pair(tmp)
    (tmp / "raw" / "guest.wav").unlink()
    return ws


def speaker_roles(monkeypatch: Any, ws: ProjectWorkspace) -> None:
    from podcast_mcp.engines.speaker_id import WindowScore

    def score_window(project: Any, track_id: str, start: float, end: float, *_a: Any, **_k: Any):
        return WindowScore(
            track_id=track_id,
            start_sec=start,
            end_sec=end,
            scores={track_id: 0.9},
            best_track_id=track_id,
            best_identity=track_id,
            margin=0.5,
        )

    monkeypatch.setattr(
        "podcast_mcp.engines.speaker_id.load_all_profiles", lambda _p: {"host": object()}
    )
    monkeypatch.setattr("podcast_mcp.engines.speaker_id.score_window", score_window)
    monkeypatch.setattr("podcast_mcp.engines.speaker_id.resolve_speaker_backend", lambda: object())


def _seeded(tmp: Path, *, tracks: tuple[str, ...], mutate: Any = None) -> ProjectWorkspace:
    from play_compose_wire_helpers import profile_segment, seed_profile

    specs = dialogue_pair()
    project = build_project(tmp, specs)
    ws = open_workspace(project, specs)
    loaded = ws.project
    for tid in tracks:
        seed_profile(
            loaded,
            tid,
            [profile_segment(0.0, 2.0), profile_segment(2.0, 4.0, word="world")],
            tag="a" if tid == "host" else "b",
        )
    if mutate is not None:
        mutate(ws)
    return ProjectWorkspace.open(ws.path)


def prosody_both(tmp: Path) -> ProjectWorkspace:
    return _seeded(tmp, tracks=("host", "guest"))


def prosody_host_only(tmp: Path) -> ProjectWorkspace:
    return _seeded(tmp, tracks=("host",))


def prosody_retimed(tmp: Path) -> ProjectWorkspace:
    def mutate(ws: ProjectWorkspace) -> None:
        from podcast_mcp.models import save_project

        project = ws.project
        project.transcript_for_track("host").words[0].start = 0.55
        save_project(project, ws.path)

    return _seeded(tmp, tracks=("host", "guest"), mutate=mutate)


def prosody_crowded(tmp: Path) -> ProjectWorkspace:
    from play_compose_wire_helpers import profile_segment, seed_profile

    specs = dialogue_pair(seconds=16.0)
    ws = open_workspace(build_project(tmp, specs), specs)
    seed_profile(
        ws.project, "host", [profile_segment(i * 2.0, i * 2.0 + 2.0) for i in range(8)], tag="a"
    )
    return ProjectWorkspace.open(ws.path)


_NO_DSP = {"include_dsp": False}
_FULL = {"detail": "full"}
_FULL_NO_DSP = {"detail": "full", "include_dsp": False}

CASES: dict[str, Case] = {
    "empty-project": Case(empty, 0.0, 2.0, _NO_DSP, SERVICE),
    "empty-project-dsp": Case(empty, 0.0, 2.0),
    "empty-project-full": Case(empty, 0.0, 2.0, _FULL),
    "single-summary": Case(single, 0.0, 4.0, _NO_DSP, SERVICE),
    "single-summary-dsp": Case(single, 0.0, 4.0),
    "single-full": Case(single, 0.0, 4.0, _FULL),
    "pair-summary": Case(pair, 0.0, 4.0, _NO_DSP, SERVICE),
    "pair-full": Case(pair, 0.0, 4.0, _FULL_NO_DSP, SERVICE),
    "pair-summary-dsp": Case(pair, 0.0, 4.0),
    "pair-full-dsp": Case(pair, 0.0, 4.0, _FULL),
    "pair-partial-captions": Case(pair, 2.0, 3.2, _NO_DSP, SERVICE),
    "pair-partial-captions-dsp": Case(pair, 2.0, 3.2),
    "pair-no-captions": Case(pair, 5.0, 7.0, _NO_DSP, SERVICE),
    "pair-no-captions-dsp": Case(pair, 5.0, 7.0),
    "pair-past-the-end": Case(pair, 20.0, 22.0, _NO_DSP, SERVICE),
    "pair-past-the-end-dsp": Case(pair, 20.0, 22.0),
    "pair-whole-timeline": Case(pair, 0.0, 8.0, _FULL),
    "pair-guest-offset": Case(lambda t: pair(t, guest_offset=0.5), 1.0, 4.0, _NO_DSP, SERVICE),
    "pair-negative-start": Case(pair, -1.0, 1.0, _NO_DSP, SERVICE),
    "pair-negative-start-wire": Case(pair, -1.0, 1.0),
    "pair-subsecond-window": Case(pair, 0.5, 0.75, _NO_DSP, SERVICE),
    "skew-over": Case(skewed(0.25), 5.0, 7.0, _NO_DSP, SERVICE),
    "skew-over-dsp": Case(skewed(0.25), 5.0, 7.0),
    "skew-over-full": Case(skewed(0.25), 5.0, 7.0, _FULL),
    "skew-under-threshold": Case(
        skewed(0.25), 5.0, 7.0, {"skew_warn_sec": 0.5, "include_dsp": False}, SERVICE
    ),
    "skew-under-threshold-wire": Case(skewed(0.25), 5.0, 7.0, {"skew_warn_sec": 0.5}),
    "skew-at-threshold": Case(
        skewed(0.25), 5.0, 7.0, {"skew_warn_sec": 0.25, "include_dsp": False}, SERVICE
    ),
    "skew-just-over-threshold": Case(
        skewed(0.25), 5.0, 7.0, {"skew_warn_sec": 0.249, "include_dsp": False}, SERVICE
    ),
    "skew-tiny": Case(skewed(0.03), 5.0, 7.0, _NO_DSP, SERVICE),
    "skew-tiny-strict-threshold": Case(
        skewed(0.03), 5.0, 7.0, {"skew_warn_sec": 0.01, "include_dsp": False}, SERVICE
    ),
    "skew-before-the-shift": Case(skewed(0.25), 1.0, 3.0, _NO_DSP, SERVICE),
    "stems-none": Case(pair_with_stems("none", "none"), 0.0, 4.0, _NO_DSP, SERVICE),
    "stems-fresh": Case(pair_with_stems("fresh", "fresh"), 0.0, 4.0, _NO_DSP, SERVICE),
    "stems-fresh-dsp": Case(pair_with_stems("fresh", "fresh"), 0.0, 4.0),
    "stems-mixed": Case(pair_with_stems("fresh", "stale"), 0.0, 4.0, _NO_DSP, SERVICE),
    "stems-stale": Case(pair_with_stems("stale", "stale"), 0.0, 4.0, _NO_DSP, SERVICE),
    "stems-stale-dsp": Case(pair_with_stems("stale", "stale"), 0.0, 4.0),
    "whisper-only": Case(whisper_only, 0.0, 4.0, _NO_DSP, SERVICE),
    "whisper-only-full": Case(whisper_only, 0.0, 4.0, _FULL),
    "suppressed-only": Case(suppressed, 0.0, 4.0, _NO_DSP, SERVICE),
    "suppressed-only-full": Case(suppressed, 0.0, 4.0, _FULL_NO_DSP, SERVICE),
    "partly-suppressed": Case(partly_suppressed, 0.0, 4.0, _NO_DSP, SERVICE),
    "muted-track-speaking": Case(muted_speaking, 0.0, 4.0, _NO_DSP, SERVICE),
    "muted-track-speaking-dsp": Case(muted_speaking, 0.0, 4.0),
    "uneven-density": Case(uneven, 0.0, 4.0, _NO_DSP, SERVICE),
    "uneven-density-wire": Case(uneven, 0.0, 4.0),
    "long-caption-truncated": Case(long_text, 0.0, 4.0, _NO_DSP, SERVICE),
    "effects-comments": Case(effects_and_comments, 1.0, 4.0, _NO_DSP, SERVICE),
    "effects-comments-full": Case(effects_and_comments, 1.0, 4.0, _FULL_NO_DSP, SERVICE),
    "effects-comments-wire": Case(effects_and_comments, 1.0, 4.0),
    "effects-comments-full-wire": Case(effects_and_comments, 1.0, 4.0, _FULL),
    "comments-outside-window": Case(effects_and_comments, 5.0, 6.0, _NO_DSP, SERVICE),
    "aux-summary": Case(aux_tracks, 1.5, 3.5, _NO_DSP, SERVICE),
    "aux-full": Case(aux_tracks, 1.5, 3.5, _FULL_NO_DSP, SERVICE),
    "aux-gap": Case(aux_tracks, 4.5, 5.0, _NO_DSP, SERVICE),
    "aux-wire": Case(aux_tracks, 1.5, 3.5),
    "hum-window": Case(hum_and_clipping, 2.5, 4.5),
    "clipping-window": Case(hum_and_clipping, 7.5, 9.5),
    "hum-and-clipping-full": Case(hum_and_clipping, 2.0, 10.0, _FULL),
    "clean-window": Case(hum_and_clipping, 10.5, 11.5),
    "hum-window-no-dsp": Case(hum_and_clipping, 2.5, 4.5, _NO_DSP, SERVICE),
    "dsp-window-too-long": Case(pair, 0.0, 70.0),
    "dsp-window-too-long-no-dsp": Case(pair, 0.0, 70.0, _NO_DSP, SERVICE),
    "dsp-media-missing": Case(media_missing, 0.0, 4.0),
    "crossing-one-track": Case(crossing_one_track, 0.0, 1.5),
    "crossing-one-track-full": Case(crossing_one_track, 0.0, 1.5, _FULL),
    "crossing-one-track-no-dsp": Case(crossing_one_track, 0.0, 1.5, _NO_DSP, SERVICE),
    "crossing-two-tracks": Case(crossing_two_tracks, 0.0, 1.5),
    "crossing-other-window": Case(crossing_one_track, 2.0, 2.5),
    "echo-risk": Case(echo("fresh"), 3.0, 6.0),
    "echo-risk-full": Case(echo("fresh"), 3.0, 6.0, _FULL),
    "echo-risk-no-dsp": Case(echo("fresh"), 3.0, 6.0, _NO_DSP, SERVICE),
    "echo-stale-stems": Case(echo("stale"), 3.0, 6.0),
    "echo-no-stems": Case(echo("none"), 3.0, 6.0),
    "echo-long-delay": Case(echo_long_delay, 1.0, 5.0),
    "speaker-roles-full": Case(pair, 0.0, 4.0, _FULL_NO_DSP, SERVICE, setup=speaker_roles),
    "speaker-roles-summary": Case(pair, 0.0, 4.0, _NO_DSP, SERVICE, setup=speaker_roles),
    "pending-held-and-clean": Case(
        with_pending(review("held", 1.2, 1.6), review("ok", 4.0, 4.4)), 0.0, 5.9, _NO_DSP, SERVICE
    ),
    "pending-held-and-clean-full": Case(
        with_pending(review("held", 1.2, 1.6), review("ok", 4.0, 4.4)),
        0.0,
        5.9,
        _FULL_NO_DSP,
        SERVICE,
    ),
    "pending-held-and-clean-wire": Case(
        with_pending(review("held", 1.2, 1.6), review("ok", 4.0, 4.4)), 0.0, 5.9
    ),
    "pending-held-and-clean-full-wire": Case(
        with_pending(review("held", 1.2, 1.6), review("ok", 4.0, 4.4)), 0.0, 5.9, _FULL
    ),
    "pending-window-excludes-held": Case(
        with_pending(review("held", 1.2, 1.6), review("ok", 4.0, 4.4), auto("auto", 5.5, 5.7)),
        3.5,
        5.0,
        _NO_DSP,
        SERVICE,
    ),
    "pending-neighbour-of-held": Case(
        with_pending(review("held", 1.2, 1.6), review("near", 1.8, 2.0), review("ok", 4.0, 4.4)),
        1.7,
        2.1,
        _NO_DSP,
        SERVICE,
    ),
    "pending-no-review-flag": Case(
        with_pending(auto("auto", 4.0, 4.4)), 3.0, 5.0, _NO_DSP, SERVICE
    ),
    "pending-outside-window": Case(
        with_pending(review("ok", 4.0, 4.4)), 0.0, 1.0, _NO_DSP, SERVICE
    ),
    "pending-unreadable-check": Case(
        with_pending(review("held", 1.2, 1.6), review("ok", 4.0, 4.4)),
        0.0,
        5.9,
        _NO_DSP,
        SERVICE,
        setup=unreadable_check,
    ),
    "pending-unreadable-check-wire": Case(
        with_pending(review("held", 1.2, 1.6)), 0.0, 5.9, setup=unreadable_check
    ),
    "pending-acoustic-filler": Case(
        with_pending(review("gap", 5.0, 5.4, reason="filler:acoustic")),
        4.0,
        6.0,
        _NO_DSP,
        SERVICE,
    ),
    "pending-acoustic-filler-risky-full": Case(
        with_pending(review("gap", 5.0, 5.4, reason="filler:acoustic:risky", cut_confidence=0.4)),
        4.0,
        6.0,
        _FULL_NO_DSP,
        SERVICE,
    ),
    "applied-and-pending": Case(
        with_pending(review("ok", 4.0, 4.4), applied=True), 0.5, 5.0, _NO_DSP, SERVICE
    ),
    "applied-and-pending-full": Case(
        with_pending(review("ok", 4.0, 4.4), applied=True), 0.5, 5.0, _FULL_NO_DSP, SERVICE
    ),
    "applied-only": Case(with_pending(applied=True), 0.5, 2.0, _NO_DSP, SERVICE),
    "applied-only-full": Case(with_pending(applied=True), 0.5, 2.0, _FULL_NO_DSP, SERVICE),
    "applied-and-pending-wire": Case(with_pending(review("ok", 4.0, 4.4), applied=True), 0.5, 5.0),
    "applied-outside-window": Case(with_pending(applied=True), 3.0, 4.0, _NO_DSP, SERVICE),
    "visual-hum": Case(hum_and_clipping, 2.5, 4.5, {"detail": "visual"}),
    "visual-clipping": Case(hum_and_clipping, 7.5, 9.5, {"detail": "visual"}),
    "visual-no-dsp": Case(pair, 0.0, 4.0, {"detail": "visual", "include_dsp": False}, SERVICE),
    "visual-empty-project": Case(empty, 0.0, 2.0, {"detail": "visual"}),
    "visual-events": Case(visual_events, 1.0, 5.0, {"detail": "visual"}),
    "visual-echo": Case(echo("fresh"), 3.0, 6.0, {"detail": "visual"}),
    "visual-crossing": Case(crossing_one_track, 0.0, 1.5, {"detail": "visual"}),
    "visual-too-long": Case(pair, 0.0, 70.0, {"detail": "visual"}),
    "prosody-missing": Case(pair, 0.0, 4.0, _NO_DSP, SERVICE),
    "prosody-both-fresh": Case(prosody_both, 0.0, 4.0, _NO_DSP, SERVICE),
    "prosody-both-fresh-wire": Case(prosody_both, 0.0, 4.0),
    "prosody-both-fresh-full": Case(prosody_both, 0.0, 4.0, _FULL),
    "prosody-host-only": Case(prosody_host_only, 0.0, 4.0, _NO_DSP, SERVICE),
    "prosody-one-segment": Case(prosody_both, 0.0, 1.5, _NO_DSP, SERVICE),
    "prosody-outside-segments": Case(prosody_both, 5.0, 6.0, _NO_DSP, SERVICE),
    "prosody-stale-words": Case(prosody_retimed, 0.0, 4.0, _NO_DSP, SERVICE),
    "prosody-truncated": Case(prosody_crowded, 0.0, 16.0, _NO_DSP, SERVICE),
}


def _profiled(
    tmp: Path,
    specs: list[TrackSpec],
    seeds: dict[str, Any],
    *,
    mutate: Callable[[Any], None] | None = None,
) -> ProjectWorkspace:
    from play_compose_wire_helpers import seed_profile

    ws = open_workspace(build_project(tmp, specs), specs)
    for tag, (tid, segments) in enumerate(seeds.items()):
        kwargs = {}
        if isinstance(segments, tuple):
            segments, kwargs = segments
        seed_profile(ws.project, tid, segments, tag=f"{tag:x}", **kwargs)
    if mutate is not None:
        project = ws.project
        mutate(project)
        from podcast_mcp.models import save_project

        save_project(project, ws.path)
    return ProjectWorkspace.open(ws.path)


def _segs(*spans: tuple[float, float]) -> list[dict[str, Any]]:
    from play_compose_wire_helpers import profile_segment

    return [
        profile_segment(a, b, word=w)
        for (a, b), w in zip(spans, ("hello", "world", "again", "there"), strict=False)
    ]


def pro_empty(tmp: Path) -> ProjectWorkspace:
    return _profiled(tmp, [], {})


def pro_music_only(tmp: Path) -> ProjectWorkspace:
    specs = [TrackSpec("bed", voice(8.0, 0.2, 7.8), role=TrackRole.MUSIC)]
    return _profiled(tmp, specs, {})


def pro_one_missing(tmp: Path) -> ProjectWorkspace:
    return _profiled(tmp, dialogue_pair()[:1], {})


def pro_one_fresh(tmp: Path) -> ProjectWorkspace:
    return _profiled(tmp, dialogue_pair()[:1], {"host": _segs((0.0, 2.0))})


def pro_one_three_segments(tmp: Path) -> ProjectWorkspace:
    return _profiled(tmp, dialogue_pair()[:1], {"host": _segs((0.0, 2.0), (2.0, 3.0), (3.5, 5.0))})


def pro_two_fresh(tmp: Path) -> ProjectWorkspace:
    return _profiled(
        tmp, dialogue_pair(), {"host": _segs((0.0, 2.0)), "guest": _segs((0.5, 2.5), (3.0, 4.0))}
    )


def pro_two_one_missing(tmp: Path) -> ProjectWorkspace:
    return _profiled(tmp, dialogue_pair(), {"guest": _segs((0.5, 2.5))})


def pro_two_missing(tmp: Path) -> ProjectWorkspace:
    return _profiled(tmp, dialogue_pair(), {})


def pro_mixed_statuses(tmp: Path) -> ProjectWorkspace:
    specs = [*dialogue_pair(), TrackSpec("third", voice(8.0, 0.4, 7.5, f0=260.0), words=[])]

    def mutate(project: Any) -> None:
        project.transcript_for_track("guest").words[0].start = 0.55

    ws = _profiled(
        tmp,
        specs,
        {"host": _segs((0.0, 2.0)), "guest": _segs((0.5, 2.5)), "third": _segs((0.0, 1.0))},
        mutate=mutate,
    )
    cache = next((ws.project.transcripts_dir() / "prosody").glob("third_*.json"))
    import json

    payload = json.loads(cache.read_text())
    payload["segments"] = [{"end": 1.0}]
    cache.write_text(json.dumps(payload))
    return ws


def pro_engine_changed(tmp: Path) -> ProjectWorkspace:
    from play_compose_wire_helpers import profile_segment

    specs = dialogue_pair()[:1]
    return _profiled(tmp, specs, {"host": ([profile_segment(0.0, 2.0)], {"algorithm_version": 0})})


def pro_cut_clips(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()[:1]
    specs[0].clips = [(0.0, 1.0, 0.0), (1.5, 8.0, 1.0)]
    return _profiled(tmp, specs, {"host": _segs((0.0, 2.0), (2.0, 4.0))})


def pro_segment_cut_away(tmp: Path) -> ProjectWorkspace:
    specs = dialogue_pair()[:1]
    specs[0].clips = [(0.0, 1.0, 0.0), (5.0, 8.0, 1.0)]
    return _profiled(tmp, specs, {"host": _segs((0.0, 2.0), (2.0, 4.0))})


def pro_sparse_segment(tmp: Path) -> ProjectWorkspace:
    from play_compose_wire_helpers import profile_segment

    sparse = profile_segment(0.0, 2.0, word=None, energy={}, boundaries=[{"time": 1.0}])
    return _profiled(tmp, dialogue_pair()[:1], {"host": [sparse]})


def pro_unmatched_word(tmp: Path) -> ProjectWorkspace:
    from play_compose_wire_helpers import profile_segment

    segment = profile_segment(0.0, 2.0, word="nothing")
    segment["prominent_words"].append({"text": "world", "start": 2.52, "end": 2.9, "score": 0.5})
    segment["prominent_words"].append({"text": "gone", "start": 9.5, "end": 9.9, "score": 0.2})
    return _profiled(tmp, dialogue_pair()[:1], {"host": [segment]})


def pro_no_media(tmp: Path) -> ProjectWorkspace:
    def mutate(project: Any) -> None:
        project.track_by_id("host").media = None

    return _profiled(tmp, dialogue_pair()[:1], {"host": _segs((0.0, 2.0))}, mutate=mutate)


def pro_wordless(tmp: Path) -> ProjectWorkspace:
    specs = [TrackSpec("host", voice(8.0, 0.4, 7.5))]
    return _profiled(tmp, specs, {"host": _segs((0.0, 2.0))})


def staged_params(monkeypatch: Any, ws: ProjectWorkspace) -> None:
    from podcast_mcp.engines.prosody import ProsodyParams

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.prosody_params_for",
        lambda _path: ProsodyParams(pitch_floor_hz=90.0),
    )


PROSODY_CASES: dict[str, Case] = {
    "empty-project": Case(pro_empty, 0, 0),
    "music-only": Case(pro_music_only, 0, 0),
    "one-track-missing": Case(pro_one_missing, 0, 0),
    "one-track-fresh": Case(pro_one_fresh, 0, 0),
    "one-track-three-segments": Case(pro_one_three_segments, 0, 0),
    "two-tracks-fresh": Case(pro_two_fresh, 0, 0),
    "two-tracks-one-missing": Case(pro_two_one_missing, 0, 0),
    "two-tracks-missing": Case(pro_two_missing, 0, 0),
    "three-tracks-mixed-statuses": Case(pro_mixed_statuses, 0, 0),
    "engine-changed": Case(pro_engine_changed, 0, 0),
    "staged-params-differ": Case(pro_two_fresh, 0, 0, setup=staged_params),
    "cut-clips": Case(pro_cut_clips, 0, 0),
    "segment-cut-away": Case(pro_segment_cut_away, 0, 0),
    "sparse-segment": Case(pro_sparse_segment, 0, 0),
    "unmatched-words": Case(pro_unmatched_word, 0, 0),
    "track-without-media": Case(pro_no_media, 0, 0),
    "wordless-track": Case(pro_wordless, 0, 0),
}
