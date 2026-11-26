"""Pin the public surface of AnalysisService so a refactor-only move
(e.g. into AnalysisReportService) cannot silently change it."""

from __future__ import annotations

import inspect

import podcast_mcp.services.document.analysis as analysis_module
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.document.effects import EffectsService

PINNED_SIGNATURES: dict[str, str] = {
    "add_effect": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, preset: 'str | None' = None, effect: 'str | None' = None, params: 'dict[str, Any] | None' = None) -> 'AddEffectResult'",
    "align_retained_bleed": "(self, *, track_id: 'str | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, apply: 'bool' = True, override_placement_lock: 'bool' = False, lock_timeout: 'float' = 3600.0) -> 'RetainedBleedAlignmentPreview | RetainedBleedAlignmentApplied'",
    "analyze_cleanup": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, progress: 'ProgressReporter | None' = None) -> 'dict'",
    "apply_bleed_mute": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, apply: 'bool' = True, align_retained_bleed: 'bool' = True, override_placement_lock: 'bool' = False, progress: 'ProgressReporter | None' = None, lock_timeout: 'float' = 3600.0, cancel_check: 'Callable[[], bool] | None' = None) -> 'dict'",
    "apply_fade_recommendations": "(self, recommendations: 'list[dict]') -> 'AppliedFadeUpdates'",
    "apply_fade_recommendations_for_track": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None) -> 'AppliedFadeRecommendations'",
    "audibility_map": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, progress: 'ProgressReporter | None' = None) -> 'list[dict]'",
    "audio_diagnostics": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None) -> 'dict'",
    "check_loudness": "(self, audio_path: 'str | None' = None) -> 'LoudnessReport'",
    "flagged_words": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, progress: 'ProgressReporter | None' = None) -> 'list[dict]'",
    "gate_overreach": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, progress: 'ProgressReporter | None' = None) -> 'dict'",
    "list_bleed_words": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, progress: 'ProgressReporter | None' = None) -> 'list[dict]'",
    "list_effects": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None) -> 'EffectTrackListResult | EffectPresetListResult'",
    "low_audibility_words": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, progress: 'ProgressReporter | None' = None) -> 'list[dict]'",
    "mute_off_speaker": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, apply: 'bool' = True, progress: 'ProgressReporter | None' = None, lock_timeout: 'float' = 3600.0) -> 'OffSpeakerPreview | OffSpeakerSummary | OffSpeakerApplied'",
    "overlap_duplicates": "(self, *, start_sec: 'float | None' = None, end_sec: 'float | None' = None, progress: 'ProgressReporter | None' = None) -> 'OverlapDuplicateReport'",
    "preview_bleed_mute": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, align_retained_bleed: 'bool' = True, override_placement_lock: 'bool' = False, progress: 'ProgressReporter | None' = None) -> 'dict'",
    "preview_inaudible_cut": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, start: 'float', end: 'float', timeline: 'bool' = False) -> 'InaudibleCutPreview'",
    "preview_off_speaker_mute": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, progress: 'ProgressReporter | None' = None) -> 'OffSpeakerPreview'",
    "preview_reconcile_transcript": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, progress: 'ProgressReporter | None' = None) -> 'dict'",
    "preview_retained_bleed_alignment": "(self, *, track_id: 'str | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, override_placement_lock: 'bool' = False) -> 'RetainedBleedAlignmentPreview'",
    "preview_suppress_bleed": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, word_keys: 'list[dict] | None' = None, exclude_word_keys: 'list[dict] | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, progress: 'ProgressReporter | None' = None) -> 'dict'",
    "recommend_fades": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None) -> 'list[dict]'",
    "reconcile_transcript": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, dry_run: 'bool | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, progress: 'ProgressReporter | None' = None) -> 'dict'",
    "reconciliation_status": "(self) -> 'dict'",
    "remove_effect": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, effect: 'str | None' = None) -> 'RemoveEffectResult'",
    "set_bleed_alignment_mode": "(self, decision_id: 'str', mode: \"Literal['auto', 'manual', 'declined']\", *, track_id: 'str | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, override_placement_lock: 'bool' = False) -> 'RetainedBleedAlignmentModeResult'",
    "set_effect_bypass": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, effect_index: 'int', bypass: 'bool') -> 'EffectBypassResult'",
    "strip_silence": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, over_voice_floor_db: 'float' = 0.0, min_duration_sec: 'float' = 0.5, use_inaudible_opt: 'bool | None' = None) -> 'StripSilenceResult'",
    "suggest_handoff_cut": "(self, *, keep_left_end: 'float', keep_right_start: 'float', track_id: 'str | None' = None, speaker: 'str | None' = None, min_island_sec: 'float' = 0.12, hop_ms: 'int' = 20, retain_sec: 'float' = 1.0) -> 'dict'",
    "suppress_bleed": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, word_keys: 'list[dict] | None' = None, exclude_word_keys: 'list[dict] | None' = None, start_sec: 'float | None' = None, end_sec: 'float | None' = None, apply: 'bool' = True, progress: 'ProgressReporter | None' = None) -> 'dict'",
    "suppress_low_audibility": "(self, *, track_id: 'str | None' = None, speaker: 'str | None' = None, word_keys: 'list[dict] | None' = None) -> 'dict'",
    "waveform_snap_window": "(self, *, track_id: 'str', start: 'float', end: 'float', timeline: 'bool' = False, focus: 'float | None' = None) -> 'WaveformSnapWindow'",
}

ALLOWED_OWNERS = ("AnalysisService", "AnalysisReportService", "EffectsService")
# Methods currently inherited from EffectsService stay there.
EFFECTS_METHODS = {
    n for n, _ in inspect.getmembers(EffectsService, callable) if not n.startswith("_")
}


def _public_callables() -> set[str]:
    return {
        n
        for n in dir(AnalysisService)
        if not n.startswith("_") and callable(getattr(AnalysisService, n))
    }


def test_public_method_set_exact():
    assert _public_callables() == set(PINNED_SIGNATURES)


def test_no_public_noncallable_attributes():
    extra = [
        n
        for n in dir(AnalysisService)
        if not n.startswith("_") and not callable(getattr(AnalysisService, n))
    ]
    assert extra == []


def test_every_method_exists_and_callable():
    for name in PINNED_SIGNATURES:
        assert callable(getattr(AnalysisService, name)), name


def test_signatures_pinned():
    actual = {n: str(inspect.signature(getattr(AnalysisService, n))) for n in PINNED_SIGNATURES}
    assert actual == PINNED_SIGNATURES


def test_qualnames_accepted_locations_only():
    for name in PINNED_SIGNATURES:
        qn = getattr(AnalysisService, name).__qualname__
        allowed = {f"AnalysisService.{name}", f"AnalysisReportService.{name}"}
        if name in EFFECTS_METHODS:
            allowed.add(f"EffectsService.{name}")
        assert qn in allowed, (name, qn)


def test_mro_keeps_effects_service_after_analysis_service():
    mro = AnalysisService.__mro__
    assert mro[0] is AnalysisService
    assert EffectsService in mro[1:]
    assert mro.index(EffectsService) > mro.index(AnalysisService)


def test_package_export_is_analysis_module_class():
    assert AnalysisService is analysis_module.AnalysisService
    assert AnalysisService.__module__ == "podcast_mcp.services.document.analysis"
    assert AnalysisService.__name__ == "AnalysisService"
