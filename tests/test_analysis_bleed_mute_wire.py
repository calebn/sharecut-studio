"""Pin the exact wire output of apply_bleed_mute and preview_bleed_mute on every surface."""

from __future__ import annotations

import json
import wave
from contextlib import nullcontext
from pathlib import Path
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import retained_bleed_alignment
from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.mcp.tools import transcript
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SpeakerIngestAlignment,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.jobs import run_audio_edit
from podcast_mcp.services.pipeline.preview import rerender_preview
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.project_state import RENDER_LOCK_TIMEOUT_SEC

pytestmark = pytest.mark.unscoped_ok

RATE = 48_000


@pytest.fixture(autouse=True)
def _copy_evidence(one_phrase_copy_evidence):
    yield


def _abstain():
    return patch.object(
        retained_bleed_alignment,
        "build_bleed_gate_plan",
        lambda *args, **kwargs: BleedGatePlan(reasons=("uncertain_foreign_ownership",)),
    )


def _write(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        out.writeframes(np.round(samples * 32767).astype("<i2").tobytes())


def _episode(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("retained copy", str(tmp_path))
    project.ensure_dirs()
    rng = np.random.default_rng(19)
    direct = np.zeros(6 * RATE)
    direct[int(1.2 * RATE) : int(3.2 * RATE)] = rng.normal(0, 0.08, 2 * RATE)
    direct[4 * RATE : int(4.4 * RATE)] = rng.normal(0, 0.07, int(0.4 * RATE))
    mixed = np.zeros_like(direct)
    mixed[: -int(0.15 * RATE)] = direct[int(0.15 * RATE) :] * 0.2
    lo, hi = int(1.05 * RATE), int(3.05 * RATE)
    mixed[lo:hi] += 0.003 * np.sin(2 * np.pi * 183 * np.arange(hi - lo) / RATE)
    for tid, samples in (("direct", direct), ("uncertain", mixed)):
        _write(tmp_path / "raw" / f"{tid}.wav", samples)
        project.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=6),
            )
        )
        project.clips.append(
            Clip(id=f"clip-{tid}", track_id=tid, source_start=0, source_end=6, timeline_start=0)
        )
    bleed = TranscriptWord(
        text="whole phrase",
        start=1.15,
        end=2.95,
        suppressed=True,
        audibility_status="bleed",
        dominant_track="direct",
    )
    project.transcripts = [
        Transcript(
            track_id="direct",
            words=[
                TranscriptWord(text="whole", start=1.3, end=2.1),
                TranscriptWord(text="phrase", start=2.2, end=3.1),
                TranscriptWord(text="later", start=4.05, end=4.3),
            ],
        ),
        Transcript(track_id="uncertain", words=[bleed]),
    ]
    return project


def _workspace(tmp_path: Path, kind: str) -> ProjectWorkspace:
    project = _episode(tmp_path)
    if kind == "manual":
        project.meta.ingest_alignment = {"direct": SpeakerIngestAlignment(align_method="manual")}
    rerender_preview(project, reconcile=False, defaults=load_defaults())
    if kind == "no_stems":
        for stem in (tmp_path / "artifacts" / "tracks").glob("*.wav"):
            stem.unlink()
    ws = ProjectWorkspace(tmp_path / "episode.sharecut", project)
    ws.save()
    return ws


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def _seal(node: dict[str, Any]) -> dict[str, Any]:
    if "media_seals" in node:
        node["media_seals"] = dict.fromkeys(node["media_seals"], "<seal>")
    return node


def _norm(text: str, ws: ProjectWorkspace) -> dict[str, Any]:
    return json.loads(text.replace(str(ws.path.parent), "<ws>"), object_hook=_seal)


def _cli_args(ws: ProjectWorkspace, kwargs: dict[str, Any], dry_run: bool) -> list[str]:
    args = ["edit", "apply-bleed-mute", "--project", str(ws.path)]
    for key, flag in (("track_id", "--track"), ("speaker", "--speaker")):
        args += [flag, kwargs[key]] if key in kwargs else []
    for key, flag in (("start_sec", "--start"), ("end_sec", "--end")):
        args += [flag, str(kwargs[key])] if key in kwargs else []
    if kwargs.get("align_retained_bleed") is False:
        args.append("--no-align-retained-bleed")
    if kwargs.get("override_placement_lock"):
        args.append("--override-placement-lock")
    return [*args, "--dry-run"] if dry_run else args


