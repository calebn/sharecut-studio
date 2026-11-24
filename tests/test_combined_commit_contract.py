"""Pin ``combined_transcript`` after each command that can rewrite it (#1849 S0).

Every expectation is what ``develop`` does, measured by running the command
(``tests/combined_contract_helpers.py::observe``), not what the design wants. A row changed by a
later slice (S2 hook, S3 call-site deletion) is re-pinned to the measured new behavior and keeps
its id, with ``Case.s2_changes`` or ``Case.s3_untouched`` naming the states that moved. Each command runs through its real entry point from three entry states.

* ``fresh``: combined equals ``merge_transcripts`` of the project.
* ``stale``: combined deliberately differs from the merge (a pipeline that paused at a gate,
  a legacy file, a canned seed).
* ``none``: combined is ``None`` and, for a command that works without words, the project has
  no transcripts at all. A command that edits words keeps its transcripts here, with a ``None``
  combined, because it cannot run without them.

For each, the stored value must agree in memory, in ``episode.sharecut``, in
``transcripts/combined.json``, in the after-history snapshot, and after undo then redo.

Two quirks of today's behavior are named in the ids, because the refactor must either keep or
knowingly change them:

* ``h1`` (normalizing rebuild): a command that moved no merge input still calls
  ``rebuild_combined``, which refreshes a stale combined and turns ``None`` into an empty
  transcript.
* ``h2`` (never rebuilds): a command that changes words but never calls ``rebuild_combined``
  leaves a stale or ``None`` combined as it was.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Literal
from unittest.mock import Mock, patch

import pytest

from combined_contract_helpers import (
    FRESH_TEXTS,
    SOURCE_SEC,
    UNTOUCHED,
    Case,
    Command,
    State,
    assert_channels,
    assert_contract,
    case_params,
    json_of,
    merged,
    observe,
    open_workspace,
    run_case,
    texts,
)
from pause_policy_public_helpers import (
    RATE,
    add_bed,
    pause,
    room,
    voice,
    write_wav,
)
from pause_policy_public_helpers import (
    configure as configure_pause_policy,
)
from pause_policy_public_helpers import defaults as pause_defaults
from podcast_mcp.edits.audio_check_override import audio_check_override
from podcast_mcp.edits.insert_anchor import capture_insert_anchor, capture_range_anchors
from podcast_mcp.edits.range_edits import RangeAction
from podcast_mcp.edits.record_placement import upsert_source
from podcast_mcp.edits.session_suggestions import ensure_session_suggestion
from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.engines.play_audit import write_stem_hash
from podcast_mcp.engines.speaker_id import SpeakerProfile, WindowScore
from podcast_mcp.engines.speaker_split import SpeakerAttribution, SpeakerTurn
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.engines.transcript_sync import rebuild_combined
from podcast_mcp.models import (
    ArchivedTranscriptWord,
    Clip,
    EditDecision,
    EditDecisionType,
    EditMode,
    EpisodeProject,
    ProcessingChain,
    ProcessingEffect,
    SessionSuggestion,
    StagedTake,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project.transcript_context import ReplacementRule, TranscriptContext
from podcast_mcp.project.transcript_context import SpeakerIdConfig as CtxSpeakerIdConfig
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    AnalysisService,
    EditService,
    EpisodeService,
    SessionSuggestionService,
    TimelineService,
    TranscriptService,
    insert_saved_segment,
)
from podcast_mcp.services.document.boundary import (
    RollBoundaryTarget,
    TrimBoundaryTarget,
    boundary_context,
)
from podcast_mcp.services.media import SpeakerService, TranscriptPrecorrectService
from podcast_mcp.services.pipeline import PipelineService, rerender_preview
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.util.hashing import sha256_file
from test_record_start_target import _land, _start_room, _take
from test_segments_insert import _save as _save_segment

SESSION = "a" * 12


def _word_key(track_id: str, index: int) -> dict[str, Any]:
    return {"track_id": track_id, "word_index": index}


def _set_timing(ws: ProjectWorkspace) -> Any:
    target = WordTimingTarget("host", None, 1)
    service = TranscriptService(ws)
    token = service.word_timing_context(target)["expected_token"]
    return service.set_word_timing(target, token, 0.55, 0.95)


def _replace(ws: ProjectWorkspace) -> Any:
    service = TranscriptService(ws)
    token = service.preview_transcript_replacement("welcome", "greetings")["preview_token"]
    return service.replace_transcript_matches("welcome", "greetings", token)


def _every_word_suppressed(project: EpisodeProject) -> None:
    for transcript in project.transcripts:
        for i, word in enumerate(transcript.words):
            transcript.words[i] = word.model_copy(update={"suppressed": True})


WORD_CASES = [
    Case(
        "correct_word",
        lambda ws: TranscriptService(ws).correct_word("host", 0, "HELLO"),
        ("HELLO there friend", "welcome back", "thanks for having me"),
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "correct_phrase",
        lambda ws: TranscriptService(ws).correct_phrase("host", 3, 4, "good day"),
        ("hello there friend", "good day", "thanks for having me"),
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "suppress_word",
        lambda ws: TranscriptService(ws).set_word_suppressed("guest", 3, True),
        ("hello there friend", "welcome back", "thanks for having"),
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "transcript_cleanup",
        lambda ws: TranscriptService(ws).apply_transcript_cleanup(
            "host", words=[{"word_index": 1, "text": "THERE"}]
        ),
        ("hello THERE friend", "welcome back", "thanks for having me"),
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "verify_transcript",
        lambda ws: TranscriptService(ws).verify_transcript(
            "host", [{"word_index": 1, "text": "THERE"}]
        ),
        ("hello THERE friend", "welcome back", "thanks for having me"),
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "word_timing",
        _set_timing,
        FRESH_TEXTS,
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "replace_matches",
        _replace,
        ("hello there friend", "greetings back", "thanks for having me"),
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "suppress_low_audibility_keys",
        lambda ws: AnalysisService(ws).suppress_low_audibility(word_keys=[_word_key("guest", 0)]),
        ("hello there friend", "welcome back", "for having me"),
        s3_changes=True,
    ),
    Case(
        "suppress_bleed_keys",
        lambda ws: AnalysisService(ws).suppress_bleed(word_keys=[_word_key("guest", 1)]),
        ("hello there friend", "welcome back", "thanks having me"),
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "suppress_low_audibility_heuristic",
        lambda ws: AnalysisService(ws).suppress_low_audibility(),
        (),
    ),
    Case(
        "suppress_low_audibility_nothing_to_change",
        lambda ws: AnalysisService(ws).suppress_low_audibility(),
        (),
        arrange=_every_word_suppressed,
        may_commit_nothing=True,
    ),
    Case(
        "suppress_bleed_heuristic_nothing_flagged",
        lambda ws: AnalysisService(ws).suppress_bleed(),
        FRESH_TEXTS,
        s3_changes=True,
        s3_untouched=(State.STALE, State.NONE),
        may_commit_nothing=True,
    ),
    Case(
        "set_words_ignored",
        lambda ws: TranscriptService(ws).set_words_ignored("guest", 3, 3, True),
        FRESH_TEXTS,
        stale=UNTOUCHED,
        none=UNTOUCHED,
        quirk="h2",
        s2_changes=(State.STALE,),
    ),
]


def _host_in_two_clips(project: EpisodeProject) -> None:
    """Host lane as two adjoining clips, so a join can roll."""
    project.timeline.clips = [
        Clip(id="host-l", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="host-r", track_id="host", source_start=5.0, source_end=10.0, timeline_start=5.0),
        *(c for c in project.timeline.clips if c.track_id != "host"),
    ]


def _without_transcripts(project: EpisodeProject) -> None:
    project.transcripts = []


def _trim_out(source_sec: float, mode: EditMode) -> Command:
    def run(ws: ProjectWorkspace) -> Any:
        target = TrimBoundaryTarget(clip_id="host-1", edge="out", mode=mode)
        token = boundary_context(ws.project, target, defaults=ws.effective_config()).token
        return TimelineService(ws).trim_clip_edge(
            "host-1", "out", source_sec, mode=mode, expected_token=token
        )

    return run


def _guest_never_speaks(project: EpisodeProject) -> None:
    """A ripple cut asks before it cuts another lane's speech, so the guest has none."""
    project.transcripts[1].words = []


