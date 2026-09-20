from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

from podcast_mcp.edits.transcript_precorrect import (
    PrecorrectResult,
    _audibility_score,
    _bleed_stats,
    _find_glossary_phrase_matches,
    _find_glossary_word_matches,
    _pick_winner,
    _scan_garble_hits,
    _should_run_speaker,
    _text_similarity,
    run_cross_track_sync,
    run_glossary_pass,
    run_precorrect_transcript,
)
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord
from podcast_mcp.transcript_context import (
    CrossTrackConfig,
    ReplacementRule,
    SkipSpan,
    SpeakerIdConfig,
    TranscriptContext,
)


@dataclass
class RecordingProgress:
    events: list[dict[str, Any]] = field(default_factory=list)

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        self.events.append({"kind": "start", "task_id": task_id, "total": total})

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        self.events.append(
            {
                "kind": "update",
                "task_id": task_id,
                "current": current,
                "message": message,
                "phase": phase,
            }
        )

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        self.events.append({"kind": "message", "task_id": task_id, "text": text, "phase": phase})

    def end(self, task_id: str, *, message: str | None = None) -> None:
        self.events.append({"kind": "end", "task_id": task_id, "message": message})

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        self.events.append({"kind": "fail", "task_id": task_id, "message": message, "phase": phase})

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        self.events.append({"kind": "cancel", "task_id": task_id, "message": message})


def _ctx(**kwargs) -> TranscriptContext:
    base = TranscriptContext(
        replacements=[
            ReplacementRule("Pod Cast Name", "Podcast Name", "phrase"),
            ReplacementRule("teh", "the", "word"),
        ],
        preserve_tokens=["verdad"],
        filler_tokens=["um"],
        skip_spans=[SkipSpan(5.0, 10.0, "deferred")],
        speaker_id=SpeakerIdConfig(mode="never"),
    )
    for k, v in kwargs.items():
        setattr(base, k, v)
    return base


def test_glossary_pass_finds_phrase_and_word() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Pod", start=0.0, end=0.3),
                TranscriptWord(text="Cast", start=0.3, end=0.6),
                TranscriptWord(text="Name", start=0.6, end=1.0),
                TranscriptWord(text="teh", start=11.0, end=11.5),
                TranscriptWord(text="verdad", start=6.0, end=6.5),
            ],
        )
    ]
    report = run_glossary_pass(p, _ctx(), dry_run=True)
    assert report["count"] == 2
    kinds = {f["kind"] for f in report["fixes"]}
    assert kinds == {"phrase", "word"}


def test_glossary_ignores_empty_phrase_rule() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hello", start=0.0, end=0.5)],
        )
    ]
    ctx = _ctx(replacements=[ReplacementRule("", "ignored", "phrase")])
    report = run_glossary_pass(p, ctx, dry_run=True)
    assert report["count"] == 0


def test_glossary_homophone_phrase_replacement() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="in", start=0.0, end=0.2),
                TranscriptWord(text="sight", start=0.2, end=0.5),
                TranscriptWord(text="fear", start=0.5, end=0.9),
            ],
        )
    ]
    ctx = _ctx(
        replacements=[
            ReplacementRule("in sight fear", "inciting fear", "phrase"),
        ]
    )
    report = run_glossary_pass(p, ctx, dry_run=False)
    assert report["count"] == 1
    assert p.transcripts[0].words[0].text == "inciting"
    assert p.transcripts[0].words[-1].text == "fear"


def test_glossary_skips_suppressed_words() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="teh",
                    start=11.0,
                    end=11.5,
                    suppressed=True,
                ),
            ],
        )
    ]
    report = run_glossary_pass(p, _ctx(), dry_run=True)
    assert report["count"] == 0


def test_glossary_skip_span_excludes_word() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="teh", start=6.5, end=7.0)],
        )
    ]
    report = run_glossary_pass(p, _ctx(), dry_run=True)
    assert report["count"] == 0