def _invoke(surface: str, ws: ProjectWorkspace, kwargs: dict[str, Any]) -> str:
    service = AnalysisService(ws)
    path = str(ws.path)
    if surface == "service_preview":
        return _dump(service.apply_bleed_mute(apply=False, **kwargs))
    if surface == "service_apply":
        return _dump(service.apply_bleed_mute(**kwargs))
    if surface == "preview":
        return _dump(service.preview_bleed_mute(**kwargs))
    if surface == "mcp_dry_run":
        return transcript.apply_transcript_gate_tool(path, dry_run=True, **kwargs)
    if surface == "mcp_apply_false":
        return transcript.apply_transcript_gate_tool(path, apply=False, **kwargs)
    if surface == "mcp_apply":
        return transcript.apply_transcript_gate_tool(path, **kwargs)
    if surface == "job":
        timeout = RENDER_LOCK_TIMEOUT_SEC
        return _dump(run_audio_edit(ws, "apply_bleed_mute", kwargs, lock_timeout=timeout))
    result = CliRunner().invoke(app, _cli_args(ws, kwargs, surface == "cli_dry_run"))
    assert result.exit_code == 0, result.output
    return result.output


_DRY = ["service_preview", "preview", "mcp_dry_run", "mcp_apply_false", "cli_dry_run"]
_APPLY = ["service_apply", "mcp_apply", "cli_apply", "job"]


def _unc(window=(0.0, 6.0), spans=((0.76, 3.2),), **extra):
    return {
        "attenuation_count": len(spans),
        "attenuation_spans": [list(span) for span in spans],
        "bleed_bed_db": -75.0,
        "bleed_reduction": "mute",
        "duration_sec": 6.0,
        "gate_reasons": [],
        "interval_count": 0,
        "room_tone_fill": None,
        "room_tone_fill_reason": "no noise measured under its speech",
        "stem_path": "<ws>/artifacts/tracks/uncertain.wav",
        "suppressed_words": 1,
        "track_id": "uncertain",
        "window_end": window[1],
        "window_start": window[0],
        "word_count": 1,
        **extra,
    }


def _direct(window=(0.0, 6.0), intervals=2):
    return {
        **_unc(window, spans=()),
        "gate_reasons": ["uncertain_foreign_ownership"],
        "interval_count": intervals,
        "room_tone_fill_reason": None,
        "stem_path": "<ws>/artifacts/tracks/direct.wav",
        "suppressed_words": 0,
        "track_id": "direct",
        "word_count": 3,
    }


_REVIEW = {
    "automatic_refusal_reasons": [],
    "clip_id": "clip-uncertain",
    "peer_track_id": "direct",
    "protection_basis": "transcript_metadata_only",
    "requires_review": True,
    "source_end": 2.95,
    "source_id": None,
    "source_start": 1.15,
    "target": {
        "clips": [
            {
                "fade_in_ms": 0,
                "fade_out_ms": 0,
                "id": "clip-uncertain",
                "join_in_mode": "fade",
                "mute_regions": [],
                "source_end": 6.0,
                "source_id": None,
                "source_start": 0.0,
                "timeline_start": 0.0,
                "track_id": "uncertain",
            }
        ],
        "intervals": [{"end": 2.95, "start": 1.15}],
        "kind": "exact_range",
        "media_seals": {"uncertain": "<seal>"},
        "track_ids": ["uncertain"],
    },
    "timeline_end": 2.95,
    "timeline_start": 1.15,
    "track_id": "uncertain",
}
_EXCLUSIONS = [
    {"end": end, "reason": "retained_word", "start": start, "track_id": "direct"}
    for start, end in ((1.3, 2.1), (2.2, 3.1), (4.05, 4.3))
]
_SHIFTED_EXCLUSIONS = [
    {**row, "start": start, "end": end}
    for row, (start, end) in zip(
        _EXCLUSIONS,
        ((1.1500000000000001, 1.9500000000000002), (2.0500000000000003, 2.95), (4.05, 4.3)),
        strict=True,
    )
]
_NO_ELIGIBLE = [{"reason": "no_eligible_review_intervals", "track_id": "direct"}]