def _host_ends_before_welcome(project: EpisodeProject) -> None:
    """The host clip stops at 3.0 s and its last two words sit in the archive."""
    host = project.transcripts[0]
    archived = [
        ArchivedTranscriptWord(ordinal=3 + i, word=word) for i, word in enumerate(host.words[3:])
    ]
    host.archived_words = archived
    host.words = host.words[:3]
    project.timeline.clips[0].source_end = 3.0


def _roll(ws: ProjectWorkspace) -> Any:
    target = RollBoundaryTarget(left_clip_id="host-l", right_clip_id="host-r")
    token = boundary_context(ws.project, target, defaults=ws.effective_config()).token
    return TimelineService(ws).roll_clip_join("host-l", "host-r", 0.5, expected_token=token)


def _paste(ws: ProjectWorkspace) -> Any:
    service = TimelineService(ws)
    clipboard = service.copy_segment(1.0, 2.0, ["host"])
    return service.paste_segment(
        6.0, clipboard["duration"], clipboard["extracts"], mode=EditMode.RIPPLE
    )


def _host_with_a_padded_filler_cut(project: EpisodeProject) -> None:
    """Quiet host room tone and a bed, and an approved filler cut over "there" that leaves air."""
    host = project.tracks[0]
    assert host.media is not None
    host.media.sample_rate = RATE
    add_bed(project, project.workspace_path())
    audio = room(10.0)
    voice(audio, 0.0, 0.4)
    voice(audio, 1.0, 1.4)
    write_wav(project.workspace_path() / "raw" / "host.wav", audio)
    filler = pause("filler", start=0.5, end=0.9, gap=0.2)
    filler.reason = "filler:there"
    project.edit_decisions = [filler]


