from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services import ProjectWorkspace, SpeakerService
from podcast_mcp.util.progress import resolve_progress


def speaker_doctor_tool() -> str:
    return to_json(SpeakerService.doctor_static())


def speaker_enroll_tool(
    project_path: str,
    track_id: str | None = None,
    speaker_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    home_track_id: str | None = None,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        SpeakerService(ws).enroll(
            track_id=track_id,
            speaker_id=speaker_id,
            start_sec=start_sec,
            end_sec=end_sec,
            home_track_id=home_track_id,
            progress=resolve_progress(),
        )
    )


def speaker_profiles_tool(project_path: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(SpeakerService(ws).profiles())


def speaker_score_tool(
    project_path: str,
    track_id: str,
    start_sec: float,
    end_sec: float,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(SpeakerService(ws).score(track_id, start_sec, end_sec))


def speaker_compare_window_tool(
    project_path: str,
    start_sec: float,
    end_sec: float,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(SpeakerService(ws).compare_window(start_sec, end_sec))


def speaker_label_tool(
    project_path: str,
    track_id: str,
    start_sec: float,
    end_sec: float,
    dry_run: bool = True,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(SpeakerService(ws).label(track_id, start_sec, end_sec, dry_run=dry_run))


def speaker_set_count_tool(
    project_path: str,
    expected_speaker_count: int,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(SpeakerService(ws).set_expected_speaker_count(expected_speaker_count))


def speaker_attribute_tool(
    project_path: str,
    dry_run: bool = True,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(SpeakerService(ws).attribute(dry_run=dry_run, progress=resolve_progress()))


def speaker_gate_track_tool(
    project_path: str,
    track_id: str | None = None,
    dry_run: bool = True,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        SpeakerService(ws).gate_track(
            track_id=track_id,
            dry_run=dry_run,
            progress=resolve_progress(),
        )
    )


def speaker_compare_pair_tool(
    project_path: str,
    track_a: str,
    start_a: float,
    end_a: float,
    track_b: str,
    start_b: float,
    end_b: float,
) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        SpeakerService(ws).compare_pair(track_a, start_a, end_a, track_b, start_b, end_b)
    )


def register(mcp: MCPServer) -> None:
    mcp.tool()(speaker_doctor_tool)
    mcp.tool()(speaker_enroll_tool)
    mcp.tool()(speaker_profiles_tool)
    mcp.tool()(speaker_score_tool)
    mcp.tool()(speaker_compare_window_tool)
    mcp.tool()(speaker_compare_pair_tool)
    mcp.tool()(speaker_label_tool)
    mcp.tool()(speaker_set_count_tool)
    mcp.tool()(speaker_attribute_tool)
    mcp.tool()(speaker_gate_track_tool)