def test_glossary_apply_mutates_transcript() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="teh", start=11.0, end=11.5)],
        )
    ]
    run_glossary_pass(p, _ctx(), dry_run=False)
    assert p.transcripts[0].words[0].text == "the"


def test_text_similarity_substring() -> None:
    assert _text_similarity("truth", "of truth") >= 0.55


def test_text_similarity_rejects_short_char_substring() -> None:
    assert _text_similarity("I", "talking") < 0.55
    assert _text_similarity("talking", "I") < 0.55


def test_cross_track_sync_rejects_talking_to_i_lab_pair() -> None:
    """Regression: stretched guest 'talking' must not sync from host 'I'."""
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="caleb",
            words=[
                TranscriptWord(
                    text="I",
                    start=1606.74,
                    end=1607.32,
                    confidence=0.97,
                    audibility_status="audible",
                ),
            ],
        ),
        Transcript(
            track_id="lana",
            words=[
                TranscriptWord(
                    text="talking",
                    start=1595.94,
                    end=1606.16,
                    confidence=0.36,
                    audibility_status="audible",
                ),
            ],
        ),
    ]
    ctx = _ctx(cross_track=CrossTrackConfig(min_overlap_sec=0.1, min_similarity=0.55))
    pair = {
        "track_a": "caleb",
        "word_index_a": 0,
        "text_a": "I",
        "start_a": 1606.74,
        "end_a": 1607.32,
        "status_a": "audible",
        "track_b": "lana",
        "word_index_b": 0,
        "text_b": "talking",
        "start_b": 1595.94,
        "end_b": 1606.16,
        "status_b": "audible",
        "overlap_sec": 0.58,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=False)

    assert report["count"] == 0
    assert p.transcripts[1].words[0].text == "talking"
    reasons = {d["reason"] for d in report["deferred_low_similarity"]}
    assert reasons & {"duration_mismatch", "low_similarity"}


def test_speaker_gate_never() -> None:
    p = EpisodeProject.create("x", "/tmp")
    run, reason = _should_run_speaker(p, _ctx(), [])
    assert not run
    assert "never" in reason


def test_speaker_gate_auto_bleed() -> None:
    p = EpisodeProject.create("x", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="a",
            words=[
                TranscriptWord(
                    text="x",
                    start=float(i),
                    end=float(i) + 1,
                    audibility_status="bleed",
                )
                for i in range(60)
            ],
        )
    ]
    ctx = _ctx(speaker_id=SpeakerIdConfig(mode="auto", bleed_word_threshold=50))
    run, reason = _should_run_speaker(p, ctx, [])
    assert run
    assert reason == ""


def test_precorrect_dry_run_emits_progress(tmp_path) -> None:
    p = EpisodeProject.create("precorrect", str(tmp_path))
    p.ensure_dirs()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="teh", start=1.0, end=1.5)],
        )
    ]
    ctx = _ctx()
    progress = RecordingProgress()
    result = run_precorrect_transcript(
        p,
        dry_run=True,
        context=ctx,
        progress=progress,
    )
    task_ids = [e["task_id"] for e in progress.events if e["kind"] == "start"]
    assert "precorrect" in task_ids
    assert "precorrect-glossary" in task_ids
    assert any(e["kind"] == "message" for e in progress.events)
    assert result.report_path is not None


def test_precorrect_result_to_dict() -> None:
    result = PrecorrectResult(
        applied=True,
        glossary_applied=2,
        cross_track_applied=1,
        speaker_ran=True,
        report_path="/tmp/report.json",
    )
    data = result.to_dict()
    assert data["applied"] is True
    assert data["glossary_applied"] == 2
    assert data["report_path"] == "/tmp/report.json"


def test_text_similarity_edge_cases() -> None:
    assert _text_similarity("", "word") == 0.0
    assert _text_similarity("same", "same") == 1.0
    assert _text_similarity("cat", "dog") < 0.55


