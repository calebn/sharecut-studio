from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.pipeline.bootstrap import component_status, run_bootstrap
    from podcast_mcp.services.pipeline.config import (
        analyze_working_set,
        asr_options_for,
        build_config_payload,
        config_assignment_paths,
        config_assignments,
        config_store,
        ensure_whisper_cached_for_run,
        merge_pipeline_config,
        parse_config_assignments,
        pipeline_step_states,
        prosody_params_for,
        run_defaults_for,
        skip_steps_from_enabled,
        suggest_pipeline_tuning,
        transcribe_run_config,
    )
    from podcast_mcp.services.pipeline.models import (
        DEFAULT_WHISPER_MODEL,
        DEFAULT_WORD_ALIGNER,
        WHISPER_MODEL_IDS,
        WhisperWeightsMissingError,
        bootstrap_whisper_model,
        bootstrap_word_aligner,
        persist_whisper_model,
        resolve_whisper_model,
        validate_whisper_model,
        word_aligner_is_cached,
    )
    from podcast_mcp.services.pipeline.service import (
        AudioExportResult,
        PipelineRunResult,
        PipelineService,
        format_export_qc_lines,
    )

__all__ = [
    "DEFAULT_WHISPER_MODEL",
    "DEFAULT_WORD_ALIGNER",
    "WHISPER_MODEL_IDS",
    "AudioExportResult",
    "PipelineRunResult",
    "PipelineService",
    "WhisperWeightsMissingError",
    "analyze_working_set",
    "asr_options_for",
    "bootstrap_whisper_model",
    "bootstrap_word_aligner",
    "build_config_payload",
    "component_status",
    "config_assignment_paths",
    "config_assignments",
    "config_store",
    "ensure_whisper_cached_for_run",
    "format_export_qc_lines",
    "merge_pipeline_config",
    "parse_config_assignments",
    "persist_whisper_model",
    "pipeline_step_states",
    "prosody_params_for",
    "resolve_whisper_model",
    "run_bootstrap",
    "run_defaults_for",
    "skip_steps_from_enabled",
    "suggest_pipeline_tuning",
    "transcribe_run_config",
    "validate_whisper_model",
    "word_aligner_is_cached",
]

_MODULE_BY_NAME = {
    "DEFAULT_WHISPER_MODEL": "models",
    "DEFAULT_WORD_ALIGNER": "models",
    "WHISPER_MODEL_IDS": "models",
    "WhisperWeightsMissingError": "models",
    "bootstrap_whisper_model": "models",
    "bootstrap_word_aligner": "models",
    "persist_whisper_model": "models",
    "resolve_whisper_model": "models",
    "validate_whisper_model": "models",
    "word_aligner_is_cached": "models",
    "AudioExportResult": "service",
    "PipelineRunResult": "service",
    "PipelineService": "service",
    "format_export_qc_lines": "service",
    "component_status": "bootstrap",
    "run_bootstrap": "bootstrap",
    "analyze_working_set": "config",
    "asr_options_for": "config",
    "build_config_payload": "config",
    "config_assignment_paths": "config",
    "config_assignments": "config",
    "config_store": "config",
    "ensure_whisper_cached_for_run": "config",
    "merge_pipeline_config": "config",
    "parse_config_assignments": "config",
    "pipeline_step_states": "config",
    "prosody_params_for": "config",
    "run_defaults_for": "config",
    "skip_steps_from_enabled": "config",
    "suggest_pipeline_tuning": "config",
    "transcribe_run_config": "config",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
