from __future__ import annotations

import ast
from pathlib import Path

import pytest

from pause_policy_public_helpers import configure, defaults, room, voice, write_wav
from podcast_mcp.edits import cut_safety
from podcast_mcp.edits.cut_safety import CutScopeHold
from podcast_mcp.edits.ripple import RippleRemoval
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval, record_suggested_cut_speech
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.models import (
    Clip,
    CutSpeech,
    CutSpeechTrack,
    CutSpeechWord,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.util.coded_error import CodedValueError


def _workspace(tmp_path: Path) -> ProjectWorkspace:
    project = EpisodeProject.create("source removal", str(tmp_path))
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=6.0),
        )
        for tid in ("host", "guest")
    ]
    project.clips = [
        Clip(id=tid, track_id=tid, source_start=0, source_end=6, timeline_start=0)
        for tid in ("host", "guest")
    ]
    project.timeline.duration_sec = 6
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=0, end=0.2),
                TranscriptWord(text="after", start=5, end=5.2),
            ],
        )
    ]
    save_project(project, tmp_path / "episode.project.json")
    mark_refine_done(project, notes="Inspected literal source fixture")
    return ProjectWorkspace.open(tmp_path / "episode.project.json")


def _cut(edit_id: str = "cut", *, reason: str = "filler:um", scope: str = "session"):
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1,
        end=2,
        boundary_mode="exact",
        review_required=False,
        applied=False,
        scope=scope,
        reason=reason,
    )


def test_record_suggested_cut_speech_ignores_mute_without_remove_placement():
    project = EpisodeProject.create("pure source removal", "/tmp/fix1508-pure")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="host-clip", track_id="host", source_start=0, source_end=6, timeline_start=0)
    ]
    mute = EditDecision(
        id="mute",
        track_id="host",
        type=EditDecisionType.MUTE,
        start=1,
        end=2,
        reason="filler:um",
        applied=False,
    )

    record_suggested_cut_speech(project, mute)

    assert mute.cut_speech is None


def test_record_suggested_cut_speech_annotates_a_valid_remove(monkeypatch):
    project = EpisodeProject.create("pure source removal", "/tmp/fix1508-pure")
    project.tracks = [
        Track(id=tid, label=tid.title(), role=TrackRole.DIALOGUE) for tid in ("host", "guest")
    ]
    project.clips = [
        Clip(id=f"{tid}-clip", track_id=tid, source_start=0, source_end=6, timeline_start=0)
        for tid in ("host", "guest")
    ]
    decision = _cut()
    expected = CutSpeech(
        spans=[RangeInterval(start=1, end=2)],
        tracks=[
            CutSpeechTrack(
                track_id="guest",
                speaker="Guest",
                words=[CutSpeechWord(text="hello", timeline_start=1.2, timeline_end=1.5)],
            )
        ],
    )
    observed: list[tuple[EpisodeProject, tuple[tuple[float, float], ...], frozenset[str]]] = []

    def assess(project_arg: EpisodeProject, removal: RippleRemoval) -> CutSpeech:
        observed.append((project_arg, removal.spans, removal.edited_track_ids))
        return expected

    monkeypatch.setattr("podcast_mcp.edits.source_removals.assess_cut_speech", assess)

    record_suggested_cut_speech(project, decision)

    assert observed == [(project, ((1.0, 2.0),), frozenset({"host"}))]
    assert decision.cut_speech == expected


def _restricted_cut_access(code: str) -> set[str]:
    restricted = {
        "podcast_mcp.edits.breath_detect.protect_cut_breaths",
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech",
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        "podcast_mcp.edits.join_continuity.assess_proposed_cut",
        "podcast_mcp.edits.source_removals.inspect_source_remove_placement",
        "podcast_mcp.edits.source_removals._inspect_source_remove_placement_impl",
        "podcast_mcp.edits.source_removals._witnessed_source_span_has_unsafe_overlap",
        "podcast_mcp.edits.fillers._original_pause_support",
        "podcast_mcp.edits.cut_speech.clear_ripple",
    }
    tree = ast.parse(code)
    aliases: dict[str, str] = {}
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                qualified = f"{node.module}.{alias.name}"
                aliases[alias.asname or alias.name] = qualified
                if qualified in restricted:
                    found.add(qualified)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name.split(".")[0]] = (
                    alias.name if alias.asname else alias.name.split(".")[0]
                )

    def qualified_name(node: ast.expr) -> str:
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            return f"{qualified_name(node.value)}.{node.attr}"
        return ""

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            qualified = qualified_name(node)
            if qualified in restricted:
                found.add(qualified)
    return found


