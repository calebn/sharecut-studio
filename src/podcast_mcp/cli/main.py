from __future__ import annotations

import typer

from podcast_mcp.cli import (
    align_cmd,
    clips,
    comment,
    config_cmd,
    edit,
    episode,
    fixture,
    gui,
    history,
    ingest,
    pipeline,
    play,
    record,
    review,
    session_cmd,
    speaker,
    transcript_cmd,
    tunnel,
)
from podcast_mcp.cli import (
    context as cli_context,
)
from podcast_mcp.cli.setup_cmd import bootstrap, doctor, setup
from podcast_mcp.extensions.loader import apply_cli_extensions
from podcast_mcp.util.progress_install import install_cli_progress

app = typer.Typer(
    name="podcast",
    help="Podcast MCP - multitrack podcast production from the CLI.",
    no_args_is_help=True,
)


@app.callback()
def main_callback(
    ctx: typer.Context,
    progress: bool = typer.Option(
        True,
        "--progress/--no-progress",
        help="Show progress indicators on stderr (default: on when stderr is a TTY).",
    ),
    json_progress: bool = typer.Option(
        False,
        "--json-progress",
        help="Emit structured progress events as JSON lines on stderr.",
    ),
) -> None:
    cli_context.configure(progress=progress, json_progress=json_progress)
    # Scope the reporter to this invocation: it may hold the caller's stderr
    # (``--json-progress``), which in-process callers such as CliRunner close
    # once the command returns. Leaving it bound would leak a dead stream into
    # every later ``current_progress()`` in the same process.
    ctx.call_on_close(cli_context.reset_progress)


app.command("setup")(setup)
app.command("doctor")(doctor)
app.command("bootstrap")(bootstrap)

app.add_typer(episode.episode_app, name="episode")
app.add_typer(pipeline.pipeline_app, name="pipeline")
app.add_typer(history.history_app, name="history")
app.add_typer(edit.edit_app, name="edit")
app.add_typer(transcript_cmd.transcript_app, name="transcript")
app.add_typer(speaker.speaker_app, name="speaker")
app.add_typer(clips.clips_app, name="clips")
app.add_typer(comment.comment_app, name="comment")
app.add_typer(review.review_app, name="review")
app.add_typer(ingest.ingest_app, name="ingest")
app.add_typer(align_cmd.align_app, name="align")
app.add_typer(play.play_app, name="play")
app.add_typer(session_cmd.session_app, name="session")
app.add_typer(record.record_app, name="record")
app.add_typer(fixture.fixture_app, name="fixture")
app.add_typer(config_cmd.config_app, name="config")

app.command("transcribe")(episode.transcribe_cmd)
app.command("propose-edits")(edit.propose_edits_cmd)
app.command("apply-edits")(edit.apply_edits_cmd)
app.command("edit-context")(edit.edit_context_cmd)
app.command("export-transcript")(episode.export_transcript_cmd)
app.command("render-preview")(pipeline.render_preview_cmd)
app.command("undo")(history.undo_cmd)
app.command("redo")(history.redo_cmd)
app.command("history-status")(history.history_status_cmd)
app.command("info")(episode.info_cmd)
app.add_typer(gui.gui_app, name="gui")
app.command("tunnel")(tunnel.tunnel_cmd)

apply_cli_extensions(app)
# After all commands (including extension registrars) so every callback is wrapped.
install_cli_progress(app)

if __name__ == "__main__":
    app()
