from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any, Literal, cast

import typer

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.cut_speech import (
    cli_actor,
    cli_override,
    override_audio_checks_option,
    require_cut_applied,
)
from podcast_mcp.edits.cut_speech import CutSpeechConfirmation
from podcast_mcp.edits.decisions import UNSURE_WORD_REASON, AskedEdits, HeldEdit
from podcast_mcp.edits.edit_reasons import NL_RANGE_REASON
from podcast_mcp.edits.source_removals import STALE_REASON, cut_label
from podcast_mcp.edits.tighten_intensity import normalize_tighten_intensity
from podcast_mcp.models import EditMode
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    AnalysisService,
    EditService,
    TimelineService,
    TrimBoundaryTarget,
)
from podcast_mcp.services.document_sync import apply_external_document_edit
from podcast_mcp.services.jobs import run_audio_edit
from podcast_mcp.util.project_state import RENDER_LOCK_TIMEOUT_SEC

edit_app = typer.Typer(help="Transcript-driven cuts for natural language editing.")


@edit_app.command("inspect-clip-bleed")
def inspect_clip_bleed_cmd(
    project: Path = typer.Option(..., "--project"),
    clip: str = typer.Option(..., "--clip"),
    track: str = typer.Option(..., "--track"),
) -> None:
    """Inspect automatic attenuation on one clip and return guarded Restore targets."""
    inspection = TimelineService(ProjectWorkspace.open(project)).inspect_clip_bleed(
        clip, track_id=track
    )
    typer.echo(inspection.model_dump_json(indent=2))


@edit_app.command("restore-clip-bleed")
def restore_clip_bleed_cmd(
    project: Path = typer.Option(..., "--project"),
    target: Path = typer.Option(..., "--target", help="JSON file containing one inspected target."),
    command_id: str | None = typer.Option(
        None, "--command-id", help="Reuse this ID to retry the same submitted Restore."
    ),
) -> None:
    """Save Restore for the inspected occurrence without rendering audio."""
    from podcast_mcp.edits.bleed_restore_targets import BleedRestoreTarget
    from podcast_mcp.services.document_sync import host_command_result, submit_host_document_command

    parsed = BleedRestoreTarget.model_validate_json(target.read_text())
    reply = submit_host_document_command(
        project,
        "RestoreClipBleed",
        {"target": parsed.model_dump(mode="json")},
        client_id="cli:host",
        command_id=command_id,
    )
    typer.echo(json.dumps(host_command_result(reply), indent=2))