def test_audibility_score_and_pick_winner() -> None:
    assert _audibility_score("audible") == 3
    assert _audibility_score("deferred") == 2
    assert _audibility_score("bleed") == 1
    assert _audibility_score("inaudible") == 0
    assert _audibility_score(None) == 1

    pair = {
        "track_a": "host",
        "track_b": "guest",
        "status_a": "audible",
        "status_b": "bleed",
        "confidence_a": 0.9,
        "confidence_b": 0.9,
    }
    assert _pick_winner(pair, margin=0.15) == "host"

    tie = {
        "track_a": "host",
        "track_b": "guest",
        "status_a": "audible",
        "status_b": "audible",
        "confidence_a": 0.9,
        "confidence_b": 0.91,
    }
    assert _pick_winner(tie, margin=0.15) is None


def test_glossary_phrase_homophone_match_type() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Logos", start=0.0, end=0.4),
                TranscriptWord(text="Bible", start=0.4, end=0.8),
            ],
        )
    ]
    ctx = _ctx(
        replacements=[ReplacementRule("logos bible", "Logos Bible", "phrase")],
        preserve_tokens=[],
    )
    report = run_glossary_pass(p, ctx, dry_run=True)
    assert report["count"] == 1
    assert report["fixes"][0]["text"] == "Logos Bible"


def test_glossary_preserve_token_blocks_phrase_span() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="keep", start=0.0, end=0.3),
                TranscriptWord(text="verdad", start=0.3, end=0.6),
                TranscriptWord(text="here", start=0.6, end=0.9),
            ],
        )
    ]
    ctx = _ctx(
        replacements=[ReplacementRule("keep verdad here", "kept", "phrase")],
        preserve_tokens=["verdad"],
    )
    report = run_glossary_pass(p, ctx, dry_run=True)
    assert report["count"] == 0


def test_glossary_pass_reports_progress_every_50_words() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="word", start=float(i), end=float(i) + 0.1) for i in range(55)
            ],
        )
    ]
    progress = RecordingProgress()
    run_glossary_pass(p, _ctx(replacements=[]), dry_run=True, progress=progress)
    updates = [
        e
        for e in progress.events
        if e["kind"] == "update" and e["task_id"] == "precorrect-glossary"
    ]
    assert updates
    assert updates[-1]["current"] == 55


def test_scan_garble_hits_patterns() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="@@@", start=0.0, end=0.3),
                TranscriptWord(text="ok", start=0.3, end=0.6),
                TranscriptWord(
                    text="@@@",
                    start=0.6,
                    end=0.9,
                    suppressed=True,
                ),
            ],
        )
    ]
    hits = _scan_garble_hits(p, ["[@#]+", "", "[", "ok"])
    texts = {h["text"] for h in hits}
    assert "@@@" in texts
    assert "ok" in texts
    assert len([h for h in hits if h["text"] == "@@@"]) == 1


def _two_track_words() -> tuple[EpisodeProject, TranscriptContext]:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="truth",
                    start=1.0,
                    end=1.5,
                    confidence=0.95,
                    audibility_status="audible",
                ),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(
                    text="trooth",
                    start=1.1,
                    end=1.6,
                    confidence=0.4,
                    audibility_status="bleed",
                ),
            ],
        ),
    ]
    ctx = _ctx(cross_track=CrossTrackConfig(min_overlap_sec=0.1, min_similarity=0.55))
    return p, ctx


def test_cross_track_sync_applies_winner_text() -> None:
    p, ctx = _two_track_words()
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "truth",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "trooth",
        "start_b": 1.1,
        "status_b": "bleed",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=False)

    assert report["count"] == 1
    assert p.transcripts[1].words[0].text == "truth"
    assert report["fixes"][0]["winner_track"] == "host"


def test_cross_track_sync_defers_low_similarity_bleed() -> None:
    p, ctx = _two_track_words()
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "alpha",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "omega",
        "start_b": 1.1,
        "status_b": "bleed",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 0
    assert len(report["deferred_low_similarity"]) == 1
    assert report["deferred_low_similarity"][0]["reason"] == "low_similarity"