def _result(candidates, *, dry_run=True, applied=(), review=(), exclusions=(), reasons=(), **extra):
    return {
        "applied": list(applied),
        "applied_count": len(applied),
        "candidate_count": len(candidates),
        "candidates": list(candidates),
        "dry_run": dry_run,
        "review_candidate_count": len(review),
        "review_candidates": list(review),
        "review_exclusions": list(exclusions),
        "review_exclusions_truncated": False,
        "review_reasons": list(reasons),
        "review_truncated": False,
        "skipped": extra.pop("skipped", []),
        "speaker_errors": None,
        **extra,
    }


_PROPOSAL = {
    "bleed_track_id": "uncertain",
    "clip_id": "clip-direct",
    "decision_id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
    "direct_track_id": "direct",
    "max_residual_ms": 0.0,
    "media_key": "sha256:dfe3edfeca82502862f972cc905af9294021af4e6afaef97cf6ebb29d242c621",
    "offset_sec": -0.15,
    "phrase_source_end": 3.2,
    "phrase_source_start": 1.2,
    "previous_timeline_start": 1.18,
    "provenance": "automatic",
    "reference_track_ids": ["uncertain"],
    "source_end": 3.2199999999999998,
    "source_id": None,
    "source_start": 1.18,
    "timeline_start": 1.03,
    "validation_windows": 5,
}
_SHIFT = {
    "bleed_track_id": "uncertain",
    "decision_id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
    "direct_track_id": "direct",
    "offset_sec": -0.15,
    "previous_timeline_start": 1.18,
    "source_end": 3.2199999999999998,
    "source_id": None,
    "source_start": 1.18,
    "timeline_start": 1.03,
}
_NO_CANDIDATE = {"reason": "no_retained_bleed_candidate", "track_id": "direct"}


def _preview_alignment(proposals=(), skipped=()):
    return {
        "proposals": list(proposals),
        "proposed_count": len(proposals),
        "skipped": list(skipped),
    }


def _applied_alignment(alignments=(), skipped=()):
    return {
        "alignments": list(alignments),
        "applied_count": len(alignments),
        "skipped": list(skipped),
    }


_WINDOW = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5}
_UNC_WINDOW = _unc((0.8, 3.5), [(0.8, 3.2)])
_WINDOW_DRY = _result([_UNC_WINDOW], review=[_REVIEW], alignment=_preview_alignment([_PROPOSAL]))
_WINDOW_DRY_NO_ALIGN = _result([_UNC_WINDOW], review=[_REVIEW])
_WINDOW_APPLIED = _result(
    [_UNC_WINDOW],
    dry_run=False,
    applied=[_UNC_WINDOW],
    review=[_REVIEW],
    alignment=_applied_alignment([_SHIFT]),
)
_WINDOW_APPLIED_NO_ALIGN = _result(
    [_UNC_WINDOW], dry_run=False, applied=[_UNC_WINDOW], review=[_REVIEW]
)
_ALL_SPANS = ((0.76, 3.2), (3.5500000000000003, 4.3999999999999995))
_ALL_CANDIDATES = [_direct(), _unc(spans=_ALL_SPANS)]
_ALL_KW = {"review": [_REVIEW], "exclusions": _EXCLUSIONS, "reasons": _NO_ELIGIBLE}
_ALL_DRY_GATE = _result(
    _ALL_CANDIDATES, alignment=_preview_alignment([], [_NO_CANDIDATE]), **_ALL_KW
)
_ALL_DRY_ABSTAIN = _result(
    _ALL_CANDIDATES,
    alignment=_preview_alignment([_PROPOSAL], [_NO_CANDIDATE]),
    **_ALL_KW,
)
_ALL_APPLIED_ABSTAIN = _result(
    [_direct(), _unc(spans=((0.76, 3.2), (3.7, 4.55)))],
    dry_run=False,
    applied=[_direct(), _unc(spans=((0.76, 3.2), (3.7, 4.55)))],
    alignment=_applied_alignment([_SHIFT], [_NO_CANDIDATE]),
    **{**_ALL_KW, "exclusions": _SHIFTED_EXCLUSIONS},
)
_ALL_APPLIED_GATE = _result(
    _ALL_CANDIDATES,
    dry_run=False,
    applied=_ALL_CANDIDATES,
    alignment=_applied_alignment([], [_NO_CANDIDATE]),
    **_ALL_KW,
)
_MANUAL_SKIP = {"reason": "manual_recorder_placement", "track_id": "direct"}
_STEMS_MISSING = [
    {"reason": "missing_stem", "track_id": track} for track in ("direct", "uncertain")
]
_STALE = {
    "expected_duration_sec": 6.0,
    "reason": "stem_not_fresh",
    "stem_duration_sec": 6.0,
    "track_id": "uncertain",
}
_DIRECT_PROBE = {"track_id": "direct", "start_sec": 5.0, "end_sec": 5.9}
_MISSING_REVIEW = {"reason": "missing_direct_retained_phrase", "track_id": "uncertain"}
_EMPTY_WINDOW = {"track_id": "uncertain", "start_sec": 3.0, "end_sec": 3.0}