def _approve_padded_filler(ws: ProjectWorkspace) -> Any:
    with audio_check_override("contract", "test"):
        return EditService(ws).approve(["filler"])


def _host_with_room_tone_gap(project: EpisodeProject) -> None:
    """Quiet host room tone, two clips with a second of clip-free time between them."""
    audio = room(10.0)
    voice(audio, 0.0, 0.2)
    write_wav(project.workspace_path() / "raw" / "host.wav", audio)
    host = project.tracks[0]
    assert host.media is not None
    host.media.sample_rate = RATE
    project.timeline.clips = [
        Clip(id="host-l", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0),
        Clip(id="host-r", track_id="host", source_start=2.0, source_end=6.0, timeline_start=2.0),
        *(c for c in project.timeline.clips if c.track_id != "host"),
    ]


def _selected_range(action: RangeAction) -> Command:
    def run(ws: ProjectWorkspace) -> Any:
        service = EditService(ws)
        target = service.selected_range_target(3.0, 4.0, ["host"])
        return service.edit_selected_range(
            [target], action, propose=False, reason="contract", action_id=f"contract-{action}"
        )

    return run


def _host_stem(project: EpisodeProject) -> None:
    """A rendered host stem on disk, so the audio bookkeeping can find it fresh."""
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(project.workspace_path() / "raw" / "host.wav", stem)


def _gate_host_with_fresh_stem(ws: ProjectWorkspace) -> Any:
    """Any audio edit whose stem is fresh afterwards: the commit then reconciles on its own."""

    def gate(project: EpisodeProject) -> None:
        project.processing_chains = [
            ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="agate", params={})])
        ]
        write_stem_hash(project, "host", defaults=ws.effective_config())

    return ws.mutate("before gate", "after gate", gate)


def _cut_welcome(ws: ProjectWorkspace) -> Any:
    return EditService(ws).cut_range(
        3.0, 4.0, mode=EditMode.RIPPLE, track_ids=["host"], use_inaudible_opt=False
    )


def _revert_last_cut(ws: ProjectWorkspace) -> Any:
    return EditService(ws).revert_applied([ws.project.editorial.edit_log[-1].id])


def _record_start_take(*, land_first: bool = False) -> Command:
    """A start-of-episode record room with a take uploaded, or two landed."""

    def record(ws: ProjectWorkspace) -> Any:
        record_room, svc, guest = _start_room(ws)
        _take(ws, record_room, svc, guest, 0, 2.5, 880.0)
        if land_first:
            _land(ws)
            _take(ws, record_room, svc, guest, 1, 1.5, 660.0)
            _land(ws)

    return record


def _land_take(ws: ProjectWorkspace) -> Any:
    return _land(ws)


def _discard_last_take(ws: ProjectWorkspace) -> Any:
    return RecordLandingService(ws).delete_take(1)


def _host_has_a_focus_cut(project: EpisodeProject) -> None:
    """An approved focus cut over the host's "welcome back", waiting for the focus step."""
    project.edit_decisions = [
        EditDecision(
            id="focus-contract",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=3.0,
            end=4.0,
            reason="focus:contract",
            review_required=False,
            applied=False,
            scope="session",
            boundary_mode="exact",
        )
    ]


def _host_with_a_stored_loop(project: EpisodeProject) -> None:
    """Both stored transcripts match their audio, and the host's holds a repetition loop."""
    for transcript in project.transcripts:
        transcript.audio_sha256 = sha256_file(
            project.workspace_path() / "raw" / f"{transcript.track_id}.wav"
        )
    project.transcripts[0].words = [
        *(
            TranscriptWord(text=f"word{i}", start=294.0 + i * 0.3, end=294.2 + i * 0.3)
            for i in range(20)
        ),
        *(
            TranscriptWord(text=t, start=299.84 + i * 0.0005, end=299.8405 + i * 0.0005)
            for i, t in enumerate((["And", "I", "know", "that"] * 56)[:221])
        ),
    ]