def test_cross_track_sync_defers_ambiguous_winner() -> None:
    p, ctx = _two_track_words()
    p.transcripts[0].words[0].confidence = 0.9
    p.transcripts[1].words[0].confidence = 0.91
    p.transcripts[1].words[0].audibility_status = "audible"
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "truth",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "trooth",
        "start_b": 1.1,
        "status_b": "audible",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 0
    assert report["deferred_low_similarity"][0]["reason"] == "ambiguous_audibility"


def test_cross_track_sync_skips_filler_word() -> None:
    p, ctx = _two_track_words()
    p.transcripts[1].words[0].text = "um"
    ctx = _ctx(
        cross_track=CrossTrackConfig(min_overlap_sec=0.1),
        filler_tokens=["um"],
    )
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "truth",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "trooth",
        "start_b": 1.1,
        "status_b": "bleed",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 0
    assert report["deferred_low_similarity"] == []


def test_cross_track_sync_skips_skip_span() -> None:
    p, ctx = _two_track_words()
    ctx = _ctx(
        cross_track=CrossTrackConfig(min_overlap_sec=0.1),
        skip_spans=[SkipSpan(1.0, 2.0, "deferred")],
    )
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "truth",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "trooth",
        "start_b": 1.1,
        "status_b": "bleed",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 0
    assert report["deferred_low_similarity"] == []


def test_speaker_gate_always_and_ratio() -> None:
    p = EpisodeProject.create("x", "/tmp")
    run, reason = _should_run_speaker(p, _ctx(speaker_id=SpeakerIdConfig(mode="always")), [])
    assert run
    assert reason == ""

    p.transcripts = [
        Transcript(
            track_id="a",
            words=[
                TranscriptWord(
                    text="x",
                    start=float(i),
                    end=float(i) + 1,
                    audibility_status="bleed" if i == 0 else "audible",
                )
                for i in range(100)
            ],
        )
    ]
    ctx = _ctx(
        speaker_id=SpeakerIdConfig(
            mode="auto",
            bleed_word_threshold=200,
            bleed_ratio_threshold=0.01,
        )
    )
    run, reason = _should_run_speaker(p, ctx, [])
    assert run
    assert reason == ""

    run, reason = _should_run_speaker(
        p,
        _ctx(speaker_id=SpeakerIdConfig(mode="auto", bleed_word_threshold=200)),
        [{"reason": "low_similarity"}],
    )
    assert run
    assert reason == ""


def test_precorrect_builds_deferred_queue_and_garble_hits(tmp_path) -> None:
    p = EpisodeProject.create("precorrect", str(tmp_path))
    p.ensure_dirs()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="@@@", start=1.0, end=1.5),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(
                    text="trooth",
                    start=1.1,
                    end=1.6,
                    audibility_status="bleed",
                ),
            ],
        ),
    ]
    deferred_pair = {
        "track_a": "host",
        "track_b": "guest",
        "text_a": "alpha",
        "text_b": "omega",
        "start_a": 1.0,
        "similarity": 0.2,
        "reason": "low_similarity",
    }
    ctx = _ctx(
        garble_patterns=["[@#]+"],
        speaker_id=SpeakerIdConfig(mode="never"),
    )
    with patch(
        "podcast_mcp.edits.transcript_precorrect.run_cross_track_sync",
        return_value={"count": 0, "fixes": [], "deferred_low_similarity": [deferred_pair]},
    ):
        result = run_precorrect_transcript(p, dry_run=True, context=ctx)

    assert result.report["deferred_queue"]
    assert result.report["deferred_queue"][0]["kind"] == "low_similarity"
    assert result.report["garble_hits"][0]["text"] == "@@@"


