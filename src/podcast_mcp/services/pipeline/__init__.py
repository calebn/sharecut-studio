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
        skip_steps_from_enabled,
        suggest_pipeline_tuning,
        transcribe_run_config,
    )
    from podcast_mcp.services.pipeline.service import (
        PipelineRunResult,
        PipelineService,
        format_export_qc_lines,
    )

__all__ = [
    "PipelineRunResult",
    "PipelineService",
    "analyze_working_set",
    "asr_options_for",
    "build_config_payload",
    "component_status",
    "config_assignment_paths",
    "config_assignments",
    "config_store",
    "ensure_whisper_cached_for_run",
    "format_export_qc_lines",
    "merge_pipeline_config",
    "parse_config_assignments",
    "pipeline_step_states",
    "prosody_params_for",
    "run_bootstrap",
    "skip_steps_from_enabled",
    "suggest_pipeline_tuning",
    "transcribe_run_config",
]

_MODULE_BY_NAME = {
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
    "skip_steps_from_enabled": "config",
    "suggest_pipeline_tuning": "config",
    "transcribe_run_config": "config",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
