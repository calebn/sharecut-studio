"""Wire shapes of the golden-ear build and score results and of one key.json pair row (#1811).

``build_golden_ear`` and ``score_golden_ear`` return these dicts; ``write_json_atomic`` does
not sort keys, so a TypedDict's declaration order is the order on disk (and in ``--json``
output). ``PairRow`` and ``ScoreReport`` use the functional syntax because ``class`` and
``pass`` are keywords. The key.json head, the manifest and the csv answer rows stay open
mappings, and so does ``JoinDetectorWire.detail`` (its keys vary per detector).
``AudioRoleEntry`` is the one type whose key order is not fixed: ``error`` is written in
place when astats finds no metrics (after ``astats``) or when a step raises (wherever the
step failed). In ``PairRow`` the optional ``audition_context_error`` precedes the four wav keys
that ``**wavs`` spreads last.
"""

from typing import Any, Literal, NotRequired

from typing_extensions import TypedDict

from podcast_mcp.services.document.analysis_report_results import FfmpegAstats, MainsHum
from podcast_mcp.services.document.play_compose_results import AuditionContextReport

GoldenEarClass = Literal["filler", "pause", "repetition", "restart"]


class SourceFingerprint(TypedDict):
    path: str
    mtime_ns: int
    size: int


class WavPair(TypedDict):
    leave_file: str
    edit_file: str
    play_start: float
    play_end: float


class AudioRoleEntry(TypedDict):
    file: str
    astats: NotRequired[FfmpegAstats]
    hum: NotRequired[MainsHum]
    waveform_png: NotRequired[str]
    error: NotRequired[str]


class PairAudioDiagnostics(TypedDict):
    source: Literal["rendered_pair_wavs"]
    current: AudioRoleEntry
    suggested: AudioRoleEntry


class JoinDetectorWire(TypedDict):
    name: str
    score: float
    weight: float
    detail: dict[str, Any]


class JoinRankerWire(TypedDict):
    available: bool
    fail_proba: float
    threshold: float
    n_train: int


class JoinQualityWire(TypedDict):
    """``JoinQualityReport.model_dump()``; field order mirrors the model."""

    track_id: str
    mode: Literal["existing_join", "proposed_cut"]
    join_sec: float
    timebase: Literal["timeline", "source"]
    risk: float
    invisibility: float
    verdict: Literal["pass", "review", "fail"]
    reasons: list[str]
    detectors: list[JoinDetectorWire]
    calibrated: bool
    natural_p95: float | None
    side_sec: float
    disclaimer: str
    ranker: JoinRankerWire | None


class JoinQualityError(TypedDict):
    verdict: Literal["error"]
    error: str


JoinMetrics = JoinQualityWire | JoinQualityError

PairRow = TypedDict(
    "PairRow",
    {
        "id": str,
        "edit_id": str,
        "reason": str | None,
        "class": GoldenEarClass,
        "track_id": str,
        "start": float,
        "end": float,
        "gated": bool,
        "join_quality": JoinMetrics,
        "audition_context": AuditionContextReport | None,
        "audition_context_source": Literal["project_timeline_metadata_only"],
        "pair_diagnostics": PairAudioDiagnostics,
        "audition_context_error": NotRequired[str],
        "leave_file": str,
        "edit_file": str,
        "play_start": float,
        "play_end": float,
    },
)


class BuildResult(TypedDict):
    out_dir: str
    listen_dir: str
    pair_count: int
    skipped_unsuggestable: int
    workspace: str


class AcceptanceRollup(TypedDict):
    n: int
    answered_n: int
    missing_n: int
    prefer_edit: float | None
    prefer_edit_answered: float | None
    ties: int
    leftover_consonant_fails: int


class PerClassRollups(TypedDict):
    """One rollup per ``ALLOWED_CLASSES`` entry, in that order."""

    filler: AcceptanceRollup
    pause: AcceptanceRollup
    repetition: AcceptanceRollup
    restart: AcceptanceRollup


ScoreReport = TypedDict(
    "ScoreReport",
    {
        "n_answers": int,
        "gated_n": int,
        "all_n": int,
        "pair_count": int,
        "missing_n": int,
        "min_gated_n": int,
        "prefer_edit_all": float | None,
        "prefer_edit_gated": float | None,
        "per_class": PerClassRollups,
        "per_reason": dict[str, AcceptanceRollup],
        "per_track": dict[str, AcceptanceRollup],
        "leftover_consonant_fails": int,
        "bar": str,
        "pass": bool,
        "fail_reasons": list[str],
    },
)
