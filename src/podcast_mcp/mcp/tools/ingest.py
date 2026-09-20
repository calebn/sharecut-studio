from __future__ import annotations

import json
from pathlib import Path

from mcp.server import MCPServer

from podcast_mcp.ingest.manifest import IngestManifest
from podcast_mcp.services.ingest import (
    IngestService,
    import_folder_report_to_dict,
    suggest_alignment_for_manifest,
    suggest_result_to_dict,
    verify_result_to_dict,
)
from podcast_mcp.services.play import PlayRequest, PlayService
from podcast_mcp.services.workspace import ProjectWorkspace


def ingest_import_folder_tool(
    audio_dir: str,
    out_manifest: str | None = None,
    speakers_override: dict[str, str] | None = None,
    dry_run: bool = False,
) -> str:
    """Scan a recorder export folder and write ingest.yaml (audio-only, no copy)."""
    result = IngestService.import_recorder_folder(
        Path(audio_dir),
        out_manifest=Path(out_manifest) if out_manifest else None,
        speakers_override=speakers_override,
        dry_run=dry_run,
    )
    return json.dumps(import_folder_report_to_dict(result), indent=2)


def ingest_suggest_alignment_tool(
    audio_dir: str,
    manifest_path: str,
    analysis_start_sec: float = 0.0,
    analysis_duration_sec: float = 90.0,
    sweep_start_min: float = 0.0,
    sweep_start_max: float = 240.0,
    sweep_step: float = 5.0,
    waveform_top_n: int = 3,
    diag_dir: str | None = None,
) -> str:
    """Propose session_start offsets for multitrack ingest before consolidate."""
    manifest = IngestManifest.load(Path(manifest_path))
    result = suggest_alignment_for_manifest(
        manifest,
        Path(audio_dir),
        analysis_start_sec=analysis_start_sec,
        analysis_duration_sec=analysis_duration_sec,
        sweep_start_min=sweep_start_min,
        sweep_start_max=sweep_start_max,
        sweep_step=sweep_step,
        waveform_top_n=waveform_top_n,
        diag_dir=Path(diag_dir) if diag_dir else None,
    )
    return json.dumps(suggest_result_to_dict(result), indent=2)


def ingest_verify_alignment_tool(
    project_path: str,
    window_start_sec: float = 0.0,
    window_end_sec: float = 90.0,
    write_waveforms: bool = True,
    diag_dir: str | None = None,
) -> str:
    """Audit consolidated dialogue tracks with VAD overlap on a timeline window."""
    ws = ProjectWorkspace.open(project_path)
    result = IngestService(ws).verify_alignment(
        window_start_sec=window_start_sec,
        window_end_sec=window_end_sec,
        write_waveforms=write_waveforms,
        diag_dir=Path(diag_dir) if diag_dir else None,
    )
    return json.dumps(verify_result_to_dict(result), indent=2)


def play_compare_tool(
    project_path: str,
    start_sec: float = 0.0,
    end_sec: float = 90.0,
    dry_run: bool = True,
    rerender: bool = False,
) -> str:
    """Play each dialogue track then premix for the same timeline range."""
    ws = ProjectWorkspace.open(project_path)
    result = PlayService(ws).play(
        PlayRequest(
            source="premix",
            start_sec=start_sec,
            end_sec=end_sec,
            compare=True,
            rerender=rerender,
        ),
        dry_run=dry_run,
    )
    payload = {
        "source": result.source_label,
        "start_sec": result.start_sec,
        "end_sec": result.end_sec,
        "tier": result.tier,
        "compare_segments": result.compare_segments or [],
    }
    return json.dumps(payload, indent=2)


def register(mcp: MCPServer) -> None:
    mcp.tool()(ingest_import_folder_tool)
    mcp.tool()(ingest_suggest_alignment_tool)
    mcp.tool()(ingest_verify_alignment_tool)
    mcp.tool()(play_compare_tool)
