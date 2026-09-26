from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.timed import timed_command
from podcast_mcp.edits.tighten_intensity import normalize_tighten_intensity
from podcast_mcp.services import EditService, ProjectWorkspace

edit_app = typer.Typer(help="Transcript-driven cuts for natural language editing.")


@timed_command("propose-edits")
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
) -> None:
    if intensity is not None:
        try:
            intensity = normalize_tighten_intensity(intensity)
        except ValueError as exc:
            raise typer.BadParameter(str(exc), param_hint="--intensity") from exc
    ws = ProjectWorkspace.open(project)
    proposal = EditService(ws).propose_tighten(edit_mode=edit_mode, intensity=intensity)
    typer.echo(proposal.summary())


@timed_command("apply-edits")
def apply_edits_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    n = EditService(ws).apply_auto()
    typer.echo(f"Applied {n} auto edit decisions.")


@timed_command("edit-context")
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
    reason: str = typer.Option("nl:range", "--reason"),
    review: bool = typer.Option(True, "--review/--no-review"),
    inaudible_opt: bool = typer.Option(True, "--inaudible-opt/--no-inaudible-opt"),
) -> None:
    ws = ProjectWorkspace.open(project)
    EditService(ws).cut_time_range(
        track,
        start,
        end,
        reason=reason,
        review_required=review,
        use_inaudible_opt=inaudible_opt,
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
    cuts = EditService(ws).cut_text_match(
        query,
        track_id=track,
        match_all=all_matches,
        review_required=True,
        use_inaudible_opt=inaudible_opt,
    )
    typer.echo(f"Created {len(cuts)} cut(s)")


@edit_app.command("cut-utterance")
def edit_cut_utterance_cmd(
    project: Path = typer.Option(..., "--project"),
    index: int = typer.Option(..., "--index"),
    inaudible_opt: bool = typer.Option(True, "--inaudible-opt/--no-inaudible-opt"),
) -> None:
    ws = ProjectWorkspace.open(project)
    EditService(ws).cut_utterance(index, use_inaudible_opt=inaudible_opt)
    typer.echo(f"Cut utterance {index}")


@edit_app.command("approve")
def edit_approve_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str = typer.Option(..., "--ids", help="Comma-separated edit ids"),
) -> None:
    ws = ProjectWorkspace.open(project)
    n = EditService(ws).approve([x.strip() for x in ids.split(",") if x.strip()])
    typer.echo(f"Approved {n} edit(s).")
    if n == 0:
        typer.echo("Warning: no edits were approved — check the edit ids.", err=True)


@edit_app.command("reject")
def edit_reject_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str = typer.Option(..., "--ids", help="Comma-separated edit ids"),
) -> None:
    ws = ProjectWorkspace.open(project)
    n = EditService(ws).reject([x.strip() for x in ids.split(",") if x.strip()])
    typer.echo(f"Removed {n} edit(s).")