def propose_edits_cmd(
    project: Path = typer.Option(..., "--project"),
    edit_mode: str | None = typer.Option(
        None,
        "--edit-mode",
        help="ripple (default from config) or mute (silence in place).",
    ),
    intensity: str | None = typer.Option(
        None,
        "--intensity",
        help="light, medium (default from tighten.intensity), or aggressive preset.",
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit the proposal as JSON"),
) -> None:
    if intensity is not None:
        try:
            intensity = normalize_tighten_intensity(intensity)
        except ValueError as exc:
            raise typer.BadParameter(str(exc), param_hint="--intensity") from exc
    ws = ProjectWorkspace.open(project)
    proposal = apply_external_document_edit(
        ws, lambda: EditService(ws).propose_tighten(edit_mode=edit_mode, intensity=intensity)
    )
    if as_json:
        typer.echo(json.dumps(proposal.to_payload(), indent=2, default=str))
        return
    typer.echo(proposal.summary())


def apply_edits_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    n = apply_external_document_edit(ws, lambda: EditService(ws).apply_auto())
    typer.echo(f"Applied {n} auto edit decisions.")


def edit_context_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(EditService(ws).build_context())


@edit_app.command("search")
def edit_search_cmd(
    project: Path = typer.Option(..., "--project"),
    query: str = typer.Option(..., "--query"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    matches = EditService(ws).search(query, track_id=track, speaker=speaker)
    typer.echo(json.dumps([m.__dict__ for m in matches], indent=2))


@edit_app.command("cut-range")
def edit_cut_range_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str = typer.Option(..., "--track"),
    start: float = typer.Option(..., "--start"),
    end: float = typer.Option(..., "--end"),
    reason: str = typer.Option(NL_RANGE_REASON, "--reason"),
    review: bool = typer.Option(True, "--review/--no-review"),
    inaudible_opt: bool = typer.Option(True, "--inaudible-opt/--no-inaudible-opt"),
) -> None:
    ws = ProjectWorkspace.open(project)
    apply_external_document_edit(
        ws,
        lambda: EditService(ws).cut_time_range(
            track,
            start,
            end,
            reason=reason,
            review_required=review,
            use_inaudible_opt=inaudible_opt,
        ),
    )
    typer.echo(f"Cut {track} {start}-{end}s")


@edit_app.command("cut-text")
def edit_cut_text_cmd(
    project: Path = typer.Option(..., "--project"),
    query: str = typer.Option(..., "--query"),
    track: str | None = typer.Option(None, "--track"),
    all_matches: bool = typer.Option(False, "--all"),
    inaudible_opt: bool = typer.Option(True, "--inaudible-opt/--no-inaudible-opt"),
) -> None:
    ws = ProjectWorkspace.open(project)
    cuts = apply_external_document_edit(
        ws,
        lambda: EditService(ws).cut_text_match(
            query,
            track_id=track,
            match_all=all_matches,
            review_required=True,
            use_inaudible_opt=inaudible_opt,
        ),
    )
    typer.echo(f"Created {len(cuts)} cut(s)")


@edit_app.command("cut-utterance")
def edit_cut_utterance_cmd(
    project: Path = typer.Option(..., "--project"),
    index: int = typer.Option(..., "--index"),
    inaudible_opt: bool = typer.Option(True, "--inaudible-opt/--no-inaudible-opt"),
) -> None:
    ws = ProjectWorkspace.open(project)
    apply_external_document_edit(
        ws, lambda: EditService(ws).cut_utterance(index, use_inaudible_opt=inaudible_opt)
    )
    typer.echo(f"Cut utterance {index}")


@edit_app.command("approve")
def edit_approve_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str | None = typer.Option(None, "--ids", help="Comma-separated edit ids"),
    all_pending: bool = typer.Option(
        False, "--all", help="Approve every pending proposal (a held one is named and stays)"
    ),
    override: bool = override_audio_checks_option(),
) -> None:
    """Approve pending proposals; checks hold unclear ones unless --override-audio-checks."""
    ws = ProjectWorkspace.open(project)
    if all_pending == (ids is not None):
        raise typer.BadParameter("pass --ids or --all (apply-suggested gives each its own action)")
    if all_pending:
        edit_ids = [
            e.id for e in EditService(ws).list_decisions(applied=False, review_required=True)
        ]
    else:
        edit_ids = [x.strip() for x in (ids or "").split(",") if x.strip()]

    held: list[HeldEdit] = []
    asked: list[AskedEdits] = []
    # More than one edit is a bulk approve: cuts over an unsure word stay pending (name one with --ids).
    unsure: list[HeldEdit] = []
    bulk = all_pending or len(set(edit_ids)) > 1

    def approve() -> int | CutSpeechConfirmation:
        with cli_override(override):
            return EditService(ws).approve(
                edit_ids,
                allow_exact=True,
                held_out=held,
                asked_out=asked,
                unsure_out=unsure if bulk else None,
            )

    n = require_cut_applied(lambda: apply_external_document_edit(ws, approve))
    typer.echo(f"Approved {n} edit(s).")
    _echo_held([*held, *unsure], asked)
    if unsure:
        typer.echo(
            "Edits over an unsure word stay pending. Check the words (`podcast transcript review`), "
            "then approve one by name: --ids <id>.",
            err=True,
        )
    if asked or any(item.reason not in (STALE_REASON, UNSURE_WORD_REASON) for item in held):
        typer.echo(
            "Held edits stay pending. Repeat with --ids <id,...> --override-audio-checks "
            "to apply them as they are.",
            err=True,
        )
    if n == 0 and not (held or asked or unsure):
        typer.echo("Warning: no edits were approved — check the edit ids.", err=True)
    if n == 0 and (held or asked or unsure) and not all_pending:
        raise typer.Exit(1)


_HELD_LINES_SHOWN = 8


def _echo_held(held: list[HeldEdit], asked: list[AskedEdits]) -> None:
    """A few held edits are listed one by one; many are summed up by reason."""
    total = len(held) + sum(len(group.edit_ids) for group in asked)
    if total <= _HELD_LINES_SHOWN:
        for item in held:
            typer.echo(f"Held {item.edit_id}: {item.label} ({item.reason}).", err=True)
        for group in asked:
            typer.echo(f"Held {', '.join(group.edit_ids)}: {group.confirmation.message}", err=True)
        return
    reasons = Counter(item.reason for item in held)
    reasons.update({group.confirmation.message: len(group.edit_ids) for group in asked})
    typer.echo(f"Held {total} edit(s):", err=True)
    for reason, count in reasons.most_common():
        typer.echo(f"  {count} x {reason}", err=True)
    typer.echo("Run `podcast edit held` to list each one.", err=True)


@edit_app.command("held")
def edit_held_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str | None = typer.Option(None, "--ids", help="Comma-separated edit ids (default: all)"),
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    """List the pending proposals the audio checks would hold, and why. Changes nothing."""
    ws = ProjectWorkspace.open(project)
    id_list = [x.strip() for x in ids.split(",") if x.strip()] if ids else None
    held, asked = EditService(ws).held_by_checks(id_list)
    rows = [{"id": h.edit_id, "label": h.label, "reason": h.reason} for h in held]
    rows += [
        {"id": i, "label": "cuts other speech", "reason": group.confirmation.message}
        for group in asked
        for i in group.edit_ids
    ]
    if as_json:
        typer.echo(json.dumps(rows, indent=2))
        return
    if not rows:
        typer.echo("Nothing is held: approve --all would apply every pending proposal.")
        return
    for row in rows:
        typer.echo(f"{row['id']}: {row['label']} ({row['reason']})")
    typer.echo(
        f"{len(rows)} held. Apply them as they are with: "
        "edit approve --ids <id,...> --override-audio-checks"
    )


@edit_app.command("apply-suggested")
def edit_apply_suggested_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str | None = typer.Option(
        None, "--ids", help="Comma-separated edit ids (default: every pending tighten proposal)"
    ),
    override: list[str] = typer.Option(
        [], "--override", help="ID=ACTION (cut, shorten, lower or leave) for one sound; repeatable"
    ),
    revise: bool = typer.Option(
        False,
        "--revise",
        help="Change sounds of the latest batch: step back to before it and apply it again "
        "with --override on top, as one undo step (takes no --ids)",
    ),
    override_checks: bool = override_audio_checks_option(),
) -> None:
    """Apply every pending sound's suggested action in one undo step.

    All pending sounds, or several --ids, leave a cut over an unsure word pending; --ids <id>
    for one cut applies it.
    """
    overrides: dict[str, str] = {}
    for item in override:
        edit_id, _, action = item.partition("=")
        if not edit_id or not action:
            raise typer.BadParameter(f"--override wants ID=ACTION, got {item!r}")
        overrides[edit_id] = action
    ws = ProjectWorkspace.open(project)
    id_list = [x.strip() for x in ids.split(",") if x.strip()] if ids else None
    # Every pending sound or several ids is a bulk apply: cuts over an unsure word stay pending
    # (name one with --ids <id>). A revise re-applies the latest batch and keeps its own cuts.
    bulk = not revise and (id_list is None or len(set(id_list)) > 1)
    with cli_override(override_checks):
        result = apply_external_document_edit(
            ws,
            lambda: EditService(ws).apply_suggested_actions(
                id_list, overrides=overrides, revise=revise, skip_unsure=bulk
            ),
        )
    typer.echo(result["summary"])
    if result["held_unsure"]:
        pending = {e.id: e for e in ws.project.edit_decisions}
        _echo_held(
            [
                HeldEdit(i, cut_label(ws.project, pending[i]), UNSURE_WORD_REASON)
                for i in result["held_unsure"]
                if i in pending
            ],
            [],
        )
        typer.echo(
            "Edits over an unsure word stay pending. Check the words (`podcast transcript review`), "
            "then apply one by name: --ids <id>.",
            err=True,
        )


