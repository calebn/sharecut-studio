from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.edits import (
    TightenProposal,
    apply_auto_edits,
    apply_edit_plan,
    approve_edits,
    build_edit_context_json,
    cut_text_match,
    cut_time_range,
    cut_utterance,
    cut_words,
    edit_impact_report,
    format_edit_impact_markdown,
    format_transcript_timestamps,
    list_edit_decisions,
    propose_tighten_edits,
    reject_edits,
    search_transcript,
)
from podcast_mcp.edits.audio_cache import TrackAudioCache
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
from podcast_mcp.edits.chapters import (
    add_chapter,
    delete_chapter,
    list_chapters,
    remove_chapter,
    update_chapter,
)
from podcast_mcp.edits.decisions import update_pending_edit
from podcast_mcp.edits.edit_log import list_applied_edits, revert_applied_edit
from podcast_mcp.edits.inaudible_cuts import (
    optimize_source_cut_range,
    optimize_timeline_cut_range,
)
from podcast_mcp.edits.join_continuity import (
    assess_existing_join,
    assess_project_joins,
    assess_proposed_cut,
)
from podcast_mcp.edits.join_labels import record_label
from podcast_mcp.edits.join_modes import crossfade_joins, fade_joins, set_clip_join_mode
from podcast_mcp.edits.loudness import check_loudness
from podcast_mcp.edits.silence_islands import (
    SilenceIsland,
    silence_islands_from_hops,
    timeline_rms_hops,
)
from podcast_mcp.edits.silence_islands import (
    suggest_handoff_cut as suggest_handoff_cut_bounds,
)
from podcast_mcp.edits.strip_silence import strip_silence
from podcast_mcp.edits.timeline_ops import (
    delete_clips,
    duplicate_segment,
    fill_with_room_tone,
    insert_gap,
    list_clips,
    move_by_text,
    move_clips,
    move_segment,
    paste_segment,
    ripple_delete,
    ripple_delete_text,
    roll_clip_join,
    set_clip_fade,
    shorten_word_gaps,
    split_clips_at,
    trim_clip_edge,
)
from podcast_mcp.edits.transcript_bleed_mute import apply_transcript_bleed_mute
from podcast_mcp.edits.transcript_correct import (
    apply_transcript_corrections,
    correct_phrase,
    correct_word,
    list_low_confidence,
    set_word_suppressed,
    verify_words,
)
from podcast_mcp.edits.transcript_cuts import (
    TranscriptMatch,
    append_remove_decision,
    append_split_decision,
)
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
from podcast_mcp.edits.transcript_refine_status import assert_refine_clear
from podcast_mcp.effects.presets import (
    add_effect,
    apply_preset_to_chain,
    list_presets,
    list_track_effects,
    remove_effect,
    set_effect_bypass,
)
from podcast_mcp.engines.render_status import render_status_report
from podcast_mcp.models import EditDecision
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.progress import ProgressReporter
from podcast_mcp.util.timeline_zoom import snap_tick_decimals
from podcast_mcp.util.tracks import resolve_track

log = logging.getLogger(__name__)


