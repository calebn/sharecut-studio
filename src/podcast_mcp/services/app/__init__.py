from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.app.fanout_hub import FanoutHub, drop_oldest_overflow
    from podcast_mcp.services.app.gui_launch import (
        PACKAGED_CLI_ENV,
        PACKAGED_CLI_GUI_REFUSAL,
        GuiLaunchResult,
        ensure_viewer,
        is_viewer_up,
        packaged_cli_gui_refusal,
        resolve_gui_static_root,
        viewer_url,
    )
    from podcast_mcp.services.app.review_gate import ReviewGateService
    from podcast_mcp.services.app.studio_host import (
        DIRECT_ENV_VAR,
        DIRECT_RUN_REFUSAL_CODES,
        HANDOFF_PROTOCOL,
        HANDOFF_TOKEN_HEADER,
        HandoffLost,
        HandoffRefused,
        StudioBadReply,
        StudioHost,
        StudioNotReachable,
        StudioUnresponsive,
        announce_studio_host,
        env_differences,
        hand_off,
        locate_studio,
        new_instance_id,
        new_token,
        read_studio_host,
        studio_host_path,
        withdraw_studio_host,
    )
    from podcast_mcp.services.app.workspace import MERGED_HISTORY_LABEL, ProjectWorkspace

__all__ = [
    "DIRECT_ENV_VAR",
    "DIRECT_RUN_REFUSAL_CODES",
    "HANDOFF_PROTOCOL",
    "HANDOFF_TOKEN_HEADER",
    "MERGED_HISTORY_LABEL",
    "PACKAGED_CLI_ENV",
    "PACKAGED_CLI_GUI_REFUSAL",
    "FanoutHub",
    "GuiLaunchResult",
    "HandoffLost",
    "HandoffRefused",
    "ProjectWorkspace",
    "ReviewGateService",
    "StudioBadReply",
    "StudioHost",
    "StudioNotReachable",
    "StudioUnresponsive",
    "announce_studio_host",
    "drop_oldest_overflow",
    "ensure_viewer",
    "env_differences",
    "hand_off",
    "is_viewer_up",
    "locate_studio",
    "new_instance_id",
    "new_token",
    "packaged_cli_gui_refusal",
    "read_studio_host",
    "resolve_gui_static_root",
    "studio_host_path",
    "viewer_url",
    "withdraw_studio_host",
]

_MODULE_BY_NAME = {
    "FanoutHub": "fanout_hub",
    "drop_oldest_overflow": "fanout_hub",
    "PACKAGED_CLI_ENV": "gui_launch",
    "PACKAGED_CLI_GUI_REFUSAL": "gui_launch",
    "GuiLaunchResult": "gui_launch",
    "ensure_viewer": "gui_launch",
    "is_viewer_up": "gui_launch",
    "packaged_cli_gui_refusal": "gui_launch",
    "resolve_gui_static_root": "gui_launch",
    "viewer_url": "gui_launch",
    "ReviewGateService": "review_gate",
    "DIRECT_ENV_VAR": "studio_host",
    "DIRECT_RUN_REFUSAL_CODES": "studio_host",
    "HANDOFF_PROTOCOL": "studio_host",
    "HANDOFF_TOKEN_HEADER": "studio_host",
    "HandoffLost": "studio_host",
    "HandoffRefused": "studio_host",
    "StudioBadReply": "studio_host",
    "StudioHost": "studio_host",
    "StudioNotReachable": "studio_host",
    "StudioUnresponsive": "studio_host",
    "announce_studio_host": "studio_host",
    "env_differences": "studio_host",
    "hand_off": "studio_host",
    "locate_studio": "studio_host",
    "new_instance_id": "studio_host",
    "new_token": "studio_host",
    "read_studio_host": "studio_host",
    "studio_host_path": "studio_host",
    "withdraw_studio_host": "studio_host",
    "MERGED_HISTORY_LABEL": "workspace",
    "ProjectWorkspace": "workspace",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