@edit_app.command("reject")
def edit_reject_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str = typer.Option(..., "--ids", help="Comma-separated edit ids"),
) -> None:
    ws = ProjectWorkspace.open(project)
    n = apply_external_document_edit(
        ws,
        lambda: EditService(ws).reject(
            [x.strip() for x in ids.split(",") if x.strip()], allow_exact=True
        ),
    )
    typer.echo(f"Removed {n} edit(s).")


@edit_app.command("list")
def edit_list_cmd(
    project: Path = typer.Option(..., "--project"),
    pending: bool = typer.Option(False, "--pending"),
) -> None:
    ws = ProjectWorkspace.open(project)
    rows = EditService(ws).list_decision_rows(review_required=True if pending else None)
    typer.echo(json.dumps(rows, indent=2))


@edit_app.command("impact")
def edit_impact_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    report = EditService(ws).impact_report(markdown=True)
    typer.echo(report)


@edit_app.command("transcript")
def edit_transcript_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(EditService(ws).transcript_timestamps())


@edit_app.command("preview-cut")
def edit_preview_cut_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    start: float = typer.Option(..., "--start"),
    end: float = typer.Option(..., "--end"),
    timeline: bool = typer.Option(False, "--timeline"),
) -> None:
    ws = ProjectWorkspace.open(project)
    out = AnalysisService(ws).preview_inaudible_cut(
        track_id=track,
        speaker=speaker,
        start=start,
        end=end,
        timeline=timeline,
    )
    typer.echo(json.dumps(out, indent=2))


@edit_app.command("suggest-handoff-cut")
def edit_suggest_handoff_cut_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    keep_left_end: float = typer.Option(
        ...,
        "--keep-left-end",
        help="Timeline end of material to keep on the left (e.g. punchline).",
    ),
    keep_right_start: float = typer.Option(
        ...,
        "--keep-right-start",
        help="Timeline start of material to keep on the right (e.g. closing pivot).",
    ),
    min_island_sec: float = typer.Option(0.12, "--min-island-sec"),
    hop_ms: int = typer.Option(20, "--hop-ms"),
    retain_sec: float = typer.Option(
        1.0,
        "--retain-sec",
        help="Target room-tone beat to keep after punchline / before pivot.",
    ),
) -> None:
    """Propose quiet handoff bounds across all dialogue lanes, including muted lanes.

    Use --track or --speaker to analyze only one lane.
    """
    ws = ProjectWorkspace.open(project)
    out = AnalysisService(ws).suggest_handoff_cut(
        track_id=track,
        speaker=speaker,
        keep_left_end=keep_left_end,
        keep_right_start=keep_right_start,
        min_island_sec=min_island_sec,
        hop_ms=hop_ms,
        retain_sec=retain_sec,
    )
    typer.echo(json.dumps(out, indent=2))


