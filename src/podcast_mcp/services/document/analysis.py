"""Effects, loudness, fades recommendations, bleed, audibility and reconcile."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal, TypeVar

from podcast_mcp.edits.audio_quality import (
    apply_fade_recommendations,
    audio_diagnostics_report,
    bleed_words,
    cleanup_analysis_report,
    fade_recommendations,
    gate_overreach_report,
    suppress_bleed_words,
    suppress_low_audibility_words,
)
from podcast_mcp.edits.audio_quality import (
    low_audibility_words as audit_low_audibility_words,
)
from podcast_mcp.edits.inaudible_cuts import (
    optimize_source_cut_range,
    optimize_timeline_cut_range,
)
from podcast_mcp.edits.loudness import check_loudness
from podcast_mcp.edits.retained_bleed_alignment import (
    AlignmentPlan,
    apply_retained_bleed_alignment,
    plan_retained_bleed_alignment,
    set_retained_bleed_alignment_mode,
)
from podcast_mcp.edits.silence_islands import (
    SilenceIsland,
    silence_islands_from_hops,
    timeline_floor_hops,
)
from podcast_mcp.edits.silence_islands import (
    suggest_handoff_cut as suggest_handoff_cut_bounds,
)
from podcast_mcp.edits.strip_silence import strip_silence
from podcast_mcp.edits.transcript_bleed_mute import apply_transcript_bleed_mute
from podcast_mcp.edits.transcript_reconcile import (
    audibility_map as build_audibility_map,
)
from podcast_mcp.edits.transcript_reconcile import (
    flagged_words as list_flagged_transcript_words,
)
from podcast_mcp.edits.transcript_reconcile import (
    overlap_duplicate_report,
    reconciliation_status_report,
    run_reconciliation,
)
from podcast_mcp.effects.presets import (
    add_effect,
    apply_specs_to_chain,
    get_preset,
    list_presets,
    list_track_effects,
    remove_effect,
    set_effect_bypass,
)
from podcast_mcp.engines.effect_filters import is_supported_effect, supported_effect_names
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.document.service_base import WorkspaceService
from podcast_mcp.services.pipeline import rerender_preview
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import ProgressReporter
from podcast_mcp.util.project_state import RENDER_LOCK_TIMEOUT_SEC, render_lock
from podcast_mcp.util.timeline_zoom import snap_tick_decimals
from podcast_mcp.util.tracks import dialogue_track_ids

log = logging.getLogger(__name__)
T = TypeVar("T")


def _alignment_preview(plan: AlignmentPlan) -> dict[str, Any]:
    return {
        "proposed_count": len(plan.proposals),
        "proposals": [asdict(proposal) for proposal in plan.proposals],
        "skipped": list(plan.skipped),
    }


class AnalysisService(WorkspaceService):
    def strip_silence(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        over_voice_floor_db: float = 0.0,
        min_duration_sec: float = 0.5,
        use_inaudible_opt: bool | None = None,
    ) -> dict:
        """Strip silence islands; ``use_inaudible_opt`` is ignored (API compat)."""
        tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            return strip_silence(
                p,
                tid,
                over_voice_floor_db=over_voice_floor_db,
                min_duration_sec=min_duration_sec,
                use_inaudible_opt=use_inaudible_opt,
                defaults=self.ws.effective_config(),
            )

        return self.ws.mutate(
            "before strip silence",
            "after strip silence",
            mutate,
            operation="strip_silence",
            params={
                "track_id": tid,
                "over_voice_floor_db": over_voice_floor_db,
                "min_duration_sec": min_duration_sec,
                "use_inaudible_opt": use_inaudible_opt,
            },
        )

    def preview_inaudible_cut(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start: float,
        end: float,
        timeline: bool = False,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        if timeline:
            opt = optimize_timeline_cut_range(
                self.ws.project, tid, start, end, defaults=self.ws.effective_config()
            )
        else:
            opt = optimize_source_cut_range(
                self.ws.project, tid, start, end, defaults=self.ws.effective_config()
            )
        return {
            "track_id": tid,
            "timeline_mode": timeline,
            "start": opt.start,
            "end": opt.end,
            "mode": opt.mode,
            "shifted_start_ms": opt.shifted_start_ms,
            "shifted_end_ms": opt.shifted_end_ms,
            "confidence": opt.confidence,
            "details": opt.details,
        }

    def waveform_snap_window(
        self,
        *,
        track_id: str,
        start: float,
        end: float,
        timeline: bool = False,
        focus: float | None = None,
    ) -> dict[str, Any]:
        """Windowed snap ticks for the DAW overlay (non-blocking, capped)."""
        lo = float(start)
        hi = float(end)
        if hi < lo:
            lo, hi = hi, lo
        if hi - lo > 2.0:
            center = float(focus) if focus is not None else (lo + hi) / 2.0
            lo = center - 1.0
            hi = center + 1.0
        if hi - lo < 0.05:
            hi = lo + 0.05
        tid = self._resolve(track_id, None)
        preview: dict[str, Any] | None = None
        try:
            preview = self.preview_inaudible_cut(
                track_id=tid,
                start=lo,
                end=hi,
                timeline=timeline,
            )
        except Exception as exc:
            log.debug("waveform snap preview skipped: %s", exc)
        found: list[SilenceIsland] = []
        if timeline:
            try:
                hops = timeline_floor_hops(
                    self.ws.project, [tid], lo, hi, defaults=self.ws.effective_config()
                )
                found = silence_islands_from_hops(hops)
            except Exception as exc:
                log.debug("waveform snap islands skipped: %s", exc)
        islands = [i.to_dict() for i in found]
        ticks: list[float] = []
        if preview is not None:
            ticks.extend([float(preview["start"]), float(preview["end"])])
        # Unrounded midpoints: to_dict() rounds to 0.1 ms, too coarse at deep zoom.
        ticks.extend(float(island.midpoint) for island in found)
        # 1 µs (contract `snap_tick_decimals`): ticks stay distinct at near-sample zoom.
        uniq = sorted({round(t, snap_tick_decimals()) for t in ticks})
        return {
            "track_id": tid,
            "start": lo,
            "end": hi,
            "timeline_mode": timeline,
            "preview": preview,
            "islands": islands,
            "ticks": uniq,
        }

    def suggest_handoff_cut(
        self,
        *,
        keep_left_end: float,
        keep_right_start: float,
        track_id: str | None = None,
        speaker: str | None = None,
        min_island_sec: float = 0.12,
        hop_ms: int = 20,
        retain_sec: float = 1.0,
    ) -> dict:
        tids = (
            [self._resolve(track_id, speaker)]
            if track_id is not None or speaker is not None
            else dialogue_track_ids(self.ws.project)
        )
        return suggest_handoff_cut_bounds(
            self.ws.project,
            tids,
            keep_left_end,
            keep_right_start,
            min_island_sec=min_island_sec,
            hop_ms=hop_ms,
            retain_sec=retain_sec,
            defaults=self.ws.effective_config(),
        )

    def check_loudness(self, audio_path: str | None = None) -> dict:
        """Measure audio and report known project freshness without rendering.

        An explicit unrelated file has no project freshness claim (``stale=None``).
        Tracked project audio also reports each dialogue track's balance status. The
        loudness ``pass`` remains the measured level verdict, independent of age.
        """
        from podcast_mcp.engines.balance import balance_status
        from podcast_mcp.engines.mastering import MasterTarget
        from podcast_mcp.engines.play_audit import (
            mastered_is_fresh,
            mastered_path,
            premix_is_stale,
            premix_path,
            read_premix_hash,
        )
        from podcast_mcp.export.names import sanitize_export_stem
        from podcast_mcp.services.pipeline import run_defaults_for

        project = self.ws.project
        target = MasterTarget.from_defaults(run_defaults_for(self.ws.path))
        export_wav = project.export_dir() / f"{sanitize_export_stem(project.name)}.wav"
        premix = premix_path(project)
        path = Path(audio_path) if audio_path else export_wav if export_wav.is_file() else premix
        if not path.is_file():
            raise FileNotFoundError(f"no audio to measure: {path}")
        report = check_loudness(path, defaults=self.ws.effective_config())
        if path.resolve() == premix.resolve():
            if read_premix_hash(project) is None:
                reason = "premix_unverified"
            elif premix_is_stale(project, defaults=self.ws.effective_config()):
                reason = "premix_stale"
            else:
                reason = None
        elif path.resolve() == export_wav.resolve():
            master = mastered_path(project)
            if not premix.is_file():
                reason = "premix_missing"
            elif read_premix_hash(project) is None:
                reason = "premix_unverified"
            elif premix_is_stale(project, defaults=self.ws.effective_config()):
                reason = "premix_stale"
            elif not master.is_file():
                reason = "master_missing"
            elif not mastered_is_fresh(project, target):
                reason = "master_stale"
            elif path.stat().st_mtime_ns < master.stat().st_mtime_ns:
                reason = "export_older_than_master"
            else:
                reason = None
        else:
            report.update(stale=None, stale_reason="untracked_audio")
            return report
        report.update(stale=reason is not None, stale_reason=reason)
        report["balance"] = {
            track.id: balance_status(project, track)
            for track in project.tracks
            if track.role.value == "dialogue" and track.media is not None
        }
        return report

    def add_effect(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        preset: str | None = None,
        effect: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        specs = get_preset(preset, defaults=self.ws.effective_config()) if preset else None
        requested = (
            [spec["effect"] for spec in specs]
            if specs is not None
            else ([effect] if effect else [])
        )
        unsupported = [name for name in requested if not is_supported_effect(name)]
        if unsupported:
            supported = ", ".join(supported_effect_names())
            names = ", ".join(f"'{name}'" for name in unsupported)
            raise CodedValueError(
                f"unsupported effect {names}; supported effects: {supported}",
                code="unsupported_effect",
            )

        def mutate(p) -> dict:
            if preset and specs is not None:
                chain = apply_specs_to_chain(p, tid, specs)
            elif effect:
                chain = add_effect(p, tid, effect, params)
            else:
                raise CodedValueError("preset or effect is required", code="effect_required")
            return {"track_id": tid, "effects": [e.model_dump() for e in chain.effects]}

        return self.ws.mutate("before add effect", "after add effect", mutate)

    def remove_effect(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        effect: str | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            removed = remove_effect(p, tid, effect)
            return {"track_id": tid, "removed": removed}

        return self.ws.mutate("before remove effect", "after remove effect", mutate)

    def set_effect_bypass(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        effect_index: int,
        bypass: bool,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return self.ws.mutate(
            "before set effect bypass",
            "after set effect bypass",
            lambda p: set_effect_bypass(p, tid, effect_index, bypass),
            operation="set_effect_bypass",
            params={
                "track_id": tid,
                "effect_index": effect_index,
                "bypass": bypass,
            },
        )

    def list_effects(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker) if (track_id or speaker) else None
        if tid:
            return {
                "track_id": tid,
                "effects": list_track_effects(self.ws.project, tid),
                "supported_effects": list(supported_effect_names()),
            }
        return {
            "presets": list_presets(defaults=self.ws.effective_config()),
            "supported_effects": list(supported_effect_names()),
        }

    def analyze_cleanup(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return cleanup_analysis_report(
            self.ws.project, track_id=tid, progress=progress, defaults=self.ws.effective_config()
        )

    def audio_diagnostics(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return audio_diagnostics_report(
            self.ws.project,
            tid,
            start_sec=start_sec,
            end_sec=end_sec,
            defaults=self.ws.effective_config(),
        )

    def recommend_fades(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return fade_recommendations(
            self.ws.project, track_id=tid, defaults=self.ws.effective_config()
        )

    def apply_fade_recommendations(self, recommendations: list[dict]) -> dict:
        return self.ws.mutate(
            "before apply fade recommendations",
            "after apply fade recommendations",
            lambda p: apply_fade_recommendations(
                p, recommendations, defaults=self.ws.effective_config()
            ),
        )

    def apply_fade_recommendations_for_track(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> dict:
        """Recommend boundary fades for a track (or all), then apply them."""
        recs = self.recommend_fades(track_id=track_id, speaker=speaker)
        if not recs:
            return {"applied_fade_updates": 0, "recommendation_count": 0}
        result = self.apply_fade_recommendations(recs)
        return {**result, "recommendation_count": len(recs)}

    def low_audibility_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return audit_low_audibility_words(
            self.ws.project, track_id=tid, progress=progress, defaults=self.ws.effective_config()
        )

    def suppress_low_audibility(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        word_keys: list[dict] | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            return suppress_low_audibility_words(
                p, track_id=tid, word_keys=word_keys, defaults=self.ws.effective_config()
            )

        return self.ws.mutate(
            "before suppress low audibility",
            "after suppress low audibility",
            mutate,
        )

    def list_bleed_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return bleed_words(
            self.ws.project,
            track_id=tid,
            start_sec=start_sec,
            end_sec=end_sec,
            progress=progress,
            defaults=self.ws.effective_config(),
        )

    def suppress_bleed(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        word_keys: list[dict] | None = None,
        exclude_word_keys: list[dict] | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        apply: bool = True,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)

        if not apply:
            return suppress_bleed_words(
                self.ws.project,
                track_id=tid,
                word_keys=word_keys,
                exclude_word_keys=exclude_word_keys,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=True,
                progress=progress,
                defaults=self.ws.effective_config(),
            )

        def mutate(p) -> dict:
            return suppress_bleed_words(
                p,
                track_id=tid,
                word_keys=word_keys,
                exclude_word_keys=exclude_word_keys,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=False,
                progress=progress,
                defaults=self.ws.effective_config(),
            )

        return self.ws.mutate(
            "before suppress bleed",
            "after suppress bleed",
            mutate,
        )

    def overlap_duplicates(
        self,
        *,
        start_sec: float | None = None,
        end_sec: float | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        return overlap_duplicate_report(
            self.ws.project,
            start_sec=start_sec,
            end_sec=end_sec,
            progress=progress,
            defaults=self.ws.effective_config(),
        )

    def align_retained_bleed(
        self,
        *,
        track_id: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        apply: bool = True,
        override_placement_lock: bool = False,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        def plan(p: EpisodeProject) -> AlignmentPlan:
            return plan_retained_bleed_alignment(
                p,
                track_id=track_id,
                start_sec=start_sec,
                end_sec=end_sec,
                override_placement_lock=override_placement_lock,
                defaults=self.ws.effective_config(),
            )

        if not apply:
            return _alignment_preview(plan(self.ws.project))

        def mutate(p: EpisodeProject) -> dict[str, Any]:
            result = apply_retained_bleed_alignment(p, plan(p), defaults=self.ws.effective_config())
            if result["applied_count"]:
                rerender_preview(p, reconcile=False, defaults=self.ws.effective_config())
            return result

        with render_lock(self.ws.project, timeout=lock_timeout):
            return self.ws.mutate(
                "before retained bleed alignment", "after retained bleed alignment", mutate
            )

    def set_bleed_alignment_mode(
        self,
        decision_id: str,
        mode: Literal["auto", "manual", "declined"],
        *,
        track_id: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        override_placement_lock: bool = False,
    ) -> dict[str, Any]:
        def mutate(p: EpisodeProject) -> dict[str, Any]:
            proposal = None
            if not any(d.id == decision_id for d in p.editorial.retained_bleed_alignments):
                plan = plan_retained_bleed_alignment(
                    p,
                    track_id=track_id,
                    start_sec=start_sec,
                    end_sec=end_sec,
                    override_placement_lock=override_placement_lock,
                    defaults=self.ws.effective_config(),
                )
                proposal = next(
                    (item for item in plan.proposals if item.decision_id == decision_id), None
                )
            return set_retained_bleed_alignment_mode(p, decision_id, mode, proposal=proposal)

        return self.ws.mutate(
            "before bleed alignment choice", "after bleed alignment choice", mutate
        )

    def apply_bleed_mute(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        apply: bool = True,
        align_retained_bleed: bool = True,
        override_placement_lock: bool = False,
        progress: ProgressReporter | None = None,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker) if track_id or speaker else None

        def run(p: EpisodeProject, *, dry_run: bool) -> dict:
            alignment = None
            if align_retained_bleed:
                plan = plan_retained_bleed_alignment(
                    p,
                    track_id=tid,
                    start_sec=start_sec,
                    end_sec=end_sec,
                    override_placement_lock=override_placement_lock,
                    defaults=self.ws.effective_config(),
                )
                if plan.proposals or plan.skipped:
                    alignment = (
                        _alignment_preview(plan)
                        if dry_run
                        else apply_retained_bleed_alignment(
                            p, plan, defaults=self.ws.effective_config()
                        )
                    )
                    if not dry_run and alignment["applied_count"]:
                        rerender_preview(
                            p,
                            reconcile=False,
                            progress=progress,
                            defaults=self.ws.effective_config(),
                        )
            result = apply_transcript_bleed_mute(
                p,
                track_id=tid,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=dry_run,
                progress=progress,
                defaults=self.ws.effective_config(),
            )
            if alignment is not None:
                result["alignment"] = alignment
            return result

        if not apply:
            return run(self.ws.project, dry_run=True)

        with render_lock(self.ws.project, timeout=lock_timeout, cancel_check=cancel_check):
            return self.ws.mutate(
                "before apply bleed mute",
                "after apply bleed mute",
                lambda p: run(p, dry_run=False),
            )

    def mute_off_speaker(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        apply: bool = True,
        progress: ProgressReporter | None = None,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
    ) -> dict:
        """Mute a track wherever another speaker talks and its own speaker does not (#1740).

        Preview with ``apply=False``. Applied stretches retain separate automatic ownership.
        One History Undo reverses the command. Equivalent reapply adds no history.
        Stretches held by cut safety checks stay open.
        """
        from podcast_mcp.edits.off_speaker_mute import (
            apply_off_speaker_mutes,
            plan_off_speaker_mutes,
        )

        tid = self._resolve(track_id, speaker)
        if not apply:
            plan = plan_off_speaker_mutes(
                self.ws.project, tid, progress=progress, defaults=self.ws.effective_config()
            )
            return {"dry_run": True, **plan.summary()}

        from podcast_mcp.project.merge import adopt_project_state

        with render_lock(self.ws.project, timeout=lock_timeout), self.ws.transaction():
            plan = plan_off_speaker_mutes(
                self.ws.project, tid, progress=progress, defaults=self.ws.effective_config()
            )
            result = {"dry_run": False, **plan.summary()}
            if not plan.regions:
                return result
            candidate = self.ws.project.model_copy(deep=True)
            applied = apply_off_speaker_mutes(candidate, plan, defaults=self.ws.effective_config())
            if applied["applied_count"]:
                self.ws.mutate(
                    "before mute off speaker",
                    "after mute off speaker",
                    lambda p: adopt_project_state(p, candidate),
                )
            return {**result, **applied}

    def gate_overreach(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return gate_overreach_report(
            self.ws.project, tid, progress=progress, defaults=self.ws.effective_config()
        )

    def audibility_map(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return build_audibility_map(
            self.ws.project, track_id=tid, progress=progress, defaults=self.ws.effective_config()
        )

    def flagged_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return list_flagged_transcript_words(
            self.ws.project, track_id=tid, progress=progress, defaults=self.ws.effective_config()
        )

    def reconciliation_status(self) -> dict:
        return reconciliation_status_report(self.ws.project, defaults=self.ws.effective_config())

    def reconcile_transcript(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        dry_run: bool | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            return run_reconciliation(
                p,
                dry_run=dry_run,
                track_id=tid,
                start_sec=start_sec,
                end_sec=end_sec,
                progress=progress,
                defaults=self.ws.effective_config(),
            )

        return self.ws.mutate(
            "before reconcile transcript",
            "after reconcile transcript",
            mutate,
        )