class EditService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def _resolve(self, track_id: str | None, speaker: str | None) -> str:
        return resolve_track(self.ws.project, track_id=track_id, speaker=speaker)

    def _require_refine_clear(self) -> None:
        assert_refine_clear(self.ws.project, defaults=load_defaults())

    def build_context(self, max_utterances: int = 200) -> str:
        return build_edit_context_json(self.ws.project, max_utterances=max_utterances)

    def search(
        self,
        query: str,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> list[TranscriptMatch]:
        return search_transcript(self.ws.project, query, track_id=track_id, speaker=speaker)

    def cut_time_range(
        self,
        track_id: str,
        start: float,
        end: float,
        *,
        reason: str = "nl:range",
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> None:
        self._require_refine_clear()
        self.ws.mutate(
            "before cut time range",
            "after cut time range",
            lambda p: cut_time_range(
                p,
                track_id,
                start,
                end,
                reason=reason,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            ),
        )

    def cut_text_match(
        self,
        query: str,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        match_all: bool = False,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> list[EditDecision]:
        self._require_refine_clear()

        def mutate(p) -> list[EditDecision]:
            return cut_text_match(
                p,
                query,
                track_id=track_id,
                speaker=speaker,
                match_all=match_all,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            )

        return self.ws.mutate("before cut text match", "after cut text match", mutate)

    def cut_utterance(
        self,
        utterance_index: int,
        *,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> None:
        self._require_refine_clear()
        self.ws.mutate(
            "before cut utterance",
            "after cut utterance",
            lambda p: cut_utterance(
                p,
                utterance_index,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            ),
        )

    def cut_words(
        self,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        *,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> None:
        self._require_refine_clear()
        self.ws.mutate(
            "before cut words",
            "after cut words",
            lambda p: cut_words(
                p,
                track_id,
                start_word_index,
                end_word_index,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            ),
        )

    def apply_plan(
        self,
        edits: list[dict[str, Any]],
        *,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> int:
        self._require_refine_clear()

        def mutate(p) -> int:
            created = apply_edit_plan(
                p,
                edits,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            )
            return len(created)

        return self.ws.mutate("before apply edit plan", "after apply edit plan", mutate)

    def list_decisions(
        self,
        *,
        applied: bool | None = None,
        review_required: bool | None = None,
        reason_prefix: str | None = None,
    ) -> list[EditDecision]:
        return list_edit_decisions(
            self.ws.project,
            applied=applied,
            review_required=review_required,
            reason_prefix=reason_prefix,
        )

    def approve(self, ids: list[str]) -> int:
        self._require_refine_clear()

        def mutate(p) -> int:
            return approve_edits(p, ids)

        return self.ws.mutate(
            "before approve edits",
            "after approve edits",
            mutate,
            operation="approve_edits",
            params={"ids": ids},
        )

    def reject(self, ids: list[str]) -> int:
        def mutate(p) -> int:
            return reject_edits(p, ids)

        return self.ws.mutate("before reject edits", "after reject edits", mutate)

    def update_pending(
        self,
        edit_id: str,
        *,
        start: float,
        end: float,
        snap: bool = True,
        track_ids: list[str] | None = None,
    ) -> EditDecision:
        def mutate(p) -> EditDecision:
            return update_pending_edit(
                p,
                edit_id,
                start=start,
                end=end,
                snap=snap,
                track_ids=track_ids,
            )

        return self.ws.mutate(
            "before update pending edit",
            "after update pending edit",
            mutate,
            operation="update_pending_edit",
            params={
                "id": edit_id,
                "start": start,
                "end": end,
                "snap": snap,
                "track_ids": track_ids,
            },
        )

    def revert_applied(self, record_id: str) -> dict:
        def mutate(p) -> dict:
            return revert_applied_edit(p, record_id)

        return self.ws.mutate(
            "before revert applied edit",
            "after revert applied edit",
            mutate,
            operation="revert_applied_edit",
            params={"id": record_id},
        )

    def impact_report(self, *, markdown: bool = False) -> str | dict:
        report = edit_impact_report(self.ws.project)
        if markdown:
            return format_edit_impact_markdown(report)
        return report

    def propose_tighten(
        self, edit_mode: str | None = None, intensity: str | None = None
    ) -> TightenProposal:
        self._require_refine_clear()

        def mutate(p) -> TightenProposal:
            return propose_tighten_edits(
                p, load_defaults(), edit_mode=edit_mode, intensity=intensity
            )

        return self.ws.mutate("before propose edits", "after propose edits", mutate)

    def apply_auto(self) -> int:
        self._require_refine_clear()

        def mutate(p) -> int:
            return apply_auto_edits(p)

        return self.ws.mutate(
            "before apply auto edits",
            "after apply auto edits",
            mutate,
            operation="apply_auto_edits",
        )

    def transcript_timestamps(self) -> str:
        return format_transcript_timestamps(self.ws.project)

    def strip_silence(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        threshold_db: float = -40.0,
        min_duration_sec: float = 0.5,
        use_inaudible_opt: bool | None = None,
    ) -> dict:
        """Strip silence islands; ``use_inaudible_opt`` is ignored (API compat)."""
        tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            return strip_silence(
                p,
                tid,
                threshold_db=threshold_db,
                min_duration_sec=min_duration_sec,
                use_inaudible_opt=use_inaudible_opt,
            )

        return self.ws.mutate(
            "before strip silence",
            "after strip silence",
            mutate,
            operation="strip_silence",
            params={
                "track_id": tid,
                "threshold_db": threshold_db,
                "min_duration_sec": min_duration_sec,
                "use_inaudible_opt": use_inaudible_opt,
            },
        )

    def ripple_delete(
        self,
        start: float,
        end: float,
        *,
        use_inaudible_opt: bool | None = None,
    ) -> dict:
        self._require_refine_clear()
        out = self.ws.mutate(
            "before ripple delete",
            "after ripple delete",
            lambda p: ripple_delete(
                p,
                start,
                end,
                use_inaudible_opt=use_inaudible_opt,
            ),
            operation="ripple_delete",
            params={
                "timeline_start": start,
                "timeline_end": end,
                "use_inaudible_opt": use_inaudible_opt,
            },
        )
        # Advisory only - does not block the edit
        try:
            from podcast_mcp.util.tracks import dialogue_track_ids

            dialogue_ids = dialogue_track_ids(self.ws.project)
            tid = dialogue_ids[0] if dialogue_ids else None
            if tid:
                out = dict(out)
                out["join_quality"] = assess_existing_join(
                    self.ws.project, tid, float(start), timebase="timeline"
                ).to_dict()
        except Exception as exc:
            log.debug("join quality advisory skipped: %s", exc)
        return out

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
            opt = optimize_timeline_cut_range(self.ws.project, tid, start, end)
        else:
            opt = optimize_source_cut_range(self.ws.project, tid, start, end)
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
                hops = timeline_rms_hops(self.ws.project, tid, lo, hi)
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
        quiet_db: float = -48.0,
        min_island_sec: float = 0.12,
        hop_ms: int = 20,
        retain_sec: float = 1.0,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return suggest_handoff_cut_bounds(
            self.ws.project,
            tid,
            keep_left_end,
            keep_right_start,
            quiet_db=quiet_db,
            min_island_sec=min_island_sec,
            hop_ms=hop_ms,
            retain_sec=retain_sec,
        )

    def join_quality(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        join_sec: float | None = None,
        cut_start: float | None = None,
        cut_end: float | None = None,
        timebase: str = "timeline",
        audio_caches: dict[str, TrackAudioCache] | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        tb = "timeline" if timebase == "timeline" else "source"
        if cut_start is not None and cut_end is not None:
            return assess_proposed_cut(
                self.ws.project,
                tid,
                float(cut_start),
                float(cut_end),
                timebase=tb,  # type: ignore[arg-type]
                audio_caches=audio_caches,
            ).to_dict()
        if join_sec is None:
            raise ValueError("provide join_sec, or cut_start and cut_end")
        return assess_existing_join(
            self.ws.project,
            tid,
            float(join_sec),
            timebase=tb,  # type: ignore[arg-type]
        ).to_dict()

    def join_qa_sweep(self, *, track_id: str | None = None) -> dict:
        return assess_project_joins(self.ws.project, track_id=track_id)

    def join_label(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        join_sec: float,
        verdict: str,
        timebase: str = "source",
        note: str = "",
        play: bool = False,
        cut_start: float | None = None,
        cut_end: float | None = None,
    ) -> dict:
        from podcast_mcp.services.play import PlayService

        tid = self._resolve(track_id, speaker)
        if verdict not in ("pass", "fail"):
            raise ValueError("verdict must be pass or fail")
        features = self.join_quality(
            track_id=tid,
            join_sec=join_sec,
            cut_start=cut_start,
            cut_end=cut_end,
            timebase=timebase,
        )
        det_map = {d["name"]: d.get("score", 0.0) for d in features.get("detectors") or []}
        label = record_label(
            self.ws.project,
            track_id=tid,
            join_sec=float(join_sec),
            verdict=verdict,  # type: ignore[arg-type]
            timebase=timebase,
            cut_start=cut_start,
            cut_end=cut_end,
            note=note,
            features={
                "risk": features.get("risk"),
                "detectors": det_map,
                "neural": features.get("neural"),
            },
            source="human",
        )
        played = False
        if play:
            from podcast_mcp.services.play import PlayRequest

            PlayService(self.ws).play(
                PlayRequest(
                    source=f"processed:{tid}",
                    start_sec=max(0.0, float(join_sec) - 2.0),
                    end_sec=float(join_sec) + 2.0,
                )
            )
            played = True
        return {"label": label.to_dict(), "played": played, "features": features}

    def join_train(
        self,
        *,
        labels_path: Path | None = None,
        out_path: Path | None = None,
    ) -> dict:
        from podcast_mcp.edits.join_labels import load_labels
        from podcast_mcp.edits.join_ranker import save_ranker, train_join_ranker

        labels = load_labels(
            self.ws.project,
            path=labels_path,
        )
        model = train_join_ranker(labels)
        dest = out_path or (self.ws.project.artifacts_dir() / "join_ranker.json")
        save_ranker(model, dest)
        return {"model": model.to_dict(), "path": str(dest), "n_labels": len(labels)}

    def ripple_delete_text(
        self,
        query: str,
        *,
        use_inaudible_opt: bool | None = None,
    ) -> dict:
        self._require_refine_clear()
        return self.ws.mutate(
            "before ripple delete text",
            "after ripple delete text",
            lambda p: ripple_delete_text(
                p,
                query,
                use_inaudible_opt=use_inaudible_opt,
            ),
            operation="ripple_delete_text",
            params={"query": query, "use_inaudible_opt": use_inaudible_opt},
        )

    def move_segment(self, source_start: float, source_end: float, insert_at: float) -> dict:
        return self.ws.mutate(
            "before move segment",
            "after move segment",
            lambda p: move_segment(p, source_start, source_end, insert_at),
            operation="move_segment",
            params={
                "source_start": source_start,
                "source_end": source_end,
                "insert_at": insert_at,
            },
        )

    def move_by_text(
        self,
        source_query: str,
        destination_query: str,
        position: str = "after",
    ) -> dict:
        return self.ws.mutate(
            "before move by text",
            "after move by text",
            lambda p: move_by_text(p, source_query, destination_query, position),
            operation="move_by_text",
            params={
                "source_query": source_query,
                "destination_query": destination_query,
                "position": position,
            },
        )

    def insert_gap(self, at_time: float, duration_sec: float = 1.0) -> dict:
        return self.ws.mutate(
            "before insert gap",
            "after insert gap",
            lambda p: insert_gap(p, at_time, duration_sec),
            operation="insert_gap",
            params={"at_time": at_time, "duration_sec": duration_sec},
        )

    def fade_joins(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        fade_ms: int | None = None,
        dry_run: bool = False,
    ) -> dict:
        if dry_run:
            return fade_joins(
                self.ws.project,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
                dry_run=True,
            )
        return self.ws.mutate(
            "before fade joins",
            "after fade joins",
            lambda p: fade_joins(
                p,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
            ),
            operation="fade_joins",
            params={
                "track_id": track_id,
                "speaker": speaker,
                "fade_ms": fade_ms,
            },
        )

    def crossfade_joins(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        fade_ms: int | None = None,
        dry_run: bool = False,
    ) -> dict:
        if dry_run:
            return crossfade_joins(
                self.ws.project,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
                dry_run=True,
            )
        return self.ws.mutate(
            "before crossfade joins",
            "after crossfade joins",
            lambda p: crossfade_joins(
                p,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
            ),
            operation="crossfade_joins",
            params={
                "track_id": track_id,
                "speaker": speaker,
                "fade_ms": fade_ms,
            },
        )

    def set_clip_fade(self, clip_id: str, fade_in_ms: int, fade_out_ms: int) -> dict:
        return self.ws.mutate(
            "before set clip fade",
            "after set clip fade",
            lambda p: set_clip_fade(p, clip_id, fade_in_ms, fade_out_ms),
            operation="set_clip_fade",
            params={
                "clip_id": clip_id,
                "fade_in_ms": fade_in_ms,
                "fade_out_ms": fade_out_ms,
            },
        )

    def move_clips(self, clips: list[dict]) -> dict:
        return self.ws.mutate(
            "before move clips",
            "after move clips",
            lambda p: move_clips(p, clips),
            operation="move_clips",
            params={
                "clip_ids": [
                    str(c.get("clip_id"))
                    for c in clips
                    if isinstance(c, dict) and c.get("clip_id") is not None
                ]
            },
        )

    def trim_clip_edge(
        self,
        clip_id: str,
        edge: str,
        source_sec: float,
        *,
        mode: str = "ripple",
    ) -> dict:
        return self.ws.mutate(
            "before trim clip edge",
            "after trim clip edge",
            lambda p: trim_clip_edge(p, clip_id, edge, source_sec, mode=mode),
            operation="trim_clip_edge",
            params={
                "clip_id": clip_id,
                "edge": edge,
                "source_sec": source_sec,
                "mode": mode,
            },
        )

    def roll_clip_join(
        self,
        left_clip_id: str,
        right_clip_id: str,
        delta_sec: float,
    ) -> dict:
        return self.ws.mutate(
            "before roll clip join",
            "after roll clip join",
            lambda p: roll_clip_join(p, left_clip_id, right_clip_id, delta_sec),
            operation="roll_clip_join",
            params={
                "left_clip_id": left_clip_id,
                "right_clip_id": right_clip_id,
                "delta_sec": delta_sec,
            },
        )

    def set_join_mode(self, clip_id: str, join_in_mode: str) -> dict:
        return self.ws.mutate(
            "before set join mode",
            "after set join mode",
            lambda p: set_clip_join_mode(p, clip_id, join_in_mode),
            operation="set_clip_join_mode",
            params={"clip_id": clip_id, "join_in_mode": join_in_mode},
        )

    def shorten_word_gaps(
        self,
        max_gap_sec: float = 0.35,
        *,
        use_inaudible_opt: bool | None = None,
    ) -> dict:
        return self.ws.mutate(
            "before shorten gaps",
            "after shorten gaps",
            lambda p: shorten_word_gaps(
                p,
                max_gap_sec,
                use_inaudible_opt=use_inaudible_opt,
            ),
            operation="shorten_word_gaps",
            params={
                "max_gap_sec": max_gap_sec,
                "use_inaudible_opt": use_inaudible_opt,
            },
        )

    def split_clip(
        self,
        at_time: float,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        track_ids: list[str] | None = None,
    ) -> dict:
        """Split at timeline *at_time* on one or more tracks."""
        if track_ids is not None:
            tids: list[str] | None = list(track_ids)
        elif track_id is not None or speaker is not None:
            tids = [self._resolve(track_id, speaker)]
        else:
            tids = None
        return self.ws.mutate(
            "before split clip",
            "after split clip",
            lambda p: split_clips_at(p, at_time, tids),
        )

    def split_at_time(
        self,
        at_time: float,
        track_ids: list[str] | None = None,
        *,
        propose: bool = False,
        reason: str | None = None,
    ) -> dict:
        """Blade cut: apply split or append pending ``type=split`` proposal."""
        from podcast_mcp.util.tracks import dialogue_track_ids

        def mutate(p) -> dict:
            tids = list(track_ids) if track_ids else dialogue_track_ids(p)
            if not tids:
                raise ValueError("no tracks to split")
            if propose:
                decision = append_split_decision(
                    p,
                    float(at_time),
                    tids,
                    reason=reason or "guest:suggest_split",
                )
                return {"operation": "propose_split", "edit": decision.model_dump()}
            return split_clips_at(p, float(at_time), tids)

        return self.ws.mutate(
            "before split at time",
            "after split at time",
            mutate,
        )

    def delete_clips(
        self,
        clip_ids: list[str],
        *,
        ripple: bool = False,
        propose: bool = False,
        reason: str | None = None,
    ) -> dict:
        """Delete clips (punch) or ripple-delete their spans; optional propose."""

        def mutate(p) -> dict:
            if not clip_ids:
                raise ValueError("clip_ids required")
            by_id = {c.id: c for c in p.clips}
            missing = [cid for cid in clip_ids if cid not in by_id]
            if missing:
                raise KeyError(f"unknown clip_id(s): {missing}")
            if propose:
                edits = []
                for cid in clip_ids:
                    clip = by_id[cid]
                    decision = append_remove_decision(
                        p,
                        clip.track_id,
                        float(clip.source_start),
                        float(clip.source_end),
                        reason=reason
                        or ("guest:suggest_ripple_delete" if ripple else "guest:suggest_delete"),
                        review_required=True,
                        applied=False,
                        scope="session" if ripple else "track",
                    )
                    edits.append(decision.model_dump())
                return {
                    "operation": "propose_delete_clips",
                    "ripple": ripple,
                    "edits": edits,
                }
            return delete_clips(p, list(clip_ids), ripple=ripple)

        label = "ripple delete clips" if ripple else "delete clips"
        return self.ws.mutate(f"before {label}", f"after {label}", mutate)

    def duplicate_segment(self, source_start: float, source_end: float, insert_at: float) -> dict:
        return self.ws.mutate(
            "before duplicate segment",
            "after duplicate segment",
            lambda p: duplicate_segment(p, source_start, source_end, insert_at),
        )

    def paste_segment(
        self,
        insert_at: float,
        duration: float,
        extracts: list[dict],
    ) -> dict:
        return self.ws.mutate(
            "before paste segment",
            "after paste segment",
            lambda p: paste_segment(p, insert_at, duration, extracts),
        )

    def list_clips(self, track_id: str | None = None) -> dict:
        return list_clips(self.ws.project, track_id)

    def list_applied_edits(
        self,
        *,
        track_id: str | None = None,
        timeline_start: float | None = None,
        timeline_end: float | None = None,
    ) -> dict:
        records = list_applied_edits(
            self.ws.project,
            track_id=track_id,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
        )
        return {
            "count": len(records),
            "records": [r.model_dump() for r in records],
        }

    def render_status(self) -> dict:
        return render_status_report(self.ws.project)

    def fill_room_tone(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return self.ws.mutate(
            "before fill room tone",
            "after fill room tone",
            lambda p: fill_with_room_tone(p, tid),
        )

    def correct_word(self, track_id: str, word_index: int, new_text: str) -> None:
        self.ws.mutate(
            "before correct word",
            "after correct word",
            lambda p: correct_word(p, track_id, word_index, new_text),
        )

    def correct_phrase(
        self,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        new_text: str,
    ) -> None:
        self.ws.mutate(
            "before correct phrase",
            "after correct phrase",
            lambda p: correct_phrase(p, track_id, start_word_index, end_word_index, new_text),
        )

    def set_word_suppressed(self, track_id: str, word_index: int, suppressed: bool) -> dict:
        return self.ws.mutate(
            "before set word suppressed",
            "after set word suppressed",
            lambda p: set_word_suppressed(p, track_id, word_index, suppressed),
        )

    def low_confidence_words(self, threshold: float = 0.7) -> list[dict]:
        return list_low_confidence(self.ws.project, threshold)

    def verify_transcript(
        self,
        track_id: str,
        corrections: list[dict[str, Any]],
    ) -> int:
        def mutate(p) -> int:
            return verify_words(p, track_id, corrections)

        return self.ws.mutate("before verify transcript", "after verify transcript", mutate)

    def apply_transcript_cleanup(
        self,
        track_id: str,
        *,
        words: list[dict[str, Any]] | None = None,
        phrases: list[dict[str, Any]] | None = None,
    ) -> int:
        """History-safe batch: word + phrase corrections in one undo step."""

        def mutate(p) -> int:
            return apply_transcript_corrections(p, track_id, words=words, phrases=phrases)

        return self.ws.mutate(
            "before transcript cleanup",
            "after transcript cleanup",
            mutate,
        )

    def add_chapter(self, at_time: float, title: str) -> dict:
        def mutate(p) -> dict:
            ch = add_chapter(p, at_time, title)
            return ch.model_dump()

        return self.ws.mutate("before add chapter", "after add chapter", mutate)

    def remove_chapter(self, title: str) -> dict:
        def mutate(p) -> dict:
            ok = remove_chapter(p, title)
            return {"removed": ok, "title": title}

        return self.ws.mutate("before remove chapter", "after remove chapter", mutate)

    def update_chapter(
        self,
        old_time: float,
        old_title: str,
        *,
        time: float,
        title: str,
    ) -> dict:
        def mutate(p) -> dict:
            ch = update_chapter(p, old_time, old_title, time=time, title=title)
            return ch.model_dump()

        return self.ws.mutate("before update chapter", "after update chapter", mutate)

    def delete_chapter(self, time: float, title: str) -> dict:
        def mutate(p) -> dict:
            ok = delete_chapter(p, time, title)
            return {"deleted": ok, "time": time, "title": title}

        return self.ws.mutate("before delete chapter", "after delete chapter", mutate)

    def suggest_pending_edit(
        self,
        track_id: str,
        start: float,
        end: float,
        *,
        reason: str | None = None,
        edit_type: str | None = None,
    ) -> dict:
        """Guest/host suggest: pending remove or mute decision (review_required)."""
        from podcast_mcp.models import EditDecisionType

        raw = str(edit_type or "remove").strip().lower()
        if raw not in ("remove", "mute"):
            raise ValueError("edit_type must be remove or mute")
        decision_type = EditDecisionType.MUTE if raw == "mute" else EditDecisionType.REMOVE

        def mutate(p) -> dict:
            decision = append_remove_decision(
                p,
                track_id,
                float(start),
                float(end),
                reason=reason or "guest:suggest",
                review_required=True,
                applied=False,
                decision_type=decision_type,
            )
            return decision.model_dump()

        return self.ws.mutate(
            "before suggest pending edit",
            "after suggest pending edit",
            mutate,
        )

    def list_chapters(self) -> list[dict]:
        return [c.model_dump() for c in list_chapters(self.ws.project)]

    def check_loudness(self, audio_path: str | None = None) -> dict:
        path = Path(audio_path) if audio_path else None
        if path is None:
            from podcast_mcp.export.names import sanitize_export_stem

            mastered = (
                self.ws.project.export_dir() / f"{sanitize_export_stem(self.ws.project.name)}.wav"
            )
            premix = self.ws.project.artifacts_dir() / "premix.wav"
            path = mastered if mastered.is_file() else premix
        if not path.is_file():
            raise FileNotFoundError(f"no audio to measure: {path}")
        return check_loudness(path)

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

        def mutate(p) -> dict:
            if preset:
                chain = apply_preset_to_chain(p, tid, preset)
            elif effect:
                chain = add_effect(p, tid, effect, params)
            else:
                raise ValueError("preset or effect is required")
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
            return {"track_id": tid, "effects": list_track_effects(self.ws.project, tid)}
        return {"presets": list_presets()}

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
        return cleanup_analysis_report(self.ws.project, track_id=tid, progress=progress)

    def audio_diagnostics(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return audio_diagnostics_report(self.ws.project, tid, start_sec=start_sec, end_sec=end_sec)

    def recommend_fades(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return fade_recommendations(self.ws.project, track_id=tid)

    def apply_fade_recommendations(self, recommendations: list[dict]) -> dict:
        return self.ws.mutate(
            "before apply fade recommendations",
            "after apply fade recommendations",
            lambda p: apply_fade_recommendations(p, recommendations),
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
        return audit_low_audibility_words(self.ws.project, track_id=tid, progress=progress)

    def suppress_low_audibility(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        words_json: list[dict] | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            return suppress_low_audibility_words(p, track_id=tid, word_keys=words_json)

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
        )

    def suppress_bleed(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        words_json: list[dict] | None = None,
        exclude_words_json: list[dict] | None = None,
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
                word_keys=words_json,
                exclude_word_keys=exclude_words_json,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=True,
                progress=progress,
            )

        def mutate(p) -> dict:
            return suppress_bleed_words(
                p,
                track_id=tid,
                word_keys=words_json,
                exclude_word_keys=exclude_words_json,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=False,
                progress=progress,
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
        )

    def apply_bleed_mute(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        apply: bool = True,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)

        if not apply:
            return apply_transcript_bleed_mute(
                self.ws.project,
                track_id=tid,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=True,
                progress=progress,
            )

        def mutate(p) -> dict:
            return apply_transcript_bleed_mute(
                p,
                track_id=tid,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=False,
                progress=progress,
            )

        return self.ws.mutate(
            "before apply bleed mute",
            "after apply bleed mute",
            mutate,
        )

    def gate_overreach(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return gate_overreach_report(self.ws.project, tid, progress=progress)

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
        return build_audibility_map(self.ws.project, track_id=tid, progress=progress)

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
        return list_flagged_transcript_words(self.ws.project, track_id=tid, progress=progress)

    def reconciliation_status(self) -> dict:
        return reconciliation_status_report(self.ws.project)

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
            )

        return self.ws.mutate(
            "before reconcile transcript",
            "after reconcile transcript",
            mutate,
        )