@edit_app.command("join-quality")
def edit_join_quality_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    join: float | None = typer.Option(None, "--join"),
    cut_start: float | None = typer.Option(None, "--cut-start"),
    cut_end: float | None = typer.Option(None, "--cut-end"),
    timebase: str = typer.Option("timeline", "--timebase"),
) -> None:
    ws = ProjectWorkspace.open(project)
    out = TimelineService(ws).join_quality(
        track_id=track,
        speaker=speaker,
        join_sec=join,
        cut_start=cut_start,
        cut_end=cut_end,
        timebase=timebase,
    )
    typer.echo(json.dumps(out, indent=2))


@edit_app.command("join-sweep")
def edit_join_sweep_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
) -> None:
    ws = ProjectWorkspace.open(project)
    out = TimelineService(ws).join_qa_sweep(track_id=track)
    typer.echo(json.dumps(out, indent=2))


@edit_app.command("join-label")
def edit_join_label_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    join: float = typer.Option(..., "--join"),
    verdict: str = typer.Option(..., "--verdict"),
    note: str = typer.Option("", "--note"),
    timebase: str = typer.Option("source", "--timebase"),
    play: bool = typer.Option(False, "--play/--no-play"),
) -> None:
    ws = ProjectWorkspace.open(project)
    out = TimelineService(ws).join_label(
        track_id=track,
        speaker=speaker,
        join_sec=join,
        verdict=verdict,
        timebase=timebase,
        note=note,
        play=play,
    )
    typer.echo(json.dumps(out, indent=2))