def test_cut_safety_boundary_owns_remove_placement_and_guard_imports():
    source = Path(__file__).parents[1] / "src/podcast_mcp"
    consumers = {
        str(path.relative_to(source)): hits
        for path in source.rglob("*.py")
        if (hits := _restricted_cut_access(path.read_text(encoding="utf-8")))
    }
    assert consumers == {}
    for code in (
        "from podcast_mcp.edits.breath_detect import protect_cut_breaths as protect",
        "from podcast_mcp.edits.speech_energy_guard import assess_cross_track_speech as assess",
        "import podcast_mcp.edits.join_continuity as joins; joins.assess_proposed_cut()",
        "from podcast_mcp.edits import source_removals as cuts; cuts.inspect_source_remove_placement()",
        "import podcast_mcp.edits.source_removals; podcast_mcp.edits.source_removals._inspect_source_remove_placement_impl()",
        "from podcast_mcp.edits.source_removals import _witnessed_source_span_has_unsafe_overlap",
        "from podcast_mcp.edits.fillers import _original_pause_support",
    ):
        assert _restricted_cut_access(code), code
    definitions = []
    for path in (source / "edits").glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        definitions.extend(
            (node.name, path.name)
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name
            in {
                "inspect_source_remove_placement",
                "protect_cut_breaths",
                "assess_cross_track_speech",
                "assess_proposed_cut",
                "original_pause_support",
            }
        )
    assert sorted(definitions) == [
        (name, "cut_safety.py")
        for name in sorted(
            {
                "inspect_source_remove_placement",
                "protect_cut_breaths",
                "assess_cross_track_speech",
                "assess_proposed_cut",
                "original_pause_support",
            }
        )
    ]

    project = EpisodeProject.create("pure source removal", "/tmp/fix1508-pure")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="host-clip", track_id="host", source_start=0, source_end=6, timeline_start=0)
    ]
    mute = EditDecision(
        id="mute",
        track_id="host",
        type=EditDecisionType.MUTE,
        start=1,
        end=2,
        applied=False,
    )
    remove = mute.model_copy(update={"id": "remove", "type": EditDecisionType.REMOVE})

    with pytest.raises(ValueError, match="ordinary source remove required"):
        cut_safety.inspect_source_remove_placement(project, mute)
    assert cut_safety.inspect_source_remove_placement(project, remove) == (1, 2)


def _replay(project: EpisodeProject) -> None:
    project.clips.append(
        Clip(id="replay", track_id="host", source_start=1, source_end=2, timeline_start=6)
    )
    project.clips[1].source_end = 7
    project.timeline.duration_sec = 7