def _reuse_without_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """The reuse path loads no Whisper or aligner model, and Whisper must not run."""
    from podcast_mcp.services.pipeline import config

    monkeypatch.setattr(config, "ensure_whisper_cached_for_run", lambda **_: None)
    monkeypatch.setattr(config, "ensure_word_aligner_for_run", lambda *_, **__: None)
    monkeypatch.setattr(
        TranscriptionEngine,
        "transcribe_file",
        Mock(side_effect=AssertionError("Whisper must not run")),
    )


def _no_whisper_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("podcast_mcp.services.document.transcript.require_model", lambda *_a: None)


def _transcribe_host(ws: ProjectWorkspace) -> Any:
    """Re-transcribe the host: a stand-in engine hands back new words, the rest runs for real."""
    new = Transcript(
        track_id="host",
        words=[
            TranscriptWord(text="greetings", start=0.0, end=0.4),
            TranscriptWord(text="friend", start=0.5, end=0.9),
        ],
    )
    with patch("podcast_mcp.services.document.transcript.TranscriptionEngine") as engine:
        engine.return_value.transcribe_all_dialogue.return_value = [new]
        return TranscriptService(ws).transcribe("host")


def _run_step(step: str, config: dict[str, Any]) -> Command:
    return lambda ws: PipelineService(ws).run(only_step=step, config=config)


def _stage_take_on_host(kind: Literal["insert", "replace"]) -> Command:
    """Stage a three second recorded take on the host lane, as a landed session leaves it."""

    def stage(ws: ProjectWorkspace) -> Any:
        def build(project: EpisodeProject) -> None:
            source_id = f"rec-{SESSION}-0-host-0"
            upsert_source(
                project,
                source_id=source_id,
                rel=f"raw/{source_id}.wav",
                speaker="host",
                duration_s=3.0,
                sample_rate=48_000,
                channels=1,
            )
            row = (
                SessionSuggestion(
                    id=f"ss-{SESSION}",
                    kind="insert",
                    session_id=SESSION,
                    session_number=1,
                    at_sec=4.0,
                    anchor=capture_insert_anchor(project, 4.0),
                )
                if kind == "insert"
                else SessionSuggestion(
                    id=f"ss-{SESSION}",
                    kind="replace",
                    session_id=SESSION,
                    session_number=1,
                    from_sec=2.0,
                    to_sec=4.0,
                    track_ids=["host"],
                    **dict(
                        zip(
                            ("anchor", "end_anchor"),
                            capture_range_anchors(project, 2.0, 4.0, ["host"]),
                            strict=True,
                        )
                    ),
                )
            )
            row.takes = [
                StagedTake(
                    take_index=0,
                    track_id="host",
                    track_label="Host",
                    segment_index=0,
                    source_id=source_id,
                    offset_s=0.0,
                    duration_s=3.0,
                )
            ]
            ensure_session_suggestion(project, row)

        return ws.mutate("stage session", "staged session", build)

    return stage


def _accept_staged(ws: ProjectWorkspace) -> Any:
    return SessionSuggestionService(ws).accept(f"ss-{SESSION}")


def _insert_saved_intro(ws: ProjectWorkspace) -> Any:
    segment = _save_segment(ws.path.parent, "Warm Intro")
    return insert_saved_segment(ws, segment.id, 4.0)