@edit_app.command("join-train")
def edit_join_train_cmd(
    project: Path = typer.Option(..., "--project"),
    labels: Path | None = typer.Option(None, "--labels"),
    out: Path | None = typer.Option(None, "--out"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = TimelineService(ws).join_train(labels_path=labels, out_path=out)
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("strip-silence")
def edit_strip_silence_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    over_voice_floor_db: float = typer.Option(
        0.0,
        "--over-voice-floor-db",
        help=(
            "Silence is audio under the track's own audibility floor (its voice floor) plus "
            "this (dB). A track whose voice does not stand out of its room has none to strip."
        ),
    ),
    min_duration: float = typer.Option(0.5, "--min-duration"),
    inaudible_opt: bool = typer.Option(
        True,
        "--inaudible-opt/--no-inaudible-opt",
        help="Ignored for strip-silence (API compatibility only).",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = apply_external_document_edit(
        ws,
        lambda: AnalysisService(ws).strip_silence(
            track_id=track,
            speaker=speaker,
            over_voice_floor_db=over_voice_floor_db,
            min_duration_sec=min_duration,
            use_inaudible_opt=inaudible_opt,
        ),
    )
    typer.echo(json.dumps(result, indent=2))


def _ripple_delete_summary(result: dict) -> str:
    """One-line verdict for a ripple-delete result (``--json`` has the rest).

    ``ripple-delete`` otherwise prints ~200 lines of per-detector JSON with no
    verdict up front, so an agent has to pull `verdict` / `risk` /
    `timeline_duration_sec` out by hand.
    """
    bits: list[str] = []
    duration = result.get("timeline_duration_sec")
    if duration is not None:
        bits.append(f"timeline now {duration:.2f}s")
    tracks = result.get("affected_tracks")
    if tracks:
        bits.append(f"{len(tracks)} track(s)")
    join_quality = result.get("join_quality")
    if isinstance(join_quality, dict) and join_quality.get("verdict") is not None:
        risk = join_quality.get("risk")
        verdict_bit = f"join {join_quality['verdict']}"
        if risk is not None:
            verdict_bit += f" (risk {risk})"
        bits.append(verdict_bit)
    if not bits:
        return "Ripple-deleted."
    return "Ripple-deleted: " + ", ".join(bits) + "."


@edit_app.command("ripple-delete")
def edit_ripple_delete_cmd(
    project: Path = typer.Option(..., "--project"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    query: str | None = typer.Option(None, "--query"),
    inaudible_opt: bool = typer.Option(True, "--inaudible-opt/--no-inaudible-opt"),
    track: list[str] = typer.Option(
        [], "--track", help="Track whose speech this cut removes (repeatable)"
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit the full per-detector result as JSON"),
    override_checks: bool = override_audio_checks_option(),
) -> None:
    """Ripple-delete a range on every dialogue track; the audio checks hold a harsh cut."""
    ws = ProjectWorkspace.open(project)

    def ripple_text() -> dict:
        with cli_override(override_checks):
            return EditService(ws).ripple_delete_text(
                query or "", use_inaudible_opt=inaudible_opt and not override_checks
            )

    def ripple_range() -> dict:
        with cli_override(override_checks):
            return EditService(ws).cut_range(
                start or 0.0,
                end or 0.0,
                mode=EditMode.RIPPLE,
                track_ids=list(track),
                use_inaudible_opt=inaudible_opt and not override_checks,
            )

    if query:
        result = apply_external_document_edit(ws, lambda: require_cut_applied(ripple_text))
    elif start is not None and end is not None:
        result = apply_external_document_edit(ws, lambda: require_cut_applied(ripple_range))
    else:
        raise typer.BadParameter("provide --start and --end, or --query")
    if as_json:
        typer.echo(json.dumps(result, indent=2))
        return
    typer.echo(_ripple_delete_summary(result))


@edit_app.command("move")
def edit_move_cmd(
    project: Path = typer.Option(..., "--project"),
    source_start: float | None = typer.Option(None, "--from-start"),
    source_end: float | None = typer.Option(None, "--from-end"),
    insert_at: float | None = typer.Option(None, "--to"),
    from_query: str | None = typer.Option(None, "--from-query"),
    to_query: str | None = typer.Option(None, "--to-after", "--to-query"),
) -> None:
    ws = ProjectWorkspace.open(project)
    if from_query and to_query:
        result = apply_external_document_edit(
            ws, lambda: TimelineService(ws).move_by_text(from_query, to_query, "after")
        )
    elif source_start is not None and source_end is not None and insert_at is not None:
        result = apply_external_document_edit(
            ws, lambda: TimelineService(ws).move_segment(source_start, source_end, insert_at)
        )
    else:
        raise typer.BadParameter("provide time range or --from-query and --to-after")
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("move-clips")
def edit_move_clips_cmd(
    project: Path = typer.Option(..., "--project"),
    clips_json: str = typer.Option(
        ...,
        "--clips-json",
        help="JSON array of {clip_id, timeline_start, track_id}",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    raw = json.loads(clips_json)
    if not isinstance(raw, list):
        raise typer.BadParameter("--clips-json must be a JSON array")
    typer.echo(
        json.dumps(
            apply_external_document_edit(ws, lambda: TimelineService(ws).move_clips(raw)), indent=2
        )
    )


@edit_app.command("delete-clips")
def edit_delete_clips_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str = typer.Option(..., "--ids", help="Comma-separated clip ids"),
    mode: EditMode = typer.Option(
        EditMode.GAP,
        "--mode",
        help="gap: each clip leaves silence; ripple: every dialogue track closes the span",
    ),
    override_checks: bool = override_audio_checks_option(),
) -> None:
    """Delete whole clips; the audio checks hold a harsh ripple unless overridden."""
    from podcast_mcp.services.document_sync import (
        host_command_result,
        submit_host_document_command,
    )

    clip_ids = [x.strip() for x in ids.split(",") if x.strip()]

    def delete() -> dict:
        payload: dict = {
            "clip_ids": clip_ids,
            "mode": mode.value,
            "override_audio_checks": override_checks,
        }
        return host_command_result(
            submit_host_document_command(
                project, "DeleteClip", payload, client_id=cli_actor(), role="cli"
            )
        )

    typer.echo(json.dumps(require_cut_applied(delete), indent=2))


@edit_app.command("propose-range-cut")
def edit_propose_range_cut_cmd(
    project: Path = typer.Option(..., "--project"),
    start: float = typer.Option(..., "--start", help="Timeline seconds"),
    end: float = typer.Option(..., "--end", help="Timeline seconds"),
    tracks: str | None = typer.Option(
        None, "--tracks", help="Comma-separated lanes (default every dialogue lane)"
    ),
    command_id: str | None = typer.Option(
        None, "--command-id", help="Reuse only to retry the same range"
    ),
) -> None:
    """Propose an exact range cut (leaves a hole); approve it with `edit approve`."""
    from uuid import uuid4

    from podcast_mcp.services.document_sync import (
        host_command_result,
        submit_host_document_command,
    )
    from podcast_mcp.util.tracks import dialogue_track_ids

    ws = ProjectWorkspace.open(project)
    track_ids = (
        [t.strip() for t in tracks.split(",") if t.strip()]
        if tracks
        else dialogue_track_ids(ws.project)
    )
    target = EditService(ws).selected_range_target(start, end, track_ids)
    reply = submit_host_document_command(
        project,
        "EditSelectedRange",
        {"target": target.model_dump(mode="json"), "action": "cut"},
        client_id="cli",
        command_id=command_id or f"cli-range-cut-{uuid4().hex}",
    )
    typer.echo(json.dumps(host_command_result(reply), indent=2))


@edit_app.command("copy-segment")
def edit_copy_segment_cmd(
    project: Path = typer.Option(..., "--project"),
    start: float = typer.Option(..., "--start", help="Timeline seconds"),
    end: float = typer.Option(..., "--end", help="Timeline seconds"),
    tracks: str | None = typer.Option(
        None, "--tracks", help="Comma-separated tracks (default every track with clips)"
    ),
) -> None:
    """Print the clipboard Studio Copy holds for a range; feed it to `edit paste-segment`."""
    track_ids = [t.strip() for t in tracks.split(",") if t.strip()] if tracks else None
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(TimelineService(ws).copy_segment(start, end, track_ids), indent=2))


@edit_app.command("paste-segment")
def edit_paste_segment_cmd(
    project: Path = typer.Option(..., "--project"),
    at: float = typer.Option(..., "--at", help="Timeline seconds to paste at"),
    clipboard: typer.FileText = typer.Option(
        ..., "--clipboard", help="JSON from `edit copy-segment` (- for stdin)"
    ),
    mode: EditMode = typer.Option(
        EditMode.RIPPLE,
        "--mode",
        help="ripple: open the time on every dialogue track; gap: paste over in place",
    ),
) -> None:
    """Paste a copied range at --at, as Studio Paste does; undoable."""
    from podcast_mcp.services.document_sync import submit_paste_segment

    raw = json.load(clipboard)
    if not isinstance(raw, dict):
        raise typer.BadParameter("--clipboard must hold the object `edit copy-segment` prints")
    typer.echo(
        json.dumps(submit_paste_segment(project, at, raw, mode=mode, client_id="cli"), indent=2)
    )


@edit_app.command("insert-gap")
def edit_insert_gap_cmd(
    project: Path = typer.Option(..., "--project"),
    at: float = typer.Option(..., "--at"),
    duration: float = typer.Option(1.0, "--duration"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            apply_external_document_edit(ws, lambda: TimelineService(ws).insert_gap(at, duration)),
            indent=2,
        )
    )


@edit_app.command("fade-joins")
def edit_fade_joins_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    fade_ms: int | None = typer.Option(None, "--fade-ms"),
    dry_run: bool = typer.Option(False, "--dry-run"),
) -> None:
    ws = ProjectWorkspace.open(project)

    def fade() -> dict:
        return TimelineService(ws).fade_joins(
            track_id=track, speaker=speaker, fade_ms=fade_ms, dry_run=dry_run
        )

    result = fade() if dry_run else apply_external_document_edit(ws, fade)
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("crossfade-joins")
def edit_crossfade_joins_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    fade_ms: int | None = typer.Option(None, "--fade-ms"),
    dry_run: bool = typer.Option(False, "--dry-run"),
) -> None:
    ws = ProjectWorkspace.open(project)

    def crossfade() -> dict:
        return TimelineService(ws).crossfade_joins(
            track_id=track, speaker=speaker, fade_ms=fade_ms, dry_run=dry_run
        )

    result = crossfade() if dry_run else apply_external_document_edit(ws, crossfade)
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("set-clip-join")
def edit_set_clip_join_cmd(
    project: Path = typer.Option(..., "--project"),
    left: str = typer.Option(..., "--left", help="Left clip id"),
    right: str = typer.Option(..., "--right", help="Right (next) clip id"),
    mode: str = typer.Option(..., "--mode", help="fade | crossfade | cut"),
    length_ms: int | None = typer.Option(None, "--length-ms"),
) -> None:
    """Set one join's mode and fades (crossfade needs fades to blend)."""
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            apply_external_document_edit(
                ws, lambda: TimelineService(ws).set_clip_join(left, right, mode, length_ms)
            ),
            indent=2,
        )
    )


@edit_app.command("trim-clip")
def edit_trim_clip_cmd(
    project: Path = typer.Option(..., "--project"),
    clip: str = typer.Option(..., "--clip", help="Clip id"),
    edge: str = typer.Option(..., "--edge", help="in | out"),
    source_sec: float = typer.Option(
        ..., "--source-sec", help="New edge position in source-media seconds"
    ),
    mode: EditMode = typer.Option(
        EditMode.RIPPLE,
        "--mode",
        help="ripple: every dialogue track moves with the edge; gap: only this edge moves",
    ),
    override_checks: bool = override_audio_checks_option(),
) -> None:
    """Move one clip edge; `play context` suggests the value."""
    if edge not in ("in", "out"):
        raise typer.BadParameter("--edge must be in or out")
    trim_edge = cast(Literal["in", "out"], edge)
    ws = ProjectWorkspace.open(project)

    def trim() -> dict:
        with cli_override(override_checks), ws.transaction():
            service = EditService(ws)
            revision = service.boundary_context(
                TrimBoundaryTarget(clip_id=clip, edge=trim_edge, mode=mode)
            ).token
            return TimelineService(service.ws).trim_clip_edge(
                clip,
                trim_edge,
                source_sec,
                mode=mode,
                expected_token=revision,
            )

    typer.echo(
        json.dumps(apply_external_document_edit(ws, lambda: require_cut_applied(trim)), indent=2)
    )


@edit_app.command("roll-join")
def edit_roll_join_cmd(
    project: Path = typer.Option(..., "--project"),
    left: str = typer.Option(..., "--left", help="Left clip id"),
    right: str = typer.Option(..., "--right", help="Right clip id"),
    delta_sec: float = typer.Option(
        ..., "--delta-sec", help="Source seconds to move the join (positive is later)"
    ),
) -> None:
    """Roll a join: both edges move together, the pair keeps its length.

    The clips must touch; with a gap between them it exits 1 with code roll_needs_abutting_clips.
    """
    from podcast_mcp.services.document import RollBoundaryTarget
    from podcast_mcp.services.document_sync import (
        host_command_result,
        submit_host_document_command,
    )

    ws = ProjectWorkspace.open(project)
    target = RollBoundaryTarget(left_clip_id=left, right_clip_id=right)
    reply = submit_host_document_command(
        project,
        "RollClipJoin",
        {
            "left_clip_id": left,
            "right_clip_id": right,
            "delta_sec": delta_sec,
            "expected_token": EditService(ws).boundary_context(target).token,
        },
        client_id="cli",
    )
    typer.echo(json.dumps(host_command_result(reply), indent=2))


@edit_app.command("add-chapter")
def edit_add_chapter_cmd(
    project: Path = typer.Option(..., "--project"),
    at_time: float = typer.Option(..., "--at-time"),
    title: str = typer.Option(..., "--title"),
) -> None:
    from podcast_mcp.services.document_sync import submit_host_command_result

    result = submit_host_command_result(
        project, "AddChapter", {"time": at_time, "title": title}, client_id="cli"
    )
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("remove-chapter")
def edit_remove_chapter_cmd(
    project: Path = typer.Option(..., "--project"),
    title: str = typer.Option(..., "--title"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            apply_external_document_edit(ws, lambda: TimelineService(ws).remove_chapter(title)),
            indent=2,
        )
    )


@edit_app.command("list-chapters")
def edit_list_chapters_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(TimelineService(ws).list_chapters(), indent=2))