@edit_app.command("list")
def edit_list_cmd(
    project: Path = typer.Option(..., "--project"),
    pending: bool = typer.Option(False, "--pending"),
) -> None:
    ws = ProjectWorkspace.open(project)
    edits = EditService(ws).list_decisions(review_required=True if pending else None)
    typer.echo(json.dumps([e.model_dump() for e in edits], indent=2))


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
    out = EditService(ws).preview_inaudible_cut(
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
    quiet_db: float = typer.Option(-48.0, "--quiet-db"),
    min_island_sec: float = typer.Option(0.12, "--min-island-sec"),
    hop_ms: int = typer.Option(20, "--hop-ms"),
    retain_sec: float = typer.Option(
        1.0,
        "--retain-sec",
        help="Target room-tone beat to keep after punchline / before pivot.",
    ),
) -> None:
    """Propose silence→silence ripple bounds for a narrative handoff."""
    ws = ProjectWorkspace.open(project)
    out = EditService(ws).suggest_handoff_cut(
        track_id=track,
        speaker=speaker,
        keep_left_end=keep_left_end,
        keep_right_start=keep_right_start,
        quiet_db=quiet_db,
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
    out = EditService(ws).join_quality(
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
    out = EditService(ws).join_qa_sweep(track_id=track)
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
    out = EditService(ws).join_label(
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
    result = EditService(ws).join_train(labels_path=labels, out_path=out)
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("strip-silence")
def edit_strip_silence_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    threshold_db: float = typer.Option(-40.0, "--threshold-db"),
    min_duration: float = typer.Option(0.5, "--min-duration"),
    inaudible_opt: bool = typer.Option(
        True,
        "--inaudible-opt/--no-inaudible-opt",
        help="Ignored for strip-silence (API compatibility only).",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = EditService(ws).strip_silence(
        track_id=track,
        speaker=speaker,
        threshold_db=threshold_db,
        min_duration_sec=min_duration,
        use_inaudible_opt=inaudible_opt,
    )
    typer.echo(json.dumps(result, indent=2))


@edit_app.command("ripple-delete")
def edit_ripple_delete_cmd(
    project: Path = typer.Option(..., "--project"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    query: str | None = typer.Option(None, "--query"),
    inaudible_opt: bool = typer.Option(True, "--inaudible-opt/--no-inaudible-opt"),
) -> None:
    ws = ProjectWorkspace.open(project)
    if query:
        result = EditService(ws).ripple_delete_text(
            query,
            use_inaudible_opt=inaudible_opt,
        )
    elif start is not None and end is not None:
        result = EditService(ws).ripple_delete(
            start,
            end,
            use_inaudible_opt=inaudible_opt,
        )
    else:
        raise typer.BadParameter("provide --start and --end, or --query")
    typer.echo(json.dumps(result, indent=2))


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
        result = EditService(ws).move_by_text(from_query, to_query, "after")
    elif source_start is not None and source_end is not None and insert_at is not None:
        result = EditService(ws).move_segment(source_start, source_end, insert_at)
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
    typer.echo(json.dumps(EditService(ws).move_clips(raw), indent=2))


@edit_app.command("insert-gap")
def edit_insert_gap_cmd(
    project: Path = typer.Option(..., "--project"),
    at: float = typer.Option(..., "--at"),
    duration: float = typer.Option(1.0, "--duration"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(EditService(ws).insert_gap(at, duration), indent=2))


@edit_app.command("fade-joins")
def edit_fade_joins_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    fade_ms: int | None = typer.Option(None, "--fade-ms"),
    dry_run: bool = typer.Option(False, "--dry-run"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).fade_joins(
                track_id=track,
                speaker=speaker,
                fade_ms=fade_ms,
                dry_run=dry_run,
            ),
            indent=2,
        )
    )


@edit_app.command("crossfade-joins")
def edit_crossfade_joins_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    fade_ms: int | None = typer.Option(None, "--fade-ms"),
    dry_run: bool = typer.Option(False, "--dry-run"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).crossfade_joins(
                track_id=track,
                speaker=speaker,
                fade_ms=fade_ms,
                dry_run=dry_run,
            ),
            indent=2,
        )
    )


@edit_app.command("add-chapter")
def edit_add_chapter_cmd(
    project: Path = typer.Option(..., "--project"),
    at_time: float = typer.Option(..., "--at-time"),
    title: str = typer.Option(..., "--title"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(EditService(ws).add_chapter(at_time, title), indent=2))


@edit_app.command("remove-chapter")
def edit_remove_chapter_cmd(
    project: Path = typer.Option(..., "--project"),
    title: str = typer.Option(..., "--title"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(EditService(ws).remove_chapter(title), indent=2))


@edit_app.command("list-chapters")
def edit_list_chapters_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(EditService(ws).list_chapters(), indent=2))


@edit_app.command("list-clips")
def edit_list_clips_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(EditService(ws).list_clips(track), indent=2))


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
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).shorten_word_gaps(
                max_gap,
                use_inaudible_opt=inaudible_opt,
            ),
            indent=2,
        )
    )


@edit_app.command("analyze-cleanup")
def edit_analyze_cleanup_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).analyze_cleanup(
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
            EditService(ws).audio_diagnostics(
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
            EditService(ws).recommend_fades(track_id=track, speaker=speaker),
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
            EditService(ws).low_audibility_words(
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
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).suppress_low_audibility(track_id=track, speaker=speaker),
            indent=2,
        )
    )


@edit_app.command("gate-overreach")
def edit_gate_overreach_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).gate_overreach(
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
            EditService(ws).audibility_map(
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
            EditService(ws).flagged_words(track_id=track, speaker=speaker, progress=get_progress()),
            indent=2,
        )
    )


@edit_app.command("reconciliation-status")
def edit_reconciliation_status_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(EditService(ws).reconciliation_status(), indent=2))


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
    typer.echo(
        json.dumps(
            EditService(ws).reconcile_transcript(
                track_id=track,
                speaker=speaker,
                dry_run=dry_run_param,
                start_sec=start,
                end_sec=end,
                progress=get_progress(),
            ),
            indent=2,
        )
    )


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
            EditService(ws).list_bleed_words(
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
        None, "--words-json", help="JSON array of {track_id, word_index}"
    ),
    exclude_words_json: str | None = typer.Option(
        None, "--exclude-words-json", help="JSON array of word keys to skip"
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    words = json.loads(words_json) if words_json else None
    exclude = json.loads(exclude_words_json) if exclude_words_json else None
    if words is not None and not isinstance(words, list):
        raise typer.BadParameter("--words-json must be a JSON array")
    if exclude is not None and not isinstance(exclude, list):
        raise typer.BadParameter("--exclude-words-json must be a JSON array")
    typer.echo(
        json.dumps(
            EditService(ws).suppress_bleed(
                track_id=track,
                speaker=speaker,
                words_json=words,
                exclude_words_json=exclude,
                start_sec=start,
                end_sec=end,
                apply=not dry_run,
                progress=get_progress(),
            ),
            indent=2,
        )
    )


@edit_app.command("apply-bleed-mute")
def edit_apply_bleed_mute_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Preview gate spans without rewriting stems",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).apply_bleed_mute(
                track_id=track,
                speaker=speaker,
                start_sec=start,
                end_sec=end,
                apply=not dry_run,
                progress=get_progress(),
            ),
            indent=2,
        )
    )


@edit_app.command("overlap-duplicates")
def edit_overlap_duplicates_cmd(
    project: Path = typer.Option(..., "--project"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(
        json.dumps(
            EditService(ws).overlap_duplicates(
                start_sec=start,
                end_sec=end,
                progress=get_progress(),
            ),
            indent=2,
        )
    )