_EMPTY_PLAN = _result([], reasons=[{"reason": "empty_review_window", "track_id": "uncertain"}])
_STALE_RESULT = _result(
    [],
    exclusions=[{"end": 2.95, "reason": "retained_word", "start": 1.15, "track_id": "uncertain"}],
    reasons=[{"reason": "no_eligible_review_intervals", "track_id": "uncertain"}],
    skipped=[_STALE],
)


def _review_refused(reason):
    return {**_REVIEW, "automatic_refusal_reasons": [reason]}


_CASES: dict[str, tuple[str, bool, dict[str, Any], bool, dict[str, Any]]] = {
    "window_aligned_dry": ("plain", True, _WINDOW, True, _WINDOW_DRY),
    "window_unaligned_dry": (
        "plain",
        True,
        {**_WINDOW, "align_retained_bleed": False},
        True,
        _WINDOW_DRY_NO_ALIGN,
    ),
    "all_tracks_gate_dry": ("plain", False, {}, True, _ALL_DRY_GATE),
    "all_tracks_abstain_dry": ("plain", True, {}, True, _ALL_DRY_ABSTAIN),
    "manual_lock_dry": (
        "manual",
        True,
        _WINDOW,
        True,
        _result([_UNC_WINDOW], review=[_REVIEW], alignment=_preview_alignment([], [_MANUAL_SKIP])),
    ),
    "manual_override_dry": (
        "manual",
        True,
        {**_WINDOW, "override_placement_lock": True},
        True,
        _result(
            [_UNC_WINDOW],
            review=[_REVIEW],
            alignment=_preview_alignment(
                [{**_PROPOSAL, "provenance": "requested_scoped_override"}]
            ),
        ),
    ),
    "manual_lock_apply": (
        "manual",
        True,
        _WINDOW,
        False,
        {**_WINDOW_APPLIED, "alignment": _applied_alignment([], [_MANUAL_SKIP])},
    ),
    "manual_override_apply": (
        "manual",
        True,
        {**_WINDOW, "override_placement_lock": True},
        False,
        _WINDOW_APPLIED,
    ),
    "direct_window_dry": (
        "plain",
        True,
        _DIRECT_PROBE,
        True,
        _result(
            [_direct((5.0, 5.9), 0)],
            reasons=_NO_ELIGIBLE,
            alignment=_preview_alignment([], [_MISSING_REVIEW, _NO_CANDIDATE]),
        ),
    ),
    "empty_plan_dry": (
        "plain",
        True,
        {**_EMPTY_WINDOW, "align_retained_bleed": False},
        True,
        _EMPTY_PLAN,
    ),
    "empty_plan_apply": (
        "plain",
        True,
        {**_EMPTY_WINDOW, "align_retained_bleed": False},
        False,
        {**_EMPTY_PLAN, "dry_run": False},
    ),
    "no_stems_dry": (
        "no_stems",
        True,
        {},
        True,
        _result(
            [],
            review=[_review_refused("missing_stem")],
            exclusions=_EXCLUSIONS,
            reasons=_NO_ELIGIBLE,
            skipped=_STEMS_MISSING,
            alignment=_preview_alignment([_PROPOSAL], [_NO_CANDIDATE]),
        ),
    ),
    "no_stems_apply": (
        "no_stems",
        True,
        {},
        False,
        {**_ALL_APPLIED_ABSTAIN, "review_candidates": [_REVIEW]},
    ),
    "applied_again_dry": ("applied", True, _WINDOW, True, _STALE_RESULT),
    "applied_again_apply": ("applied", True, _WINDOW, False, {**_STALE_RESULT, "dry_run": False}),
    "window_aligned_apply": ("plain", True, _WINDOW, False, _WINDOW_APPLIED),
    "window_unaligned_apply": (
        "plain",
        True,
        {**_WINDOW, "align_retained_bleed": False},
        False,
        _WINDOW_APPLIED_NO_ALIGN,
    ),
    "all_tracks_gate_apply": ("plain", False, {}, False, _ALL_APPLIED_GATE),
    "all_tracks_abstain_apply": ("plain", True, {}, False, _ALL_APPLIED_ABSTAIN),
}


