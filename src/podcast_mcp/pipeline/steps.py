from __future__ import annotations

import functools
import json
import logging
import math
from pathlib import Path
from typing import Any

from podcast_mcp.config import mix_peak_ceiling_db
from podcast_mcp.edits import apply_tighten_decisions, propose_tighten_edits
from podcast_mcp.engines import TranscriptionEngine
from podcast_mcp.engines.ffmpeg import LoudnormResult
from podcast_mcp.engines.waveform_media import ensure_project_waveforms, schedule_stem_waveforms
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
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.progress import resolve_progress_task
from podcast_mcp.util.project_state import with_render_lock
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
    ensure_dialogue_clips(project)
    # After clips exist, so each track's clip sources get their pyramids too.
    waveforms = ensure_project_waveforms(project)
    dialogue = sum(1 for t in project.tracks if t.role == TrackRole.DIALOGUE)
    return f"{probed} tracks probed, {waveforms} waveforms, {dialogue} dialogue"


def transcribe_tracks(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.edits.pipeline_unattended import is_unattended
    from podcast_mcp.edits.transcript_reuse import plan_transcription, run_transcribe_plan
    from podcast_mcp.engines.audio_audit import AnalysisPolicy
    from podcast_mcp.engines.transcribe import (
        collect_anomalous_asr_duration_flags,
        dialogue_transcribe_jobs,
    )

    cfg = defaults.get("transcribe", {})
    pol = AnalysisPolicy.from_defaults(defaults)
    overwrite = bool(cfg.get("overwrite", False))
    jobs = dialogue_transcribe_jobs(project)
    plan = plan_transcription(
        project,
        jobs,
        overwrite=overwrite,
        unattended=is_unattended(defaults=defaults),
        allow_edited=bool(cfg.get("overwrite_edited", False)),
    )
    transcripts = run_transcribe_plan(
        project,
        plan,
        lambda: TranscriptionEngine(
            model_size=cfg.get("model", DEFAULT_WHISPER_MODEL),
            device="cpu",
        ),
        use_cache=not overwrite,
        language=cfg.get("language", "en"),
        max_word_sec=pol.max_word_audibility_sec,
    )
    job_keys = {j.key for j in jobs}
    words = sum(len(t.words) for t in project.transcripts if t.key in job_keys)
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
    summary = f"{len(transcripts)} transcribed, {len(plan.reused)} reused, {words} words"
    if plan.overwrite_edited:
        summary += f", {len(plan.overwrite_edited)} edited overwritten"
    if timing_flags:
        summary += f", {len(timing_flags)} timing flags"
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


def _track_media_path(project: EpisodeProject, track: Track) -> Path:
    assert track.media is not None
    path = Path(track.media.path)
    return path if path.is_absolute() else project.workspace_path() / path


def balance_tracks(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    """Stage each dialogue track's ``gain_db`` so its post-FX own-speech loudness hits the target.

    Measures the media through the track's processing chain (what the stem renders),
    gated to the track's non-suppressed transcript words so bleed and silence don't count.
    """
    from podcast_mcp.engines.transcript_gated_play import source_word_intervals
    from podcast_mcp.util.loudness import speech_gated_lufs

    eng = ffmpeg()
    target = float(defaults.get("balance", {}).get("dialogue_lufs", -20.0))
    jobs = [
        (t, _track_media_path(project, t))
        for t in project.tracks
        if t.role == TrackRole.DIALOGUE and t.media
    ]
    reports: list[str] = []
    gated_all = True
    with resolve_progress_task(
        "balance_tracks", "Balancing track levels", total=max(1, len(jobs)), prefer_parent=True
    ) as prog:
        prog.set_phase("measure", f"Measuring {len(jobs)} tracks after FX…")
        for done, (track, path) in enumerate(jobs, start=1):
            chain = next((c for c in project.processing_chains if c.track_id == track.id), None)
            # Envelope left out: its times are stem-clock mix automation, not level.
            blocks = eng.measure_loudness_blocks(path, eng.build_track_filter(chain, None))
            speech = source_word_intervals(project, track.id, 0.0, math.inf)
            measured = speech_gated_lufs(blocks, speech)
            prog.advance(1, message=f"Measured {track.id} ({done}/{len(jobs)})")
            if measured.lufs is None:
                continue
            track.gain_db = round(target - measured.lufs, 2)
            achieved = round(measured.lufs + track.gain_db, 1)
            gated_all = gated_all and measured.speech_gated
            reports.append(
                f"{track.id} {achieved:g} LUFS ({track.gain_db:+.1f} dB"
                f"{'' if measured.speech_gated else ', ungated'})"
            )
    if not reports:
        return f"0 tracks gain-staged (no loudness measured; target {target:g} LUFS)"
    how = "post-FX, speech-gated" if gated_all else "post-FX"
    return f"{len(reports)} tracks gain-staged to {target:g} LUFS ({how}): " + ", ".join(reports)


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


def _stem_inputs_changed(
    project: EpisodeProject,
    render_project: EpisodeProject,
    rendered: dict[str, Path],
    render_roles: set[TrackRole],
) -> bool:
    """Whether ``project`` would render other stems than the ``render_project`` snapshot did.

    ``track_render_hash`` leaves out the mix-only volume and mute, so saving
    those mid-render doesn't void the stems.
    """
    from podcast_mcp.engines.play_audit import track_render_hash

    live = {t.id for t in project.tracks if t.role in render_roles and t.media}
    return live != rendered.keys() or any(
        track_render_hash(project, tid) != track_render_hash(render_project, tid)
        for tid in rendered
    )


def _saved_stem_inputs_changed(
    project: EpisodeProject,
    render_project: EpisodeProject,
    rendered: dict[str, Path],
    render_roles: set[TrackRole],
) -> bool:
    """``_stem_inputs_changed`` against the project another writer saved meanwhile."""
    from podcast_mcp.project_store import ProjectStore

    try:
        saved = ProjectStore(project.workspace_path()).load()
    except (OSError, ValueError) as exc:
        # Gone, unreadable or half-written (pydantic and JSON errors are ValueErrors).
        log.warning("saved project unreadable after stem render; treating stems as stale: %s", exc)
        return True
    return _stem_inputs_changed(saved, render_project, rendered, render_roles)


@with_render_lock
def _render_track_stems(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.engines.play_audit import (
        clear_invalidations_if_current,
        publish_stem,
        stem_is_fresh,
    )
    from podcast_mcp.util.project_state import (
        live_project,
        project_file_revision,
        project_state_lock,
        snapshot_project_with_revision,
    )

    render_project, initial_revision = snapshot_project_with_revision(project)
    # A pipeline step renders its private copy; concurrent edits land on the live project (#357).
    live = live_project(project)
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
        # Runs on a run_parallel worker: never call anything that takes render_lock here (the
        # file lock is thread-local, so it would wait on this step's own hold).
        # Publish WAV + hash from the snapshot; clear invalidations serially below.
        out = publish_stem(
            render_project,
            track.id,
            lambda tmp: eng.render_dialogue_track(render_project, track, tmp, defaults),
            clear_invalidations=False,
        )
        return track.id, out

    max_workers = defaults.get("performance", {}).get("max_workers")

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
                clear_invalidations_if_current(project, render_project, track_id, current=live)
            if to_render:
                prog.advance(1, message=f"Stem {track_id} ({done}/{len(to_render)})")

    with project_state_lock(project):
        if _stem_inputs_changed(live, render_project, rendered, render_roles) or (
            project_file_revision(project) != initial_revision
            and _saved_stem_inputs_changed(project, render_project, rendered, render_roles)
        ):
            raise RuntimeError("project changed during stem rendering; retry the render")
        meta = artifact(project, "track_outputs.json")
        meta.write_text(
            json.dumps({k: str(v) for k, v in rendered.items()}, indent=2),
            encoding="utf-8",
        )
    schedule_stem_waveforms(project, list(rendered))
    cached = len(rendered) - len(to_render)
    return f"{len(to_render)} rendered, {cached} cached ({len(rendered)} total)"


def render_dialogue_stems(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    """Render per-track stems before FX/edits for pass-1 audibility reconciliation."""
    return _render_track_stems(project, defaults)


def assemble_timeline(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    """Render final per-track stems after edits and FX."""
    return _render_track_stems(project, defaults)


@with_render_lock
def mix_with_music(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.engines.play_audit import (
        clear_premix_hash,
        mix_gains,
        premix_path,
        publish_stem,
        write_premix_hash,
    )

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
            out = publish_stem(
                project,
                track.id,
                functools.partial(eng.render_dialogue_track, project, track, defaults=defaults),
                clear_invalidations=False,
            )
            rendered[track.id] = str(out)
            music_envelopes += 1

        # The same set the staleness check compares against, less anything
        # this run has no stem for.
        mixed = {tid: gain for tid, gain in mix_gains(project).items() if tid in rendered}
        if not mixed:
            if any(track.id in rendered for track in project.tracks):
                raise ValueError("every track is muted in the mix; unmute one to mix")
            raise ValueError("no tracks to mix")

        prog.set_phase("mix", f"Mixing {len(mixed)} tracks…")
        inputs = [(Path(rendered[tid]), gain) for tid, gain in mixed.items()]
        # Mix beside it and swap in whole with the old hash dropped first (#356): a failed or
        # cancelled mix keeps the old premix and hash, and no reader pairs old hash, new bytes.
        ceiling = mix_peak_ceiling_db(defaults)
        render_atomic(
            premix_path(project),
            lambda tmp: eng.mix_tracks(inputs, tmp, peak_ceiling_db=ceiling),
            before_replace=functools.partial(clear_premix_hash, project),
            reap_partials=True,
        )
        write_premix_hash(project, mixed, peak_ceiling_db=ceiling)
        prog.message(f"{len(mixed)} tracks mixed")
    return f"{len(mixed)} tracks mixed, {music_envelopes} music envelopes"


@with_render_lock
def ensure_current_premix(project: EpisodeProject, defaults: dict[str, Any]) -> None:
    """Re-render stems and re-mix when ``premix.wav`` is missing or behind the project.

    Warns when the rebuilt premix still reads stale (a stem that never goes fresh,
    such as a duration mismatch), since every export would otherwise redo it silently.
    """
    from podcast_mcp.engines.play_audit import (
        premix_is_stale,
        premix_path,
        stem_is_fresh,
        stem_path,
    )
    from podcast_mcp.util.tracks import mixed_dialogue_track_ids

    if premix_path(project).is_file() and not premix_is_stale(project, defaults):
        return
    assemble_timeline(project, defaults)
    mix_with_music(project, defaults)
    if premix_is_stale(project, defaults):
        stuck = [
            tid
            for tid in mixed_dialogue_track_ids(project)
            if stem_path(project, tid).is_file() and not stem_is_fresh(project, tid)
        ]
        log.warning(
            "premix.wav is still out of date after a rebuild; stems that stay stale: %s "
            "(check render_status for a duration mismatch)",
            ", ".join(stuck) or "none",
        )


@with_render_lock
def ensure_current_master(project: EpisodeProject, defaults: dict[str, Any]) -> Path:
    """Master again unless ``mastered.wav`` came from the current, fresh premix."""
    from podcast_mcp.engines.play_audit import mastered_is_fresh, mastered_path, premix_is_stale

    # The cheap hash check first: master_loudness checks the premix itself, so
    # the premix is checked here only when the master looks fresh.
    if not mastered_is_fresh(project) or premix_is_stale(project, defaults):
        master_loudness(project, defaults)
    return mastered_path(project)


@with_render_lock
def master_loudness(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    from podcast_mcp.engines.play_audit import (
        clear_mastered_hash,
        master_source_hash,
        mastered_path,
        premix_path,
        write_mastered_hash,
    )

    master_cfg = defaults.get("master", {})
    ensure_current_premix(project, defaults)
    premix = premix_path(project)
    # Fingerprint the premix before mastering it: a Refresh that swaps it while
    # loudnorm runs must leave this master stale, not vouch for it.
    source_hash = master_source_hash(project)
    eng = ffmpeg()
    mastered = mastered_path(project)
    tame_path = artifact(project, "premix_premaster.wav")
    qc_path = artifact(project, "master_qc.json")
    # A failed or cancelled master must not leave a hash or QC report vouching for it.
    clear_mastered_hash(project)
    qc_path.unlink(missing_ok=True)
    target_lufs = float(master_cfg.get("integrated_lufs", -16))
    target_tp = float(master_cfg.get("true_peak_db", -1.5))
    target_lra = float(master_cfg.get("lra", 11.0))
    lufs_tolerance = float(master_cfg.get("qc_lufs_tolerance_lu", 0.5))
    tp_tolerance = float(master_cfg.get("qc_true_peak_tolerance_db", 0.3))
    raw_crest = master_cfg.get("crest_tame_af", "dynaudnorm=f=150:g=15")
    crest_tame_af = str(raw_crest).strip() if raw_crest is not None else ""

    def _qc(measured: dict[str, float | None] | None, loudnorm: LoudnormResult) -> dict[str, Any]:
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
        qc["normalization_type"] = loudnorm.normalization_type
        qc["loudnorm_input"] = loudnorm.measured_input
        return qc

    measured: dict[str, float | None] | None = None
    qc: dict[str, Any] = {}
    try:
        with resolve_progress_task(
            "master_loudness",
            "Mastering loudness",
            prefer_parent=True,
        ) as prog:
            loudnorm: LoudnormResult | None = None

            def _loudnorm(src: Path, dest: Path) -> LoudnormResult:
                with prog.child("master_loudnorm", "Normalizing loudness") as sub:
                    last = -1

                    def report(done_sec: float, total_sec: float) -> None:
                        nonlocal last
                        whole = int(done_sec)
                        if whole == last:
                            return
                        last = whole
                        total = max(1, math.ceil(total_sec))
                        sub.advance_to(
                            min(whole, total), total=total, message=f"{whole} of {total} s"
                        )

                    return eng.master_loudnorm(
                        src,
                        dest,
                        integrated_lufs=target_lufs,
                        true_peak_db=target_tp,
                        lra=target_lra,
                        on_progress=report,
                    )

            def _master_into(tmp: Path) -> None:
                nonlocal measured, qc, loudnorm
                prog.set_phase("loudnorm", "Measuring premix, then normalizing loudness…")
                loudnorm = _loudnorm(premix, tmp)
                prog.set_phase("measure", "Measuring loudness…")
                measured = eng.measure_loudness_full(tmp)
                qc = _qc(measured, loudnorm)
                # Peak-limited / high-crest premixes often under-shoot I under loudnorm alone.
                # Tame crest, then remaster once before writing QC.
                if (
                    crest_tame_af
                    and measured
                    and qc.get("within_tolerance") is False
                    and any("Integrated loudness" in i for i in (qc.get("issues") or []))
                ):
                    prog.set_phase("crest_tame", "Taming crest then remastering…")
                    eng.filter_audio(premix, tame_path, crest_tame_af)
                    loudnorm = _loudnorm(tame_path, tmp)
                    measured = eng.measure_loudness_full(tmp)
                    qc = _qc(measured, loudnorm)
                    qc["crest_tame_af"] = crest_tame_af

            # Master beside it and swap in whole; its hash was already dropped above.
            render_atomic(mastered, _master_into, reap_partials=True)
            prog.set_phase("qc", "Writing master QC…")
            qc_path.write_text(json.dumps(qc, indent=2), encoding="utf-8")
            write_mastered_hash(project, source_hash)
    finally:
        tame_path.unlink(missing_ok=True)

    if measured and measured.get("integrated_lufs") is not None:
        lufs = measured["integrated_lufs"]
        kind = (loudnorm.normalization_type if loudnorm else None) or "unknown"
        if qc["within_tolerance"]:
            return f"mastered to {lufs} LUFS ({kind} loudnorm, within tolerance)"
        return f"mastered to {lufs} LUFS ({kind} loudnorm, {len(qc['issues'])} QC issues)"
    return "mastered (loudness unmeasured)"


@with_render_lock
def export_deliverables(project: EpisodeProject, defaults: dict[str, Any]) -> StepSummary:
    mastered = ensure_current_master(project, defaults)
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
        qc = write_export_qc(project, defaults=defaults)
    parts = [f"{len(written)} audio files"]
    parts.extend(extras)
    if qc.get("ok"):
        parts.append("QC ok")
    else:
        parts.append(f"{len(qc.get('issues') or [])} QC issues")
    return ", ".join(parts)


def write_export_qc(
    project: EpisodeProject, *, defaults: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Roll up pre-ship QC (reconciliation, mastering, alignment drift) into export_qc.json.

    Non-blocking by design (matches master_loudness's QC pattern): always writes the
    report so an agent/user can check `ok`/`issues` before treating the export as
    final, rather than raising and aborting an otherwise-successful export.
    """
    from podcast_mcp.edits.align_accept_status import alignment_drift_report
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
    alignment = alignment_drift_report(project, defaults=defaults)
    issues.extend(alignment["issues"])
    warnings = list(timebase.get("warnings") or [])
    warnings.extend(alignment["warnings"])

    qc: dict[str, Any] = {
        "reconciliation": recon,
        "timebase": timebase,
        "alignment": alignment,
        "master_qc": master_qc,
        "warnings": warnings,
        "issues": issues,
        "ok": not issues,
    }
    qc_path = artifact(project, "export_qc.json")
    qc_path.write_text(json.dumps(qc, indent=2), encoding="utf-8")
    return qc