@pytest.mark.parametrize("reason", ["filler:um", "nl:range", "focus", "repeat:test"])
@pytest.mark.parametrize("scope", ["session", "track"])
def test_saved_ordinary_remove_refuses_replayed_source(tmp_path: Path, reason: str, scope: str):
    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        _replay(project)
        project.edit_decisions = [_cut(reason=reason, scope=scope)]

    ws.mutate("before replay", "after replay", setup)
    assert isinstance(
        cut_safety.inspect_source_remove_placement(ws.project, ws.project.edit_decisions[0]),
        CutScopeHold,
    )
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"], confirm_cut_speech=True)
    assert held.value.ids == ("cut",)
    assert ws.path.read_bytes() == before
    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == 7
    assert [(c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == [
        (0, 6, 0),
        (0, 7, 0),
        (1, 2, 6),
    ]
    assert [e.id for e in saved.edit_decisions] == ["cut"]


def test_saved_track_pause_cannot_punch(tmp_path: Path):
    ws = _workspace(tmp_path)
    ws.mutate(
        "before pause",
        "after pause",
        lambda p: setattr(p, "edit_decisions", [_cut(reason="pause:4.80s", scope="track")]),
    )
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"])
    assert held.value.ids == ("cut",)
    assert ws.path.read_bytes() == before
    assert {
        tid: sum(c.source_end - c.source_start for c in ws.project.clips if c.track_id == tid)
        for tid in ("host", "guest")
    } == {"host": 6, "guest": 6}


def test_saved_batch_rolls_back_valid_remove_when_later_geometry_holds(tmp_path: Path):
    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        _replay(project)
        valid = _cut("valid")
        valid.start, valid.end = 3, 4
        project.edit_decisions = [_cut(), valid]

    ws.mutate("before batch", "after batch", setup)
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval):
        EditService(ws).approve(["valid", "cut"])
    assert ws.path.read_bytes() == before
    assert [w.text for w in ws.project.transcripts[0].words] == ["before", "after"]
    assert [e.id for e in ws.project.edit_decisions] == ["cut", "valid"]


def test_pause_proposal_after_hole_drops_crossing_span_and_keeps_safe_control(tmp_path: Path):
    ws = _workspace(tmp_path)
    prior = _cut("prior", reason="nl:range")
    prior.start, prior.end = 0.7, 4
    ws.mutate("before prior", "after prior", lambda p: p.edit_decisions.append(prior))
    assert EditService(ws).approve(["prior"]) == 1
    cfg = {
        "tighten": {
            "inaudible_opt": False,
            "leave_in_if_risky": False,
            "join_continuity_gate": False,
            "filler_words": [],
            "repetition_candidates": False,
            "acoustic_gap_filler": {"enabled": False},
            "breath_handling": {"enabled": False},
            "speech_energy_guard": {"enabled": False},
        },
        "performance": {"max_workers": 1},
    }
    proposal = propose_tighten_edits(ws.project, cfg, intensity="aggressive")
    assert proposal.decisions == []
    assert proposal.skip_counts.get("no_air") == 1
    from podcast_mcp.edits.cut_safety import CutScopeHold
    from podcast_mcp.edits.source_removals import inspect_source_remove

    crossing = _cut("crossing", reason="pause:4.80s")
    crossing.start, crossing.end = 0.2, 4.7
    assessed = inspect_source_remove(ws.project, crossing)
    assert isinstance(assessed, CutScopeHold)
    assert assessed.reason == "source_geometry"
    control_workspace = _workspace(tmp_path / "control")
    for tid in ("host", "guest"):
        audio = room(seed=1510 if tid == "host" else 1511)
        voice(audio, 0, 0.2)
        voice(audio, 5, 5.2)
        write_wav(tmp_path / "control" / f"raw/{tid}.wav", audio)
    control = propose_tighten_edits(control_workspace.project, cfg, intensity="aggressive")
    assert [(d.start, d.end, d.scope) for d in control.decisions] == [(0.2, 4.7, "session")]


def test_saved_known_finite_identity_lane_remove_materializes_real_clips(tmp_path: Path):
    ws = _workspace(tmp_path)
    ws.mutate("before identity", "after identity", lambda p: setattr(p, "clips", []))
    assert EditService(ws).suggest_pending_edit("host", 1, 2)["scope"] == "session"
    edit_id = ws.project.edit_decisions[0].id
    assert EditService(ws).approve([edit_id]) == 1
    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == 5
    assert {
        tid: [
            (c.source_start, c.source_end, c.timeline_start)
            for c in saved.clips
            if c.track_id == tid
        ]
        for tid in ("host", "guest")
    } == {"host": [(0, 1, 0), (2, 6, 1)], "guest": [(0, 1, 0), (2, 6, 1)]}


@pytest.mark.parametrize("empty", [False, True])
def test_saved_unresolved_or_intentionally_empty_identity_remove_holds(tmp_path: Path, empty: bool):
    ws = _workspace(tmp_path)

    # Saved directly: a mutation would retire the proposal this test needs to hold (#1487).
    ws.project.clips = []
    ws.project.tracks[0].timeline_empty = empty
    if not empty:
        ws.project.tracks[0].media.duration_sec = None
    ws.project.edit_decisions = [_cut()]
    ws.save()
    before = ws.path.read_bytes()
    if empty:
        # No clip plays the span, so approval refuses the proposal outright (#1487).
        with pytest.raises(CodedValueError) as refused:
            EditService(ws).approve(["cut"])
        assert refused.value.code == "edit_span_not_played"
    else:
        with pytest.raises(ScopeChangedAtApproval) as held:
            EditService(ws).approve(["cut"])
        assert held.value.held[0].reason == "media_extent_unavailable"
    assert ws.path.read_bytes() == before
    assert ws.project.clips == []
    assert [e.id for e in ws.project.edit_decisions] == ["cut"]


@pytest.mark.parametrize("unsafe", [False, True])
@pytest.mark.parametrize("scope", ["session", "track"])
def test_saved_final_optimizer_window_closes_over_origin_media(
    tmp_path: Path, monkeypatch, unsafe: bool, scope: str
):
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        project.edit_decisions = [_cut(scope=scope)]
        if unsafe:
            project.clips.append(
                Clip(
                    id="edge-replay",
                    track_id="host",
                    source_start=0.8,
                    source_end=1,
                    timeline_start=6,
                )
            )
            project.clips[1].source_end = 6.2
            project.timeline.duration_sec = 6.2

    ws.mutate("before optimizer", "after optimizer", setup)
    monkeypatch.setattr(
        "podcast_mcp.edits.timeline_ops._optimized_ripple_span",
        lambda *_args: (0.8, 2.2),
    )
    monkeypatch.setattr(
        "podcast_mcp.edits.source_removals.optimize_timeline_cut_range",
        lambda *_args, **_kwargs: OptimizedCutRange(
            start=0.8,
            end=2.2,
            mode="exact",
            shifted_start_ms=-200,
            shifted_end_ms=200,
            confidence=1,
            details={},
        ),
    )
    before = ws.path.read_bytes()
    if unsafe:
        with pytest.raises(ScopeChangedAtApproval):
            EditService(ws).approve(["cut"])
        assert ws.path.read_bytes() == before
        assert ws.project.timeline.duration_sec == 6.2
    else:
        assert EditService(ws).approve(["cut"]) == 1
        saved = load_project(ws.path)
        record = saved.editorial.edit_log[-1]
        assert (record.source_start, record.source_end) == pytest.approx((0.8, 2.2))
        assert (record.timeline_start, record.timeline_end) == pytest.approx((0.8, 2.2))
        assert saved.timeline.duration_sec == pytest.approx(4.6 if scope == "session" else 6)
        assert [
            (c.source_start, c.source_end, c.timeline_start)
            for c in saved.clips
            if c.track_id == "host"
        ] == [(0, 0.8, 0), (2.2, 6, 0.8 if scope == "session" else 2.2)]


@pytest.mark.parametrize("cause", ["peer_speech", "speaker_bleed", "scope_unavailable"])
def test_saved_scope_holds_keep_real_cause_and_audio(tmp_path: Path, monkeypatch, cause: str):
    from podcast_mcp.edits.cut_safety import CutScopeUnavailable, ResolvedCutScope
    from podcast_mcp.edits.speech_energy_guard import SpeechEnergyGuardResult

    ws = _workspace(tmp_path)
    ws.mutate("before pending", "after pending", lambda p: p.edit_decisions.append(_cut()))
    guard = SpeechEnergyGuardResult(("guest",), "review") if cause == "peer_speech" else None
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_safety.resolve_cut_scope",
        lambda *_args, **_kwargs: (
            CutScopeUnavailable()
            if cause == "scope_unavailable"
            else ResolvedCutScope(cause, guard)
        ),
    )
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"])
    assert held.value.held[0].reason == cause
    assert held.value.ids == ("cut",)
    assert ws.path.read_bytes() == before
    assert [(c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips] == [
        (0, 6, 0),
        (0, 6, 0),
    ]


@pytest.mark.parametrize("pad", [0.1, 1.0, 1.2])
def test_saved_pause_rechecks_original_floor_instead_of_stored_pad(
    tmp_path: Path, monkeypatch, pad: float
):
    cfg = defaults(acoustic=True)
    configure(monkeypatch, cfg)
    ws = _workspace(tmp_path)
    host = room(seed=1510)
    voice(host, 0, 0.2)
    voice(host, 5, 5.2)
    voice(host, 5.4, 5.8)
    write_wav(tmp_path / "raw/host.wav", host)
    guest = room(seed=1511)
    voice(guest, 0, 0.2)
    voice(guest, 5, 5.2)
    voice(guest, 5.4, 5.8)
    write_wav(tmp_path / "raw/guest.wav", guest)
    ws.project.transcripts[0].words.append(TranscriptWord(text="reference", start=5.4, end=5.8))
    ws.project.transcripts.append(
        Transcript(
            track_id="guest",
            words=[w.model_copy(deep=True) for w in ws.project.transcripts[0].words],
        )
    )
    pause = _cut(reason="pause:4.80s")
    pause.replace_gap_sec = pad
    ws.mutate("before pause", "after pause", lambda p: p.edit_decisions.append(pause))

    assert EditService(ws).approve(["cut"]) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == pytest.approx(5)
    record = saved.editorial.edit_log[-1]
    assert (record.source_start, record.source_end) == pytest.approx((1, 2))
    assert record.params["loss_sec"] == pytest.approx(1)
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []
    assert saved.edit_decisions == []

    cfg["tighten"].update(min_retained_pause_sec=5, min_retained_solo_pause_sec=5)
    held_pause = _cut("held", reason="pause:3.80s")
    held_pause.start, held_pause.end, held_pause.replace_gap_sec = 2.5, 3.5, pad
    ws.mutate(
        "before held pause", "after held pause", lambda p: p.edit_decisions.append(held_pause)
    )
    before = ws.path.read_bytes()
    before_model = ws.project.model_dump(mode="json")
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["held"])
    assert (held.value.held[0].reason, held.value.held[0].detail) == ("pause_air", "no_air")
    assert ws.path.read_bytes() == before
    assert ws.project.model_dump(mode="json") == before_model
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["held"]