def _run(tmp_path: Path, name: str, surface: str) -> dict[str, Any]:
    kind, abstain, kwargs, _, _ = _CASES[name]
    ws = _workspace(tmp_path, kind)
    with _abstain() if abstain else nullcontext():
        if kind == "applied":
            AnalysisService(ws).apply_bleed_mute(**_WINDOW)
        return _norm(_invoke(surface, ws, kwargs), ws)


_PARAMS = [
    pytest.param(name, surface, id=f"{name}-{surface}")
    for name, case in _CASES.items()
    for surface in (_DRY if case[3] else _APPLY)
]


@pytest.mark.parametrize(("name", "surface"), _PARAMS)
def test_bleed_mute_wire(tmp_path, name, surface):
    assert _dump(_run(tmp_path, name, surface)) == _dump(_CASES[name][4])


def _stems(ws: ProjectWorkspace) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in (ws.path.parent / "artifacts").rglob("*.wav")}


_ERRORS = {
    "unknown_track": (
        {"track_id": "nobody"},
        "track_not_found",
        "unknown track_id: 'nobody'",
    ),
    "unknown_speaker": (
        {"speaker": "nobody"},
        "track_not_found",
        "no track for speaker 'nobody'; available: direct (direct), uncertain (uncertain)",
    ),
    "override_without_window": (
        {"track_id": "uncertain", "override_placement_lock": True},
        "placement_window_required",
        "placement override requires an explicit scoped window. Pass the scoped window to align.",
    ),
    "empty_window_with_alignment": (
        _EMPTY_WINDOW,
        "invalid_range",
        "alignment window must have nonnegative start and increasing end. "
        "Pass a start at or after 0 and an end after it.",
    ),
}
_RAISING = ["service_preview", "service_apply", "preview", "mcp_dry_run", "mcp_apply", "job"]
_ERROR_PARAMS = [
    pytest.param(name, surface, id=f"{name}-{surface}") for name in _ERRORS for surface in _RAISING
]


@pytest.mark.parametrize(("name", "surface"), _ERROR_PARAMS)
def test_bleed_mute_error_is_coded_and_changes_nothing(tmp_path, name, surface):
    kwargs, code, message = _ERRORS[name]
    ws = _workspace(tmp_path, "plain")
    before = (ws.path.read_bytes(), _stems(ws))
    with pytest.raises(CodedError) as caught:
        _invoke(surface, ws, kwargs)
    assert type(caught.value).__name__ == "CodedValueError"
    assert caught.value.code == code
    assert str(caught.value) == message
    assert (ws.path.read_bytes(), _stems(ws)) == before


@pytest.mark.parametrize("surface", ["cli_dry_run", "cli_apply"])
@pytest.mark.parametrize("name", list(_ERRORS))
def test_bleed_mute_cli_error_text(tmp_path, name, surface):
    kwargs, code, message = _ERRORS[name]
    ws = _workspace(tmp_path, "plain")
    result = CliRunner().invoke(app, _cli_args(ws, kwargs, surface == "cli_dry_run"))
    assert result.exit_code == 1
    assert result.output == (
        f"Error: {message} (code {code}) (set PODCAST_DEBUG=1 for the traceback)\n"
    )


@pytest.mark.parametrize("surface", [*_DRY[:4], "cli_dry_run"])
def test_dry_run_writes_nothing(tmp_path, surface):
    ws = _workspace(tmp_path, "plain")
    before = (ws.path.read_bytes(), _stems(ws))
    with _abstain():
        result = _norm(_invoke(surface, ws, _WINDOW), ws)
    assert result["dry_run"] is True
    assert (ws.path.read_bytes(), _stems(ws)) == before


@pytest.mark.parametrize("surface", _APPLY)
def test_apply_saves_the_gate_and_the_alignment(tmp_path, surface):
    ws = _workspace(tmp_path, "plain")
    with _abstain():
        _invoke(surface, ws, _WINDOW)
    saved = ProjectWorkspace.open(ws.path).project
    assert saved.track_by_id("uncertain").transcript_gate is True
    assert saved.track_by_id("direct").transcript_gate is False
    assert [d.id for d in saved.editorial.retained_bleed_alignments] == [_PROPOSAL["decision_id"]]