@edit_app.command("list-clips")
def edit_list_clips_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(TimelineService(ws).list_clips(track), indent=2))


@edit_app.command("list-applied")
def edit_list_applied_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).list_applied_edits(
                track_id=track,
                timeline_start=start,
                timeline_end=end,
            ),
            indent=2,
        )
    )


@edit_app.command("render-status")
def edit_render_status_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(EditService(ws).render_status(), indent=2))


@edit_app.command("shorten-gaps")
def edit_shorten_gaps_cmd(
    project: Path = typer.Option(..., "--project"),
    max_gap: float = typer.Option(0.35, "--max-gap"),
    inaudible_opt: bool = typer.Option(True, "--inaudible-opt/--no-inaudible-opt"),
    override_checks: bool = override_audio_checks_option(),
) -> None:
    ws = ProjectWorkspace.open(project)

    def shorten() -> dict:
        with cli_override(override_checks):
            return TimelineService(ws).shorten_word_gaps(max_gap, use_inaudible_opt=inaudible_opt)

    result = apply_external_document_edit(ws, lambda: require_cut_applied(shorten))
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("analyze-cleanup")
def edit_analyze_cleanup_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).analyze_cleanup(
                track_id=track, speaker=speaker, progress=get_progress()
            ),
            indent=2,
        )
    )