def test_precorrect_enqueues_anomalous_word_duration(tmp_path) -> None:
    p = EpisodeProject.create("precorrect-timing", str(tmp_path))
    p.ensure_dirs()
    p.transcripts = [
        Transcript(
            track_id="lana",
            words=[
                TranscriptWord(text="don't", start=1.0, end=10.5),
            ],
        ),
    ]
    ctx = _ctx(speaker_id=SpeakerIdConfig(mode="never"))
    with patch(
        "podcast_mcp.edits.transcript_precorrect.run_cross_track_sync",
        return_value={"count": 0, "fixes": [], "deferred_low_similarity": []},
    ):
        result = run_precorrect_transcript(p, dry_run=True, context=ctx)

    kinds = [item["kind"] for item in result.report["deferred_queue"]]
    assert "anomalous_word_duration" in kinds
    item = next(
        x for x in result.report["deferred_queue"] if x["kind"] == "anomalous_word_duration"
    )
    assert item["text"] == "don't"
    assert item["duration_sec"] == 9.5
    assert item["end"] == 10.5
    assert p.transcripts[0].words[0].audibility_status is None


def test_precorrect_apply_marks_anomalous_word_duration(tmp_path) -> None:
    p = EpisodeProject.create("precorrect-timing-apply", str(tmp_path))
    p.ensure_dirs()
    p.transcripts = [
        Transcript(
            track_id="lana",
            words=[
                TranscriptWord(text="don't", start=1.0, end=10.5),
            ],
        ),
    ]
    ctx = _ctx(speaker_id=SpeakerIdConfig(mode="never"))
    with patch(
        "podcast_mcp.edits.transcript_precorrect.run_cross_track_sync",
        return_value={"count": 0, "fixes": [], "deferred_low_similarity": []},
    ):
        result = run_precorrect_transcript(p, dry_run=False, context=ctx)

    kinds = [item["kind"] for item in result.report["deferred_queue"]]
    assert "anomalous_word_duration" in kinds
    assert p.transcripts[0].words[0].audibility_status == "deferred"


def test_cross_track_sync_skips_matching_text() -> None:
    p, ctx = _two_track_words()
    p.transcripts[1].words[0].text = "truth"
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "truth",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "truth",
        "start_b": 1.1,
        "status_b": "bleed",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 0


def test_precorrect_speaker_import_error(tmp_path) -> None:
    p = EpisodeProject.create("precorrect", str(tmp_path))
    p.ensure_dirs()
    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0.0, end=0.5)])
    ]
    ctx = _ctx(speaker_id=SpeakerIdConfig(mode="always"))
    with patch.dict("sys.modules", {"podcast_mcp.engines.speaker_id": None}):
        result = run_precorrect_transcript(p, dry_run=True, context=ctx)

    assert result.speaker_skipped_reason == "speaker extra not installed"
    assert result.report["speaker_attribution"]["skipped_reason"] == "speaker extra not installed"


def test_precorrect_runs_speaker_attribution_when_available(tmp_path) -> None:
    p = EpisodeProject.create("precorrect", str(tmp_path))
    p.ensure_dirs()
    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0.0, end=0.5)])
    ]
    ctx = _ctx(speaker_id=SpeakerIdConfig(mode="always"))
    speaker_report = {"ran": True, "attributions_changed": 2, "skipped_reason": None}
    with patch(
        "podcast_mcp.engines.speaker_id.run_speaker_attribution",
        return_value=speaker_report,
    ):
        result = run_precorrect_transcript(p, dry_run=True, context=ctx)

    assert result.speaker_ran is True
    assert result.report["speaker_attribution"]["attributions_changed"] == 2


def test_precorrect_applied_flag_when_not_dry_run(tmp_path) -> None:
    p = EpisodeProject.create("precorrect", str(tmp_path))
    p.ensure_dirs()
    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="teh", start=11.0, end=11.5)])
    ]
    result = run_precorrect_transcript(p, dry_run=False, context=_ctx())
    assert result.applied is True
    assert result.glossary_applied >= 1