def test_saved_auto_holds_replay_and_applies_unique_survivor_once(tmp_path: Path):
    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        _replay(project)
        valid = _cut("valid")
        valid.start, valid.end = 3, 4
        project.edit_decisions = [_cut(), valid]

    ws.mutate("before auto", "after auto", setup)
    assert EditService(ws).apply_auto() == 1
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["cut"]
    assert saved.timeline.duration_sec == 6
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["valid"]]
    assert EditService(ws).apply_auto() == 0
    assert [e.id for e in ws.project.edit_decisions] == ["cut"]
    assert ws.project.timeline.duration_sec == 6


def test_saved_auto_restarts_after_fresh_scope_hold_without_duplicate_survivor(
    tmp_path: Path, monkeypatch
):
    from podcast_mcp.edits.cut_safety import ResolvedCutScope

    ws = _workspace(tmp_path)
    late = _cut("late")
    late.start, late.end = 3, 4
    ws.mutate("before auto", "after auto", lambda p: setattr(p, "edit_decisions", [_cut(), late]))
    observed_durations: set[float] = set()

    def scope(project, _track_id, start, _end, **_kwargs):
        if start == 1:
            observed_durations.add(project.timeline.duration_sec)
            if project.timeline.duration_sec == 5:
                return ResolvedCutScope("speaker_bleed")
        return ResolvedCutScope("session_clear")

    monkeypatch.setattr("podcast_mcp.edits.cut_safety.resolve_cut_scope", scope)
    assert EditService(ws).apply_auto() == 1
    saved = load_project(ws.path)
    assert observed_durations == {5}
    assert [e.id for e in saved.edit_decisions] == ["cut"]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["late"]]
    assert saved.timeline.duration_sec == 5
    assert [(c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == [
        (0, 3, 0),
        (4, 6, 3),
        (0, 3, 0),
        (4, 6, 3),
    ]


def test_auto_restart_excludes_speech_chosen_only_by_freshly_held_punch(
    tmp_path: Path, monkeypatch
):
    from podcast_mcp.edits.cut_safety import ResolvedCutScope
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    ws = _workspace(tmp_path)
    punch = _cut("punch", scope="track")
    punch.track_id, punch.start, punch.end, punch.boundary_mode = "guest", 4, 5, None

    def setup(project: EpisodeProject):
        project.clips[1].source_start, project.clips[1].source_end = 3, 6
        project.transcripts.append(
            Transcript(
                track_id="guest",
                words=[TranscriptWord(text="chosen", start=4, end=5)],
            )
        )
        project.edit_decisions = [_cut(), punch]

    ws.mutate("before auto", "after auto", setup)
    before = [(c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips]
    assert cut_safety.inspect_source_remove_placement(ws.project, punch) == (1, 2)

    def optimize(_project, _tid, start, _end, **_kwargs):
        return OptimizedCutRange(
            start=start,
            end=4,
            mode="exact",
            shifted_start_ms=0,
            shifted_end_ms=0,
            confidence=1,
            details={},
        )

    monkeypatch.setattr("podcast_mcp.edits.source_removals.optimize_timeline_cut_range", optimize)
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_safety.resolve_cut_scope",
        lambda *_args, **_kwargs: ResolvedCutScope("session_clear"),
    )
    assert EditService(ws).apply_auto() == 0
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["cut", "punch"]
    assert saved.editorial.edit_log == []
    assert [(c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == before
    assert saved.transcripts[1].words[0].text == "chosen"


def test_rejected_generated_merged_hole_preserves_retained_manual_row(tmp_path: Path):
    from podcast_mcp.edits.transcript_cuts import coalesce_edits

    project = _workspace(tmp_path).project
    project.clips = [
        Clip(id="early", track_id="host", source_start=0, source_end=1.4, timeline_start=0),
        Clip(id="late", track_id="host", source_start=1.42, source_end=6, timeline_start=1.4),
    ]
    manual = _cut("manual", reason="nl:range")
    manual.start, manual.end = 0.4, 1.2
    first, second = _cut("first"), _cut("second")
    first.start, first.end = 1.2, 1.4
    second.start, second.end = 1.42, 1.6
    project.edit_decisions = [manual, first, second]
    expected = manual.model_dump()
    skips: dict[str, int] = {}
    coalesce_edits(project, skip_counts=skips, merge_ids={"first", "second"})
    assert [e.model_dump() for e in project.edit_decisions] == [expected]
    assert skips == {"source_geometry": 1}


def test_saved_hold_does_not_promise_batch_restore_when_rollback_is_unknown(
    tmp_path: Path, monkeypatch
):
    from podcast_mcp.history.rollback import RollbackOutcome

    ws = _workspace(tmp_path)
    ws.mutate(
        "before replay", "after replay", lambda p: (_replay(p), p.edit_decisions.append(_cut()))
    )
    monkeypatch.setattr(
        "podcast_mcp.history.rollback.roll_back_history",
        lambda *_args: RollbackOutcome.UNKNOWN,
    )
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"])
    assert held.value.ids == ("cut",)
    assert "None of the selected edits were applied" not in str(held.value)


def test_saved_track_seed_cannot_shrink_away_an_origin_placement_on_another_lane(
    tmp_path: Path, monkeypatch
):
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange
    from podcast_mcp.models.episode import SourceRecording

    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        project.sources.append(SourceRecording(id="host-source", path="raw/host.wav"))
        project.clips[0].source_end = 2
        project.clips.append(
            Clip(
                id="parked-host",
                track_id="guest",
                source_id="host-source",
                source_start=2,
                source_end=6,
                timeline_start=2,
            )
        )
        cut = _cut(scope="track", reason="nl:range")
        cut.end, cut.boundary_mode = 3, None
        project.edit_decisions = [cut]

    ws.mutate("before cross-lane seed", "after cross-lane seed", setup)
    reads = []

    def shrink(*_args, **_kwargs):
        reads.append("optimized")
        return OptimizedCutRange(
            start=1,
            end=1.8,
            mode="exact",
            shifted_start_ms=0,
            shifted_end_ms=-1200,
            confidence=1,
            details={},
        )

    monkeypatch.setattr("podcast_mcp.edits.source_removals.optimize_timeline_cut_range", shrink)
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"])
    assert held.value.held[0].reason == "source_geometry"
    assert reads == []
    assert ws.path.read_bytes() == before
    assert [
        (c.track_id, c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips
    ] == [
        ("host", 0, 2, 0),
        ("guest", 0, 6, 0),
        ("guest", 2, 6, 2),
    ]