@edit_app.command("audio-diagnostics")
def edit_audio_diagnostics_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).audio_diagnostics(
                track_id=track, speaker=speaker, start_sec=start, end_sec=end
            ),
            indent=2,
        )
    )


@edit_app.command("recommend-fades")
def edit_recommend_fades_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).recommend_fades(track_id=track, speaker=speaker),
            indent=2,
        )
    )


@edit_app.command("low-audibility")
def edit_low_audibility_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).low_audibility_words(
                track_id=track, speaker=speaker, progress=get_progress()
            ),
            indent=2,
        )
    )


@edit_app.command("suppress-low-audibility")
def edit_suppress_low_audibility_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    from podcast_mcp.services.document_sync import host_command_result, submit_host_document_command

    reply = submit_host_document_command(
        project,
        "SuppressLowAudibility",
        {"track_id": track, "speaker": speaker},
        client_id="cli:host",
    )
    typer.echo(json.dumps(host_command_result(reply), indent=2))


@edit_app.command("gate-overreach")
def edit_gate_overreach_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).gate_overreach(
                track_id=track, speaker=speaker, progress=get_progress()
            ),
            indent=2,
        )
    )


@edit_app.command("audibility-map")
def edit_audibility_map_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).audibility_map(
                track_id=track, speaker=speaker, progress=get_progress()
            ),
            indent=2,
        )
    )


@edit_app.command("flagged-words")
def edit_flagged_words_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).flagged_words(
                track_id=track, speaker=speaker, progress=get_progress()
            ),
            indent=2,
        )
    )


@edit_app.command("reconciliation-status")
def edit_reconciliation_status_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(AnalysisService(ws).reconciliation_status(), indent=2))


@edit_app.command("reconcile-transcript")
def edit_reconcile_transcript_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Preview suppressions without applying (default applies per transcript_mode)",
    ),
    apply: bool = typer.Option(
        False,
        "--apply",
        help="Force apply even when transcript_mode is flag or suggest",
    ),
    start: float | None = typer.Option(None, "--start", help="Limit to words at/after (sec)"),
    end: float | None = typer.Option(None, "--end", help="Limit to words before (sec)"),
) -> None:
    ws = ProjectWorkspace.open(project)
    if dry_run:
        dry_run_param: bool | None = True
    elif apply:
        dry_run_param = False
    else:
        dry_run_param = None

    def reconcile() -> dict:
        return AnalysisService(ws).reconcile_transcript(
            track_id=track,
            speaker=speaker,
            dry_run=dry_run_param,
            start_sec=start,
            end_sec=end,
            progress=get_progress(),
        )

    result = reconcile() if dry_run else apply_external_document_edit(ws, reconcile)
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("bleed-words")
def edit_bleed_words_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).list_bleed_words(
                track_id=track,
                speaker=speaker,
                start_sec=start,
                end_sec=end,
                progress=get_progress(),
            ),
            indent=2,
        )
    )


