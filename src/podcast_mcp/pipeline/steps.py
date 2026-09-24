from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from podcast_mcp.edits import apply_tighten_decisions, propose_tighten_edits
from podcast_mcp.engines import TranscriptionEngine, ensure_track_peaks
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    EpisodeProject,
    ProcessingEffect,
    Track,
    TrackRole,
)
from podcast_mcp.pipeline.helpers import (
    artifact,
    ensure_dialogue_clips,
    ffmpeg,
    set_or_replace_chain,
)
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.progress import resolve_progress_task
from podcast_mcp.whisper_models import DEFAULT_WHISPER_MODEL

log = logging.getLogger(__name__)

StepSummary = str | None


def align_tracks(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.align_accept_status import mark_align_done, mark_align_pending
    from podcast_mcp.edits.conversation_align import (
        restore_clip_geometry,
        run_conversation_align,
        snapshot_clip_geometry,
    )

    snap = snapshot_clip_geometry(project)
    try:
        result = run_conversation_align(project, defaults=defaults)
        if result.skipped_reason:
            mark_align_done(
                project,
                source="align",
                notes=f"skipped: {result.skipped_reason}",
            )
            return result.skipped_reason
        mark_align_pending(project, notes="after align_tracks")
    except Exception:
        restore_clip_geometry(project, snap)
        raise
    return result.summary()


def require_align_accept(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.align_accept_status import require_or_waive_unattended

    return require_or_waive_unattended(project, defaults=defaults)


def ingest_tracks(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    project.ensure_dirs()
    eng = ffmpeg()
    probed = 0
    peaks = 0
    for track in project.tracks:
        if not track.media:
            continue
        path = Path(track.media.path)
        if not path.is_absolute():
            path = project.workspace_path() / path
        if not path.is_file():
            raise FileNotFoundError(path)
        probe = eng.probe(path)
        track.media.duration_sec = probe.duration_sec
        track.media.sample_rate = probe.sample_rate
        track.media.channels = probe.channels
        probed += 1
        if ensure_track_peaks(project, track) is not None:
            peaks += 1
    ensure_dialogue_clips(project)
    dialogue = sum(1 for t in project.tracks if t.role == TrackRole.DIALOGUE)
    return f"{probed} tracks probed, {peaks} peaks, {dialogue} dialogue"


def transcribe_tracks(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.engines.audio_audit import AnalysisPolicy
    from podcast_mcp.engines.transcribe import collect_anomalous_asr_duration_flags
    from podcast_mcp.transcript_context import load_transcript_context

    cfg = defaults.get("transcribe", {})
    pol = AnalysisPolicy.from_defaults(defaults)
    engine = TranscriptionEngine(
        model_size=cfg.get("model", DEFAULT_WHISPER_MODEL),
        device="cpu",
    )
    ctx = load_transcript_context(project.workspace_path())
    prompt = ctx.initial_prompt_text()
    transcripts = engine.transcribe_all_dialogue(
        project,
        language=cfg.get("language", "en"),
        initial_prompt=prompt,
        max_word_sec=pol.max_word_audibility_sec,
    )

    def _key(t: object) -> tuple[str, str | None]:
        return (getattr(t, "track_id", ""), getattr(t, "source_id", None))

    by_id = {_key(t): t for t in project.transcripts}
    for t in transcripts:
        by_id[_key(t)] = t
    project.transcripts = list(by_id.values())
    words = sum(len(t.words) for t in transcripts)
    timing_flags = collect_anomalous_asr_duration_flags(
        project,
        max_word_sec=pol.max_word_audibility_sec,
    )
    timing_path = artifact(project, "transcript_timing.json")
    timing_path.write_text(
        json.dumps(
            {
                "max_word_sec": pol.max_word_audibility_sec,
                "flag_count": len(timing_flags),
                "flags": timing_flags,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    summary = f"{len(transcripts)} tracks, {words} words"
    if timing_flags:
        summary += f", {len(timing_flags)} timing flags"
    # A vocabulary edit made during transcription still needs another pass.
    current_ctx = load_transcript_context(project.workspace_path())
    if (
        current_ctx.terms == ctx.terms
        and current_ctx.guest_names == ctx.guest_names
        and current_ctx.transcribe.pop("vocabulary_stale", None)
    ):
        current_ctx.save(project.workspace_path())
    return summary


def precorrect_transcript(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.transcript_precorrect import run_precorrect_transcript
    from podcast_mcp.engines.audio_audit import AnalysisPolicy

    pol = AnalysisPolicy.from_defaults(defaults)
    result = run_precorrect_transcript(project, dry_run=False, policy=pol)
    parts = [
        f"{result.glossary_applied} glossary",
        f"{result.cross_track_applied} cross-track",
    ]
    if result.speaker_ran:
        speaker = result.report.get("speaker_attribution") or {}
        changed = speaker.get("attributions_changed")
        if changed is not None:
            parts.append(f"{changed} speaker attrs")
        else:
            parts.append("speaker ran")
    elif result.speaker_skipped_reason:
        parts.append(f"speaker skipped ({result.speaker_skipped_reason})")
    deferred = len(result.report.get("deferred_queue") or [])
    if deferred:
        parts.append(f"{deferred} deferred")
    return ", ".join(parts)


def require_transcript_refine(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.transcript_refine_status import require_or_waive_unattended

    return require_or_waive_unattended(project, defaults=defaults)


def reconcile_transcript(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.transcript_reconcile import run_reconciliation
    from podcast_mcp.engines.audio_audit import AnalysisPolicy

    pol = AnalysisPolicy.from_defaults(defaults)
    if pol.transcript_mode == "off":
        return "skipped (transcript_mode=off)"
    result = run_reconciliation(project, policy=pol, dry_run=None)
    return (
        f"{result.get('suppress_count', 0)} suppressed, "
        f"{result.get('unsuppress_count', 0)} unsuppressed, "
        f"{result.get('reattribute_count', 0)} reattributed, "
        f"{result.get('status_updates', 0)} status updates"
    )


def merge_transcript(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    engine = TranscriptionEngine()
    project.combined_transcript = engine.merge_transcripts(project)
    out = project.transcripts_dir() / "combined.json"
    out.write_text(
        project.combined_transcript.model_dump_json(indent=2),
        encoding="utf-8",
    )
    utts = project.combined_transcript.utterances or []
    return f"{len(utts)} utterances"


def analyze_focus_cuts(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.focus import propose_focus_cuts, write_focus_outline
    from podcast_mcp.edits.transcript_refine_status import assert_refine_clear

    assert_refine_clear(project, defaults=defaults)
    focus_cfg = defaults.get("focus", {})
    if not focus_cfg.get("enabled", False):
        return "skipped (focus.enabled=false)"
    with resolve_progress_task(
        "analyze_focus_cuts",
        "Analyzing focus cuts",
        prefer_parent=True,
    ) as prog:
        prog.set_phase("outline", "Writing focus outline…")
        write_focus_outline(project, defaults)
        prog.set_phase("propose", "Proposing focus cuts…")
        decisions = propose_focus_cuts(project, defaults, replace_existing=True)
    return f"{len(decisions)} focus cuts proposed"


def focus_from_transcript(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.focus import apply_focus_decisions
    from podcast_mcp.edits.transcript_refine_status import assert_refine_clear

    assert_refine_clear(project, defaults=defaults)
    if not defaults.get("focus", {}).get("auto_apply", False):
        return "skipped (focus.auto_apply=false)"
    with resolve_progress_task(
        "focus_from_transcript",
        "Applying focus cuts",
        prefer_parent=True,
    ) as prog:
        prog.set_phase("apply", "Applying focus cuts…")
        applied = apply_focus_decisions(project)
    return f"{applied} focus cuts applied"


def analyze_fillers_pauses(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.transcript_refine_status import assert_refine_clear

    assert_refine_clear(project, defaults=defaults)
    if not defaults.get("tighten", {}).get("enabled", True):
        return "skipped (tighten.enabled=false)"
    with resolve_progress_task(
        "analyze_fillers_pauses",
        "Analyzing fillers and pauses",
        prefer_parent=True,
    ) as prog:
        prog.set_phase("propose", "Proposing tighten edits…")
        proposed = propose_tighten_edits(project, defaults, replace_existing=True)
    return proposed.summary()


def tighten_from_transcript(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.transcript_refine_status import assert_refine_clear

    assert_refine_clear(project, defaults=defaults)
    if not defaults.get("tighten", {}).get("enabled", True):
        return "skipped (tighten.enabled=false)"
    with resolve_progress_task(
        "tighten_from_transcript",
        "Applying tighten cuts",
        prefer_parent=True,
    ) as prog:
        prog.set_phase("apply", "Applying tighten cuts…")
        applied = apply_tighten_decisions(project)
    return f"{applied} tighten cuts applied"


def clean_audio(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    highpass = ProcessingEffect(effect="highpass", params={"frequency": 80})
    touched = 0
    for track in project.tracks:
        if track.role != TrackRole.DIALOGUE:
            continue
        existing = next(
            (c for c in project.processing_chains if c.track_id == track.id),
            None,
        )
        if existing and existing.effects:
            effects = list(existing.effects)
            if not any(e.effect == "highpass" for e in effects):
                effects.insert(0, highpass)
            set_or_replace_chain(project, track.id, effects)
        else:
            set_or_replace_chain(project, track.id, [highpass])
        touched += 1
    return f"highpass on {touched} dialogue tracks"


def balance_tracks(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    eng = ffmpeg()
    target = float(defaults.get("balance", {}).get("dialogue_lufs", -20.0))
    adjusted = 0
    for track in project.tracks:
        if track.role != TrackRole.DIALOGUE or not track.media:
            continue
        path = Path(track.media.path)
        if not path.is_absolute():
            path = project.workspace_path() / path
        measured = eng.measure_loudness(path)
        if measured is None:
            continue
        track.gain_db = round(target - measured, 2)
        adjusted += 1
    return f"{adjusted} tracks gain-staged to {target:g} LUFS"


def compress_tracks(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    comp = defaults.get("compression", {})
    touched = 0
    for track in project.tracks:
        if track.role != TrackRole.DIALOGUE:
            continue
        existing = next(
            (c for c in project.processing_chains if c.track_id == track.id),
            None,
        )
        effects = list(existing.effects) if existing else []
        effects.append(
            ProcessingEffect(
                effect="acompressor",
                params={
                    "threshold_db": comp.get("threshold_db", -18),
                    "ratio": comp.get("ratio", 3),
                    "attack_ms": comp.get("attack_ms", 15),
                    "release_ms": comp.get("release_ms", 150),
                    "makeup_db": comp.get("makeup_db", 0),
                },
            )
        )
        set_or_replace_chain(project, track.id, effects)
        touched += 1
    return f"compressor on {touched} dialogue tracks"


def _render_track_stems(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.engines.play_audit import stem_is_fresh, track_render_hash, write_stem_hash
    from podcast_mcp.util.project_state import (
        project_file_revision,
        project_state_lock,
        snapshot_project_with_revision,
    )

    render_project, initial_revision = snapshot_project_with_revision(project)
    render_roles = {
        TrackRole.DIALOGUE,
        TrackRole.MUSIC,
        TrackRole.INTRO,
        TrackRole.OUTRO,
        TrackRole.SFX,
    }
    eng = ffmpeg()
    out_dir = render_project.artifacts_dir() / "tracks"
    out_dir.mkdir(parents=True, exist_ok=True)
    rendered: dict[str, Path] = {}
    to_render: list[Track] = []
    for track in render_project.tracks:
        if track.role not in render_roles:
            continue
        if not track.media:
            continue
        out = out_dir / f"{track.id}.wav"
        if stem_is_fresh(render_project, track.id):
            rendered[track.id] = out
            continue
        to_render.append(track)

    def render_one(track: Track) -> tuple[str, Path]:
        out = out_dir / f"{track.id}.wav"
        eng.render_dialogue_track(render_project, track, out, defaults)
        # Hash on the worker; clear invalidations serially below.
        write_stem_hash(render_project, track.id, clear_invalidations=False)
        return track.id, out

    max_workers = defaults.get("performance", {}).get("max_workers")
    from podcast_mcp.engines.render_invalidations import clear_invalidations_for_tracks

    with resolve_progress_task(
        "render_stems",
        "Rendering track stems",
        total=max(1, len(to_render)) if to_render else None,
        prefer_parent=True,
    ) as prog:
        if to_render:
            prog.set_phase("render", f"Rendering {len(to_render)} stems…")
        else:
            prog.set_phase("cache", "All stems cached")
        for done, (track_id, out) in enumerate(
            run_parallel(to_render, render_one, max_workers=max_workers),
            start=1,
        ):
            rendered[track_id] = out
            # A mutation during rendering must keep its new cause journal.
            with project_state_lock(project):
                if track_render_hash(project, track_id) == track_render_hash(
                    render_project, track_id
                ):
                    clear_invalidations_for_tracks(project, [track_id])
            if to_render:
                prog.advance(1, message=f"Stem {track_id} ({done}/{len(to_render)})")

    with project_state_lock(project):
        live_tracks = {
            track.id for track in project.tracks if track.role in render_roles and track.media
        }
        if (
            project_file_revision(project) != initial_revision
            or live_tracks != rendered.keys()
            or any(
                track_render_hash(project, track_id) != track_render_hash(render_project, track_id)
                for track_id in rendered
            )
        ):
            raise RuntimeError("project changed during stem rendering; retry the render")
        meta = artifact(project, "track_outputs.json")
        meta.write_text(
            json.dumps({k: str(v) for k, v in rendered.items()}, indent=2),
            encoding="utf-8",
        )
    cached = len(rendered) - len(to_render)
    return f"{len(to_render)} rendered, {cached} cached ({len(rendered)} total)"


def render_dialogue_stems(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    """Render per-track stems before FX/edits for pass-1 audibility reconciliation."""
    return _render_track_stems(project, defaults)


def assemble_timeline(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    """Render final per-track stems after edits and FX."""
    return _render_track_stems(project, defaults)


def mix_with_music(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    mix_cfg = defaults.get("mix", {})
    meta_path = artifact(project, "track_outputs.json")
    if not meta_path.is_file():
        assemble_timeline(project, defaults)
    rendered = json.loads(meta_path.read_text(encoding="utf-8"))
    eng = ffmpeg()

    with resolve_progress_task(
        "mix_with_music",
        "Mixing with music",
        prefer_parent=True,
    ) as prog:
        prog.set_phase("envelopes", "Building music envelopes…")
        music_envelopes = 0
        for track in project.tracks:
            if track.role not in (TrackRole.MUSIC, TrackRole.INTRO, TrackRole.OUTRO):
                continue
            if not track.media or track.id not in rendered:
                continue
            fade_in = float(mix_cfg.get("fade_in_sec", 2.0))
            fade_out = float(mix_cfg.get("fade_out_sec", 3.0))
            path = Path(rendered[track.id])
            probe = eng.probe(path)
            dur = probe.duration_sec
            project.automation_envelopes = [
                e for e in project.automation_envelopes if e.track_id != track.id
            ]
            project.automation_envelopes.append(
                AutomationEnvelope(
                    track_id=track.id,
                    points=[
                        AutomationPoint(time=0.0, value=0.0),
                        AutomationPoint(time=fade_in, value=1.0),
                        AutomationPoint(time=max(fade_in, dur - fade_out), value=1.0),
                        AutomationPoint(time=dur, value=0.0),
                    ],
                )
            )
            out = project.artifacts_dir() / "tracks" / f"{track.id}.wav"
            eng.render_dialogue_track(project, track, out, defaults)
            rendered[track.id] = str(out)
            music_envelopes += 1

        mix_inputs: list[tuple[Path, float]] = []
        for track in project.tracks:
            if track.muted or track.id not in rendered:
                continue
            mix_inputs.append((Path(rendered[track.id]), track.gain_db))

        prog.set_phase("mix", f"Mixing {len(mix_inputs)} tracks…")
        premix = artifact(project, "premix.wav")
        eng.mix_tracks(mix_inputs, premix)
        prog.message(f"{len(mix_inputs)} tracks mixed")
    return f"{len(mix_inputs)} tracks mixed, {music_envelopes} music envelopes"


def master_loudness(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    master_cfg = defaults.get("master", {})
    premix = artifact(project, "premix.wav")
    if not premix.is_file():
        mix_with_music(project, defaults)
    eng = ffmpeg()
    mastered = artifact(project, "mastered.wav")
    target_lufs = float(master_cfg.get("integrated_lufs", -16))
    target_tp = float(master_cfg.get("true_peak_db", -1.5))
    target_lra = float(master_cfg.get("lra", 11.0))
    lufs_tolerance = float(master_cfg.get("qc_lufs_tolerance_lu", 0.5))
    tp_tolerance = float(master_cfg.get("qc_true_peak_tolerance_db", 0.3))
    raw_crest = master_cfg.get("crest_tame_af", "dynaudnorm=f=150:g=15")
    crest_tame_af = str(raw_crest).strip() if raw_crest is not None else ""

    def _qc(measured: dict[str, float | None] | None) -> dict[str, Any]:
        qc: dict[str, Any] = {
            "target_integrated_lufs": target_lufs,
            "target_true_peak_db": target_tp,
            "measured": measured,
            "within_tolerance": None,
            "issues": [],
        }
        if measured:
            issues = []
            integrated = measured.get("integrated_lufs")
            if integrated is not None and abs(integrated - target_lufs) > lufs_tolerance:
                issues.append(
                    f"Integrated loudness {integrated} LUFS misses "
                    f"target {target_lufs} by more than {lufs_tolerance} LU"
                )
            true_peak = measured.get("true_peak_db")
            if true_peak is not None and true_peak > target_tp + tp_tolerance:
                issues.append(
                    f"True peak {true_peak} dBTP exceeds target {target_tp} "
                    f"by more than {tp_tolerance} dB"
                )
            qc["issues"] = issues
            qc["within_tolerance"] = not issues
        return qc

    with resolve_progress_task(
        "master_loudness",
        "Mastering loudness",
        prefer_parent=True,
    ) as prog:
        prog.set_phase("loudnorm", "Running loudnorm…")
        eng.master_loudnorm(
            premix,
            mastered,
            integrated_lufs=target_lufs,
            true_peak_db=target_tp,
            lra=target_lra,
        )
        prog.set_phase("measure", "Measuring loudness…")
        measured = eng.measure_loudness_full(mastered)
        qc = _qc(measured)

        # Peak-limited / high-crest premixes often under-shoot I under loudnorm alone.
        # Tame crest, then remaster once before writing QC.
        if (
            crest_tame_af
            and measured
            and qc.get("within_tolerance") is False
            and any("Integrated loudness" in i for i in (qc.get("issues") or []))
        ):
            prog.set_phase("crest_tame", "Taming crest then remastering…")
            tame_path = artifact(project, "premix_premaster.wav")
            eng.filter_audio(premix, tame_path, crest_tame_af)
            eng.master_loudnorm(
                tame_path,
                mastered,
                integrated_lufs=target_lufs,
                true_peak_db=target_tp,
                lra=target_lra,
            )
            measured = eng.measure_loudness_full(mastered)
            qc = _qc(measured)
            qc["crest_tame_af"] = crest_tame_af

        prog.set_phase("qc", "Writing master QC…")
        qc_path = artifact(project, "master_qc.json")
        qc_path.write_text(json.dumps(qc, indent=2), encoding="utf-8")

    if measured and measured.get("integrated_lufs") is not None:
        lufs = measured["integrated_lufs"]
        if qc["within_tolerance"]:
            return f"mastered to {lufs} LUFS (within tolerance)"
        return f"mastered to {lufs} LUFS ({len(qc['issues'])} QC issues)"
    return "mastered (loudness unmeasured)"


def export_deliverables(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    mastered = artifact(project, "mastered.wav")
    if not mastered.is_file():
        master_loudness(project, defaults)
    eng = ffmpeg()
    export_cfg = defaults.get("export", {})
    from podcast_mcp.export.audio import export_episode_audio
    from podcast_mcp.export.names import sanitize_export_stem

    with resolve_progress_task(
        "export_deliverables",
        "Exporting deliverables",
        prefer_parent=True,
    ) as prog:
        prog.set_phase("audio", "Writing audio formats…")
        written = export_episode_audio(
            project,
            eng,
            mastered,
            export_cfg,
            max_workers=defaults.get("performance", {}).get("max_workers"),
        )
        extras: list[str] = []
        if project.chapters:
            prog.set_phase("chapters", "Writing chapters…")
            chapters_path = (
                project.export_dir() / f"{sanitize_export_stem(project.name)}.chapters.json"
            )
            chapters_path.write_text(
                json.dumps([c.model_dump() for c in project.chapters], indent=2),
                encoding="utf-8",
            )
            extras.append(f"{len(project.chapters)} chapters")

        if project.combined_transcript:
            from podcast_mcp.export.transcript import (
                utterances_to_srt,
                write_combined_transcript_markdown,
            )

            prog.set_phase("transcript", "Writing transcript exports…")
            write_combined_transcript_markdown(project)
            srt = project.export_dir() / f"{sanitize_export_stem(project.name)}.srt"
            srt.write_text(utterances_to_srt(project), encoding="utf-8")
            extras.append("SRT+MD")

        prog.set_phase("qc", "Writing export QC…")
        qc = write_export_qc(project)
    parts = [f"{len(written)} audio files"]
    parts.extend(extras)
    if qc.get("ok"):
        parts.append("QC ok")
    else:
        parts.append(f"{len(qc.get('issues') or [])} QC issues")
    return ", ".join(parts)


def write_export_qc(project: EpisodeProject) -> dict[str, Any]:
    """Roll up pre-ship QC (reconciliation staleness + mastering) into export_qc.json.

    Non-blocking by design (matches master_loudness's QC pattern): always writes the
    report so an agent/user can check `ok`/`issues` before treating the export as
    final, rather than raising and aborting an otherwise-successful export.
    """
    from podcast_mcp.engines.reconciliation_state import reconciliation_status
    from podcast_mcp.engines.session_timeline import timebase_qc_report

    recon = reconciliation_status(project)
    timebase = timebase_qc_report(project)
    issues: list[str] = []
    if recon["stale"]:
        issues.append(
            "Transcript reconciliation is stale as of export -- dialogue audibility/bleed "
            "suppression may not reflect the final rendered/mixed audio. Re-run "
            "reconcile_transcript (or render_preview with reconciliation enabled) and "
            "re-export before shipping."
        )

    master_qc_path = artifact(project, "master_qc.json")
    master_qc: dict[str, Any] | None = None
    if master_qc_path.is_file():
        try:
            master_qc = json.loads(master_qc_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            master_qc = None
        if master_qc and master_qc.get("issues"):
            issues.extend(master_qc["issues"])

    issues.extend(timebase["issues"])
    warnings = list(timebase.get("warnings") or [])

    qc: dict[str, Any] = {
        "reconciliation": recon,
        "timebase": timebase,
        "master_qc": master_qc,
        "warnings": warnings,
        "issues": issues,
        "ok": not issues,
    }
    qc_path = artifact(project, "export_qc.json")
    qc_path.write_text(json.dumps(qc, indent=2), encoding="utf-8")
    return qc