TIMELINE_CASES = [
    Case(
        "ripple_delete_words",
        lambda ws: EditService(ws).cut_range(
            3.0, 4.0, mode=EditMode.RIPPLE, track_ids=["host"], use_inaudible_opt=False
        ),
        ("hello there friend", "thanks for having me"),
    ),
    Case(
        "gap_delete_words",
        lambda ws: EditService(ws).cut_range(
            3.0, 4.0, mode=EditMode.GAP, track_ids=["host"], use_inaudible_opt=False
        ),
        ("hello there friend", "thanks for having me"),
    ),
    Case(
        "gap_delete_lane_without_transcript",
        lambda ws: EditService(ws).cut_range(
            7.0, 8.0, mode=EditMode.GAP, track_ids=["host"], use_inaudible_opt=False
        ),
        (),
        arrange=_without_transcripts,
        quirk="h1",
    ),
    Case(
        "insert_gap",
        lambda ws: TimelineService(ws).insert_gap(2.0, 1.0),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case(
        "move_segment",
        lambda ws: TimelineService(ws).move_segment(1.0, 2.0, 6.0),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case(
        "duplicate_segment",
        lambda ws: TimelineService(ws).duplicate_segment(1.0, 2.0, 4.0),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case("paste_segment", _paste, FRESH_TEXTS, quirk="h1", words=False),
    Case(
        "trim_clip_edge_ripple_keeps_words",
        _trim_out(2.0, EditMode.RIPPLE),
        ("hello there friend", "welcome back"),
        arrange=_guest_never_speaks,
        quirk="h1",
    ),
    Case(
        "trim_clip_edge_gap_restores_words",
        _trim_out(4.0, EditMode.GAP),
        FRESH_TEXTS,
        arrange=_host_ends_before_welcome,
    ),
    Case(
        "move_clips",
        lambda ws: TimelineService(ws).move_clips(
            [{"clip_id": "guest-1", "track_id": "guest", "timeline_start": 1.0}]
        ),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case("revert_applied_cut", _revert_last_cut, FRESH_TEXTS, prepare=_cut_welcome),
    Case(
        "land_start_session_take",
        _land_take,
        FRESH_TEXTS,
        quirk="h1",
        words=False,
        prepare=_record_start_take(),
    ),
    Case(
        "discard_last_start_session_take",
        _discard_last_take,
        FRESH_TEXTS,
        quirk="h1",
        words=False,
        prepare=_record_start_take(land_first=True),
    ),
    Case(
        "accept_staged_insert",
        _accept_staged,
        FRESH_TEXTS,
        quirk="h1",
        prepare=_stage_take_on_host("insert"),
    ),
    Case(
        "accept_staged_replace",
        _accept_staged,
        ("hello there friend", "thanks for having me"),
        prepare=_stage_take_on_host("replace"),
    ),
    Case(
        "insert_saved_segment",
        _insert_saved_intro,
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case(
        "selected_range_cut",
        _selected_range("cut"),
        FRESH_TEXTS,
        quirk="h1",
    ),
    Case(
        "selected_range_mute",
        _selected_range("mute"),
        FRESH_TEXTS,
        quirk="h1",
    ),
    Case(
        "approve_filler_cut_with_room_tone_pad",
        _approve_padded_filler,
        ("hello friend", "welcome back", "thanks for having me"),
        arrange=_host_with_a_padded_filler_cut,
        configure=lambda monkeypatch: configure_pause_policy(monkeypatch, pause_defaults()),
    ),
    Case(
        "fill_room_tone",
        lambda ws: TimelineService(ws).fill_room_tone(track_id="host"),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
        arrange=_host_with_room_tone_gap,
    ),
    Case("roll_clip_join", _roll, FRESH_TEXTS, quirk="h1", words=False, arrange=_host_in_two_clips),
]


def _speaker_seams(monkeypatch: pytest.MonkeyPatch) -> None:
    """Score every host window as the guest's voice, so speaker id labels and suppresses it.

    The scorer, the stored profiles and the speech regions are the model-backed inputs. The
    rest of speaker id (word updates and the combined rebuild) runs for real.
    """

    def score(project, track_id, start, end, cfg, backend, **_kwargs):
        owner = "guest" if track_id == "host" else track_id
        return WindowScore(
            track_id=track_id,
            start_sec=start,
            end_sec=end,
            scores={"host": 0.1, "guest": 0.9},
            best_track_id=owner,
            best_identity=owner,
            margin=0.8,
        )

    def profile(track_id: str) -> SpeakerProfile:
        return SpeakerProfile(
            speaker_id=track_id,
            track_id=track_id,
            embedding=[1.0 if track_id == "host" else 0.0, 0.0 if track_id == "host" else 1.0],
            enrollment_sec=30.0,
            stem_hash="contract",
            home_track_id=track_id,
        )

    profiles = {tid: profile(tid) for tid in ("host", "guest")}
    context = TranscriptContext(speaker_id=CtxSpeakerIdConfig(min_margin=0.1, auto_suppress=True))
    engine = "podcast_mcp.engines.speaker_id"
    monkeypatch.setattr(f"{engine}.score_window", score)
    monkeypatch.setattr(f"{engine}.load_all_profiles", lambda _project: profiles)
    monkeypatch.setattr(f"{engine}.enroll_track", lambda _p, tid, *_a, **_k: profiles[tid])
    monkeypatch.setattr(f"{engine}._speech_regions", lambda _p, tid: [(0.0, 1.5)] * (tid == "host"))
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.load_transcript_context", lambda _p: context
    )


def _host_friend_is_bleed(project: EpisodeProject) -> None:
    host = project.transcripts[0]
    host.words[2] = host.words[2].model_copy(update={"audibility_status": "bleed"})


class _ContractBackend:
    def name(self) -> str:
        return "contract"


def _split_seams(monkeypatch: pytest.MonkeyPatch) -> None:
    """Attribute the host recording as Ana until 2 s and Ben after it; nothing else is stubbed."""
    attribution = SpeakerAttribution(
        speaker_count=2,
        duration=SOURCE_SEC,
        turns=(
            SpeakerTurn(start=0.0, end=2.0, speakers=(0,), confidence=0.9),
            SpeakerTurn(start=2.0, end=SOURCE_SEC, speakers=(1,), confidence=0.9),
        ),
        backend="contract",
        method="cluster",
    )
    module = "podcast_mcp.services.media.speaker"
    monkeypatch.setattr(f"{module}.resolve_speaker_backend", lambda *_a, **_k: _ContractBackend())
    monkeypatch.setattr(f"{module}.attribute_speakers", lambda *_a, **_k: attribution)


def _split_host(ws: ProjectWorkspace) -> Any:
    return SpeakerService(ws).split_speakers(
        "host", speaker_count=2, names=["Ana", "Ben"], dry_run=False
    )


SPEAKER_CASES = [
    Case(
        "split_track_by_speaker",
        _split_host,
        FRESH_TEXTS,
        speakers=("Ana", "Ben", "Guest"),
        configure=_split_seams,
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "move_lane_span",
        lambda ws: SpeakerService(ws).move_lane_span(
            "host",
            ws.project.editorial.speaker_splits[-1].lanes[1],
            source_start=0.0,
            source_end=1.5,
        ),
        FRESH_TEXTS,
        speakers=("Ben", "Ben", "Guest"),
        prepare=_split_host,
        configure=_split_seams,
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "speaker_home_gate",
        lambda ws: SpeakerService(ws).gate_track(track_id="host", dry_run=False),
        ("welcome back", "thanks for having me"),
        configure=_speaker_seams,
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "speaker_attribute_bleed_windows",
        lambda ws: SpeakerService(ws).attribute(dry_run=False),
        ("hello there", "welcome back", "thanks for having me"),
        arrange=_host_friend_is_bleed,
        configure=_speaker_seams,
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
]

PIPELINE_CASES = [
    Case(
        "pipeline_reuse_repairs_stored_loop",
        _run_step("transcribe_tracks", {}),
        (
            "thanks for having me",
            "word0 word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19",
        ),
        none=UNTOUCHED,
        quirk="h2",
        arrange=_host_with_a_stored_loop,
        configure=_reuse_without_models,
    ),
    Case(
        "pipeline_focus_apply_step",
        _run_step("focus_from_transcript", {"focus": {"enabled": True, "auto_apply": True}}),
        ("hello there friend", "thanks for having me"),
        arrange=_host_has_a_focus_cut,
    ),
]

TRANSCRIBE_CASES = [
    Case(
        "transcribe_via_mutate",
        _transcribe_host,
        ("greetings friend", "thanks for having me"),
        configure=_no_whisper_model,
        fresh=UNTOUCHED,
        stale=UNTOUCHED,
        none=UNTOUCHED,
        quirk="h2",
        s2_changes=(State.FRESH, State.STALE),
    ),
]

RECONCILE_CASES = [
    Case(
        "reconcile_transcript_on_silent_media",
        lambda ws: AnalysisService(ws).reconcile_transcript(dry_run=False),
        (),
        s3_changes=True,
    ),
    Case(
        "auto_reconcile_after_audio_edit",
        _gate_host_with_fresh_stem,
        ("thanks for having me",),
        arrange=_host_stem,
        s3_changes=True,
    ),
]


@pytest.mark.parametrize("state", list(State), ids=lambda state: f"{state}-rebuilt")
def test_a_render_preview_outside_a_commit_rebuilds_combined_after_its_reconcile(
    state: State, tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    project = ws.checkpoint()
    rerender_preview(project, defaults=ws.effective_config())
    assert texts(project.combined_transcript) == ()
    assert project.combined_transcript == merged(project)


def _glossary_context(monkeypatch: pytest.MonkeyPatch) -> None:
    _precorrect_context(monkeypatch, [ReplacementRule("welcome", "greetings", "word")])


def _precorrect_context(monkeypatch: pytest.MonkeyPatch, rules: list[ReplacementRule]) -> None:
    ctx = TranscriptContext(replacements=rules, speaker_id=CtxSpeakerIdConfig(mode="never"))
    monkeypatch.setattr(
        "podcast_mcp.services.media.transcript_precorrect.load_transcript_context",
        lambda _workspace: ctx,
    )
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_precorrect.load_transcript_context", lambda _workspace: ctx
    )


class _EchoPairs:
    def echo_pairs(self) -> list[Any]:
        return [Mock(source_track_id="host", bleed_track_id="guest")]


def _guest_has_the_clearer_copy(monkeypatch: pytest.MonkeyPatch) -> None:
    _precorrect_context(monkeypatch, [])
    pair = {
        "track_a": "host",
        "source_a": None,
        "word_index_a": 0,
        "text_a": "hello",
        "status_a": "bleed",
        "track_b": "guest",
        "source_b": None,
        "word_index_b": 0,
        "text_b": "hullo",
        "status_b": "audible",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    module = "podcast_mcp.edits.transcript_precorrect"
    monkeypatch.setattr(f"{module}.build_track_rms_caches", lambda *_a, **_k: _EchoPairs())
    monkeypatch.setattr(f"{module}.compute_word_audibility_map", lambda *_a, **_k: [])
    monkeypatch.setattr(
        f"{module}.overlap_duplicate_report", lambda *_a, **_k: {"pairs": [dict(pair)]}
    )


PRECORRECT_CASES = [
    Case(
        "precorrect_glossary_hit",
        lambda ws: TranscriptPrecorrectService(ws).precorrect(dry_run=False),
        ("hello there friend", "greetings back", "thanks for having me"),
        configure=_glossary_context,
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "precorrect_cross_track_sync",
        lambda ws: TranscriptPrecorrectService(ws).precorrect(dry_run=False),
        ("hullo there friend", "welcome back", "thanks for having me"),
        configure=_guest_has_the_clearer_copy,
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
    Case(
        "pipeline_precorrect_step",
        _run_step("precorrect_transcript", {}),
        ("hello there friend", "greetings back", "thanks for having me"),
        configure=_glossary_context,
        s3_changes=True,
        s3_untouched=(State.NONE,),
    ),
]

ALL_CASES = [
    *WORD_CASES,
    *PRECORRECT_CASES,
    *TIMELINE_CASES,
    *PIPELINE_CASES,
    *TRANSCRIBE_CASES,
    *RECONCILE_CASES,
    *SPEAKER_CASES,
]


@pytest.mark.parametrize(("case", "state"), case_params(ALL_CASES))
def test_combined_after_command(
    case: Case,
    state: State,
    tmp_path: Path,
    ten_second_silence_wav: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = run_case(case, state, tmp_path, ten_second_silence_wav, monkeypatch)
    assert_contract(case, state, seen)


@pytest.mark.parametrize("state", list(State), ids=lambda state: f"{state}-rebuilt-in-memory-only")
def test_speaker_label_window_rebuilds_memory_and_saves_nothing(
    state: State, tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``SpeakerService.label`` changes words without ``ws.mutate``, so no commit lands.

    The window's words are updated and combined is rebuilt on the open project only: the
    saved file, ``combined.json`` and history keep what they held on entry.
    """
    _speaker_seams(monkeypatch)
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    seen = observe(ws, lambda w: SpeakerService(w).label("host", 0.0, 1.5, dry_run=False))
    assert texts(seen.memory) == ("welcome back", "thanks for having me")
    assert seen.memory == seen.expected_rebuilt
    assert not seen.moved
    assert seen.saved == seen.entry
    assert seen.snapshot == seen.entry
    assert seen.combined_json == seen.entry_json


@pytest.mark.parametrize("state", [State.FRESH], ids=lambda state: f"{state}-s2-changes")
def test_transcribe_h2_changes_words_and_leaves_a_fresh_combined_behind(
    state: State, tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transcribe through ``ws.mutate`` moves the words, so the hook rebuilds a fresh combined."""
    _no_whisper_model(monkeypatch)
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    seen = observe(ws, _transcribe_host)
    assert texts(seen.entry) == FRESH_TEXTS
    assert texts(seen.memory) == ("greetings friend", "thanks for having me")
    assert seen.memory == seen.expected_rebuilt
    assert seen.moved
    assert seen.snapshot == seen.memory


def _seed_canned(with_combined: bool) -> dict[str, Any]:
    canned: dict[str, Any] = {
        "per_track": [
            {
                "track_id": "host",
                "words": [{"text": "seeded", "start": 0.0, "end": 0.4, "confidence": 0.9}],
            }
        ]
    }
    if with_combined:
        canned["combined"] = {
            "utterances": [
                {
                    "track_id": "host",
                    "speaker": "Canned",
                    "start": 0.0,
                    "end": 0.4,
                    "text": "canned combined",
                }
            ]
        }
    return canned


@pytest.mark.parametrize(
    ("with_combined", "expected"),
    [(True, ("canned combined",)), (False, ("seeded",))],
    ids=["canned-combined-kept", "no-canned-combined-merged"],
)
@pytest.mark.parametrize("state", list(State), ids=lambda state: f"from-{state}")
def test_seed_sets_combined_once_without_a_history_step(
    state: State,
    with_combined: bool,
    expected: tuple[str, ...],
    tmp_path: Path,
    ten_second_silence_wav: Path,
) -> None:
    """``seed`` saves through ``ws.save`` outside ``run_mutation``: canned combined, else a merge."""
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    seen = observe(ws, lambda w: TranscriptService(w).seed(_seed_canned(with_combined)))
    assert texts(seen.memory) == expected
    assert seen.saved == seen.memory
    assert seen.combined_json == json_of(seen.memory)
    assert not seen.moved
    assert seen.snapshot == seen.entry


@pytest.mark.parametrize(
    "state",
    list(State),
    ids=lambda state: f"{state}-s2-changes" if state is State.STALE else f"{state}",
)
def test_set_track_meta_patches_the_stored_speaker_in_place_without_a_rebuild(
    state: State, tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    """Renaming a speaker rewrites the stored utterances' labels and nothing else.

    A fresh combined ends up equal to a rebuild. A stale one is rebuilt by the hook because the
    speaker moved the merge inputs. A missing one stays missing.
    """
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    seen = observe(ws, lambda w: EpisodeService(w).set_track_meta("host", speaker="Dr Host"))
    if state is State.NONE:
        expected = None
    elif state is State.FRESH:
        expected = seen.expected_rebuilt
        assert expected is not None
        assert tuple(u.speaker for u in expected.utterances) == ("Dr Host", "Dr Host", "Guest")
    else:
        expected = seen.expected_rebuilt
        assert expected != seen.entry
    assert_channels(seen, expected)


@pytest.mark.parametrize("state", [State.STALE], ids=lambda state: f"{state}")
def test_empty_rebuild_leaves_the_stale_combined_json_file_in_place(
    state: State, tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    case = next(c for c in TIMELINE_CASES if c.name == "gap_delete_lane_without_transcript")
    seen = observe(
        open_workspace(tmp_path / "ep", ten_second_silence_wav, state, arrange=case.arrange),
        case.run,
    )
    assert texts(seen.memory) == ()
    assert texts(seen.saved) == ()
    assert texts(seen.snapshot) == ()
    assert seen.entry_json is not None
    assert seen.combined_json == seen.entry_json
    assert seen.combined_json != json_of(seen.memory)


DRY_RUN_CASES = [
    pytest.param(
        lambda ws: AnalysisService(ws).reconcile_transcript(dry_run=True),
        None,
        id="reconcile_transcript",
    ),
    pytest.param(
        lambda ws: SpeakerService(ws).split_speakers(
            "host", speaker_count=2, names=["Ana", "Ben"], dry_run=True
        ),
        _split_seams,
        id="split_speakers",
    ),
    pytest.param(
        lambda ws: SpeakerService(ws).gate_track(track_id="host", dry_run=True),
        _speaker_seams,
        id="gate_track",
    ),
    pytest.param(
        lambda ws: SpeakerService(ws).attribute(dry_run=True),
        _speaker_seams,
        id="attribute",
    ),
]


def _assert_combined_untouched(seen: Any) -> None:
    assert seen.memory == seen.entry
    assert seen.saved == seen.entry
    assert seen.snapshot == seen.entry
    assert seen.combined_json == seen.entry_json
    assert not seen.moved


@pytest.mark.parametrize("state", list(State), ids=lambda state: f"{state}-untouched")
@pytest.mark.parametrize(("command", "configure_run"), DRY_RUN_CASES)
def test_dry_run_leaves_combined_untouched(
    command: Command,
    configure_run: Any,
    state: State,
    tmp_path: Path,
    ten_second_silence_wav: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if configure_run is not None:
        configure_run(monkeypatch)
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    seen = observe(ws, command)
    _assert_combined_untouched(seen)


def _rebuild_then_fail(ws: ProjectWorkspace) -> Any:
    def mutate(project: EpisodeProject) -> None:
        project.transcripts[0].words[0].text = "BROKEN"
        rebuild_combined(project, defaults=ws.effective_config())
        raise RuntimeError("mutation failed after rebuilding combined")

    return ws.mutate("before failure", "after failure", mutate)


@pytest.mark.parametrize("state", list(State), ids=lambda state: f"{state}-untouched")
def test_failed_mutation_leaves_combined_untouched(
    state: State, tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    words_before = [w.text for w in ws.project.transcripts[0].words]

    def failing(w: ProjectWorkspace) -> Any:
        with pytest.raises(RuntimeError, match="mutation failed"):
            _rebuild_then_fail(w)

    seen = observe(ws, failing)
    _assert_combined_untouched(seen)
    assert [w.text for w in ws.project.transcripts[0].words] == words_before