@edit_app.command("suppress-bleed")
def edit_suppress_bleed_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Preview candidates without applying (default applies suppressions)",
    ),
    words_json: str | None = typer.Option(
        None,
        "--words-json",
        help="JSON array of {track_id, source_id?, word_index}; source_id is required on a multi-take lane",
    ),
    exclude_words_json: str | None = typer.Option(
        None, "--exclude-words-json", help="JSON array of word keys to skip"
    ),
) -> None:
    words = json.loads(words_json) if words_json else None
    exclude = json.loads(exclude_words_json) if exclude_words_json else None
    if words is not None and not isinstance(words, list):
        raise typer.BadParameter("--words-json must be a JSON array")
    if exclude is not None and not isinstance(exclude, list):
        raise typer.BadParameter("--exclude-words-json must be a JSON array")
    from podcast_mcp.services.document_sync import (
        host_command_result,
        submit_host_document_command,
        validate_payload,
    )

    payload = {
        "track_id": track,
        "speaker": speaker,
        "words": words,
        "exclude_words": exclude,
        "start_sec": start,
        "end_sec": end,
    }
    if dry_run:
        checked = validate_payload("SuppressBleed", payload)
        ws = ProjectWorkspace.open(project)
        result = AnalysisService(ws).suppress_bleed(
            track_id=track,
            speaker=speaker,
            word_keys=checked["words"],
            exclude_word_keys=checked["exclude_words"],
            start_sec=start,
            end_sec=end,
            apply=False,
            progress=get_progress(),
        )
    else:
        result = host_command_result(
            submit_host_document_command(project, "SuppressBleed", payload, client_id="cli:host")
        )
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("apply-bleed-mute")
def edit_apply_bleed_mute_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    align_retained_bleed: bool = typer.Option(
        True, "--align-retained-bleed/--no-align-retained-bleed"
    ),
    override_placement_lock: bool = typer.Option(False, "--override-placement-lock"),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Preview gate spans without rewriting stems",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    params: dict[str, Any] = {
        "track_id": track,
        "speaker": speaker,
        "start_sec": start,
        "end_sec": end,
        "align_retained_bleed": align_retained_bleed,
        "override_placement_lock": override_placement_lock,
    }
    if dry_run:
        result = AnalysisService(ws).preview_bleed_mute(**params, progress=get_progress())
    else:
        result = run_audio_edit(
            ws,
            "apply_bleed_mute",
            params,
            lock_timeout=RENDER_LOCK_TIMEOUT_SEC,
            progress=get_progress(),
        )
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("mute-off-speaker")
def edit_mute_off_speaker_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="List the stretches without muting them",
    ),
) -> None:
    """Mute a track wherever another speaker talks and its own speaker does not."""
    ws = ProjectWorkspace.open(project)
    params: dict[str, Any] = {"track_id": track, "speaker": speaker}
    if dry_run:
        result = AnalysisService(ws).preview_off_speaker_mute(**params, progress=get_progress())
    else:
        result = run_audio_edit(
            ws,
            "mute_off_speaker",
            params,
            lock_timeout=RENDER_LOCK_TIMEOUT_SEC,
            progress=get_progress(),
        )
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("overlap-duplicates")
def edit_overlap_duplicates_cmd(
    project: Path = typer.Option(..., "--project"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            AnalysisService(ws).overlap_duplicates(
                start_sec=start,
                end_sec=end,
                progress=get_progress(),
            ),
            indent=2,
        )
    )


@edit_app.command("align-retained-bleed")
def edit_align_retained_bleed_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    override_placement_lock: bool = typer.Option(False, "--override-placement-lock"),
) -> None:
    """Align supported complete phrases only where uncertain bleed remains."""
    ws = ProjectWorkspace.open(project)
    params: dict[str, Any] = {
        "track_id": track,
        "start_sec": start,
        "end_sec": end,
        "override_placement_lock": override_placement_lock,
    }
    if dry_run:
        result = AnalysisService(ws).preview_retained_bleed_alignment(**params)
    else:
        result = run_audio_edit(
            ws, "align_retained_bleed", params, lock_timeout=RENDER_LOCK_TIMEOUT_SEC
        )
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("bleed-alignment-choice")
def edit_bleed_alignment_choice_cmd(
    project: Path = typer.Option(..., "--project"),
    decision: str = typer.Option(..., "--decision"),
    mode: str = typer.Option(..., "--mode", help="auto, manual, or declined"),
    track: str | None = typer.Option(None, "--track"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    override_placement_lock: bool = typer.Option(False, "--override-placement-lock"),
) -> None:
    """Save or reset a source-scoped timing choice, including a preview proposal."""
    if mode not in ("auto", "manual", "declined"):
        raise typer.BadParameter("mode must be auto, manual, or declined", param_hint="--mode")
    from podcast_mcp.services.document_sync import host_command_result, submit_host_document_command

    reply = submit_host_document_command(
        project,
        "SetBleedAlignmentMode",
        {
            "decision_id": decision,
            "mode": mode,
            "track_id": track,
            "start_sec": start,
            "end_sec": end,
            "override_placement_lock": override_placement_lock,
        },
        client_id="cli:host",
    )
    typer.echo(json.dumps(host_command_result(reply), indent=2))