def test_glossary_phrase_skips_suppressed_span() -> None:
    p = EpisodeProject.create("precorrect", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Pod", start=0.0, end=0.3),
                TranscriptWord(text="Cast", start=0.3, end=0.6, suppressed=True),
                TranscriptWord(text="Name", start=0.6, end=1.0),
            ],
        )
    ]
    rule = ReplacementRule("Pod Cast Name", "Podcast Name", "phrase")
    hits = _find_glossary_phrase_matches(p.transcripts[0].words, rule, set())
    assert hits == []


def test_glossary_homophone_match_type_normalizes() -> None:
    EpisodeProject.create("precorrect", "/tmp")
    words = [
        TranscriptWord(text="Logos", start=0.0, end=0.4),
        TranscriptWord(text="Bible", start=0.4, end=0.8),
    ]
    rule = ReplacementRule("logos bible", "Logos Bible", "homophone")
    hits = _find_glossary_phrase_matches(words, rule, set())
    assert hits == [(0, 1, "Logos Bible")]


def test_glossary_word_finder_ignores_non_word_rules() -> None:
    words = [TranscriptWord(text="teh", start=0.0, end=0.5)]
    rule = ReplacementRule("teh", "the", "phrase")
    assert _find_glossary_word_matches(words, rule, set()) == []


def test_bleed_stats_ignores_suppressed_and_empty() -> None:
    p = EpisodeProject.create("x", "/tmp")
    assert _bleed_stats(p) == (0, 0.0)

    p.transcripts = [
        Transcript(
            track_id="a",
            words=[
                TranscriptWord(
                    text="x",
                    start=0.0,
                    end=1.0,
                    suppressed=True,
                    audibility_status="bleed",
                ),
            ],
        )
    ]
    assert _bleed_stats(p) == (0, 0.0)


def test_speaker_gate_below_bleed_thresholds() -> None:
    p = EpisodeProject.create("x", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="a",
            words=[
                TranscriptWord(text="x", start=0.0, end=1.0, audibility_status="audible"),
            ],
        )
    ]
    ctx = _ctx(
        speaker_id=SpeakerIdConfig(
            mode="auto",
            bleed_word_threshold=50,
            bleed_ratio_threshold=0.5,
        )
    )
    run, reason = _should_run_speaker(p, ctx, [])
    assert not run
    assert "bleed below thresholds" in reason


def test_cross_track_sync_low_similarity_without_bleed_not_deferred() -> None:
    p, ctx = _two_track_words()
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "alpha",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "omega",
        "start_b": 1.1,
        "status_b": "audible",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 0
    assert report["deferred_low_similarity"] == []


def test_cross_track_sync_guest_wins_and_mutates_host() -> None:
    p, ctx = _two_track_words()
    p.transcripts[0].words[0].text = "trooth"
    p.transcripts[0].words[0].audibility_status = "bleed"
    p.transcripts[0].words[0].confidence = 0.3
    p.transcripts[1].words[0].audibility_status = "audible"
    p.transcripts[1].words[0].confidence = 0.95
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "trooth",
        "start_a": 1.0,
        "status_a": "bleed",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "truth",
        "start_b": 1.1,
        "status_b": "audible",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=False)

    assert report["count"] == 1
    assert report["fixes"][0]["winner_track"] == "guest"
    assert p.transcripts[0].words[0].text == "truth"


def test_cross_track_sync_skips_invalid_loser_index() -> None:
    p, ctx = _two_track_words()
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "truth",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 99,
        "text_b": "trooth",
        "start_b": 1.1,
        "status_b": "bleed",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 0


def test_cross_track_sync_reads_word_confidence_defaults() -> None:
    p, ctx = _two_track_words()
    p.transcripts[0].words[0].confidence = None
    p.transcripts[1].words[0].confidence = None
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "truth",
        "start_a": 1.0,
        "status_a": "audible",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "trooth",
        "start_b": 1.1,
        "status_b": "bleed",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 1
    assert report["fixes"][0]["winner_track"] == "host"


