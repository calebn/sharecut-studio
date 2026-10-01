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
    from podcast_mcp.services.app.workspace import MERGED_HISTORY_LABEL, ProjectWorkspace

__all__ = [
    "MERGED_HISTORY_LABEL",
    "PACKAGED_CLI_ENV",
    "PACKAGED_CLI_GUI_REFUSAL",
    "FanoutHub",
    "GuiLaunchResult",
    "ProjectWorkspace",
    "drop_oldest_overflow",
    "ensure_viewer",
    "is_viewer_up",
    "packaged_cli_gui_refusal",
    "resolve_gui_static_root",
    "viewer_url",
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
    "MERGED_HISTORY_LABEL": "workspace",
    "ProjectWorkspace": "workspace",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
