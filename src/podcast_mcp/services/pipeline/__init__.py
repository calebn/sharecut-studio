from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.pipeline.bootstrap import (
        BootstrapRequest,
        component_status,
        install_model,
        model_status,
        run_bootstrap,
    )
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
    from podcast_mcp.services.pipeline.install_failure import InstallFailure, unexpected_text
    from podcast_mcp.services.pipeline.models import (
        DEFAULT_WHISPER_MODEL,
        MODELS,
        WHISPER_MODEL_IDS,
        WhisperWeightsMissingError,
        models_for,
        persist_whisper_model,
        resolve_whisper_model,
        validate_whisper_model,
    )
    from podcast_mcp.services.pipeline.preview import render_preview_result, rerender_preview
    from podcast_mcp.services.pipeline.service import (
        AudioExportResult,
        PipelineRunResult,
        PipelineService,
        format_export_qc_lines,
    )

__all__ = [
    "DEFAULT_WHISPER_MODEL",
    "MODELS",
    "WHISPER_MODEL_IDS",
    "AudioExportResult",
    "BootstrapRequest",
    "InstallFailure",
    "PipelineRunResult",
    "PipelineService",
    "WhisperWeightsMissingError",
    "analyze_working_set",
    "asr_options_for",
    "build_config_payload",
    "component_status",
    "config_assignment_paths",
    "config_assignments",
    "config_store",
    "ensure_whisper_cached_for_run",
    "format_export_qc_lines",
    "install_model",
    "merge_pipeline_config",
    "model_status",
    "models_for",
    "parse_config_assignments",
    "persist_whisper_model",
    "pipeline_step_states",
    "prosody_params_for",
    "render_preview_result",
    "rerender_preview",
    "resolve_whisper_model",
    "run_bootstrap",
    "run_defaults_for",
    "skip_steps_from_enabled",
    "suggest_pipeline_tuning",
    "transcribe_run_config",
    "unexpected_text",
    "validate_whisper_model",
]

_MODULE_BY_NAME = {
    "DEFAULT_WHISPER_MODEL": "models",
    "MODELS": "models",
    "models_for": "models",
    "BootstrapRequest": "bootstrap",
    "InstallFailure": "install_failure",
    "unexpected_text": "install_failure",
    "install_model": "bootstrap",
    "model_status": "bootstrap",
    "WHISPER_MODEL_IDS": "models",
    "WhisperWeightsMissingError": "models",
    "persist_whisper_model": "models",
    "resolve_whisper_model": "models",
    "validate_whisper_model": "models",
    "AudioExportResult": "service",
    "PipelineRunResult": "service",
    "PipelineService": "service",
    "format_export_qc_lines": "service",
    "render_preview_result": "preview",
    "rerender_preview": "preview",
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