def _overlap_pair(idx: int, *, low_sim: bool = False, ambiguous: bool = False) -> dict:
    text_a = "alpha" if low_sim else "truth"
    text_b = "omega" if low_sim else ("trooth" if not ambiguous else "truth")
    status_b = "audible" if ambiguous else "bleed"
    conf_b = 0.91 if ambiguous else 0.4
    return {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": text_a,
        "start_a": 1.0 + idx * 0.01,
        "status_a": "audible",
        "confidence_a": 0.9,
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": text_b,
        "start_b": 1.1 + idx * 0.01,
        "status_b": status_b,
        "confidence_b": conf_b,
        "overlap_sec": 0.4,
        "text_match": False,
    }


def test_cross_track_sync_reports_progress_every_50_pairs() -> None:
    p, ctx = _two_track_words()
    pairs = [_overlap_pair(i) for i in range(50)]
    progress = RecordingProgress()
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": pairs},
    ):
        run_cross_track_sync(p, ctx, dry_run=True, progress=progress)

    updates = [
        e
        for e in progress.events
        if e["kind"] == "update" and e["task_id"] == "precorrect-cross-track"
    ]
    assert any(e["current"] == 50 for e in updates)


def test_cross_track_sync_progress_on_low_similarity_batch() -> None:
    p, ctx = _two_track_words()
    pairs = [_overlap_pair(i, low_sim=True) for i in range(50)]
    progress = RecordingProgress()
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": pairs},
    ):
        run_cross_track_sync(p, ctx, dry_run=True, progress=progress)

    updates = [
        e
        for e in progress.events
        if e["kind"] == "update" and e["task_id"] == "precorrect-cross-track"
    ]
    assert any(e["current"] == 50 for e in updates)


def test_cross_track_sync_missing_track_skips_confidence() -> None:
    p, ctx = _two_track_words()
    p.transcripts = [p.transcripts[1]]
    pair = {
        "track_a": "host",
        "word_index_a": 0,
        "text_a": "trooth",
        "start_a": 1.0,
        "status_a": "bleed",
        "track_b": "guest",
        "word_index_b": 0,
        "text_b": "truth",
        "start_b": 1.1,
        "status_b": "audible",
        "overlap_sec": 0.4,
        "text_match": False,
    }
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": [pair]},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True)

    assert report["count"] == 0


def test_cross_track_sync_progress_on_ambiguous_batch() -> None:
    p, ctx = _two_track_words()
    p.transcripts[0].words[0].confidence = 0.9
    p.transcripts[1].words[0].confidence = 0.91
    p.transcripts[1].words[0].audibility_status = "audible"
    pairs = []
    for i in range(50):
        pairs.append(
            {
                "track_a": "host",
                "word_index_a": 0,
                "text_a": "truth",
                "start_a": 1.0 + i * 0.01,
                "status_a": "audible",
                "track_b": "guest",
                "word_index_b": 0,
                "text_b": "trooth",
                "start_b": 1.1 + i * 0.01,
                "status_b": "audible",
                "overlap_sec": 0.4,
                "text_match": False,
            }
        )
    progress = RecordingProgress()
    with patch(
        "podcast_mcp.edits.transcript_precorrect.overlap_duplicate_report",
        return_value={"pairs": pairs},
    ):
        report = run_cross_track_sync(p, ctx, dry_run=True, progress=progress)

    assert report["count"] == 0
    assert len(report["deferred_low_similarity"]) == 50
    updates = [
        e
        for e in progress.events
        if e["kind"] == "update" and e["task_id"] == "precorrect-cross-track"
    ]
    assert any(e["current"] == 50 for e in updates)


def test_glossary_homophone_mismatch_skipped() -> None:
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.3),
        TranscriptWord(text="world", start=0.3, end=0.6),
    ]
    rule = ReplacementRule("goodbye earth", "farewell", "homophone")
    hits = _find_glossary_phrase_matches(words, rule, set())
    assert hits == []
