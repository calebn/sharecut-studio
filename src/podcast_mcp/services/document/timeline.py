"""Clip geometry, joins, fades, segments, chapters and room tone."""

from __future__ import annotations

import logging
import math
from dataclasses import asdict
from pathlib import Path
from typing import Literal, TypeVar

from podcast_mcp.edits import (
    cut_safety,
)
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.bleed_restore_targets import BleedRestoreTarget
from podcast_mcp.edits.chapters import (
    add_chapter,
    delete_chapter,
    list_chapters,
    remove_chapter,
    update_chapter,
)
from podcast_mcp.edits.clip_fades import ClipFadeBaseline, require_clip_fade_baseline
from podcast_mcp.edits.cut_speech import (
    assess_cut_speech,
)
from podcast_mcp.edits.edit_reasons import (
    GUEST_SUGGEST_DELETE_REASON,
    GUEST_SUGGEST_RIPPLE_DELETE_REASON,
    GUEST_SUGGEST_SPLIT_REASON,
)
from podcast_mcp.edits.join_continuity import (
    assess_existing_join,
    assess_project_joins,
)
from podcast_mcp.edits.join_labels import record_label
from podcast_mcp.edits.join_modes import (
    crossfade_joins,
    fade_joins,
    set_clip_join,
    set_clip_join_mode,
)
from podcast_mcp.edits.ripple import TrimEdge, plan_trim
from podcast_mcp.edits.timeline_ops import (
    DEFAULT_SHORTEN_GAP_SEC,
    copy_segment,
    duplicate_segment,
    fill_with_room_tone,
    insert_gap,
    list_clips,
    move_by_text,
    move_clips,
    move_segment,
    paste_segment,
    plan_delete_clips,
    plan_shorten_word_gaps,
    roll_clip_join,
    set_clip_fade,
    split_clips_at,
)
from podcast_mcp.edits.transcript_cuts import (
    append_remove_decision,
    append_split_decision,
)
from podcast_mcp.models import CutIntent, EditMode, EpisodeProject
from podcast_mcp.services.collaboration import get_share_registry
from podcast_mcp.services.document.bleed_inspection import (
    BleedRestoreResult,
    ClipBleedInspection,
    inspect_clip_bleed,
    restore_clip_bleed,
)
from podcast_mcp.services.document.service_base import CutMutatingService
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.tracks import dialogue_track_ids

from .boundary import (
    RollBoundaryTarget,
    TrimBoundaryTarget,
    assert_boundary_token,
)

log = logging.getLogger(__name__)
T = TypeVar("T")


class TimelineService(CutMutatingService):
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
        tb: Literal["timeline", "source"] = "timeline" if timebase == "timeline" else "source"
        if cut_start is not None and cut_end is not None:
            return cut_safety.assess_proposed_cut(
                self.ws.project,
                tid,
                float(cut_start),
                float(cut_end),
                timebase=tb,
                audio_caches=audio_caches,
                defaults=self.ws.effective_config(),
            ).to_dict()
        if join_sec is None:
            raise CodedValueError(
                "provide join_sec, or cut_start and cut_end", code="join_target_required"
            )
        return assess_existing_join(
            self.ws.project,
            tid,
            float(join_sec),
            timebase=tb,
            defaults=self.ws.effective_config(),
        ).to_dict()

    def join_qa_sweep(self, *, track_id: str | None = None) -> dict:
        return assess_project_joins(
            self.ws.project, track_id=track_id, defaults=self.ws.effective_config()
        )

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
        from .play import PlayService

        tid = self._resolve(track_id, speaker)
        if verdict not in ("pass", "fail"):
            raise CodedValueError("verdict must be pass or fail", code="join_verdict_invalid")
        label_verdict: Literal["pass", "fail"] = "pass" if verdict == "pass" else "fail"
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
            verdict=label_verdict,
            timebase=timebase,
            cut_start=cut_start,
            cut_end=cut_end,
            note=note,
            features={
                "risk": features.get("risk"),
                "detectors": det_map,
            },
            source="human",
        )
        played = False
        if play:
            from .play import PlayRequest

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

    def move_segment(self, source_start: float, source_end: float, insert_at: float) -> dict:
        return self.ws.mutate(
            "before move segment",
            "after move segment",
            lambda p: move_segment(
                p, source_start, source_end, insert_at, defaults=self.ws.effective_config()
            ),
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
            lambda p: move_by_text(
                p, source_query, destination_query, position, defaults=self.ws.effective_config()
            ),
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
            lambda p: insert_gap(
                p,
                at_time,
                duration_sec,
                defaults=self.ws.effective_config(),
                shift_anchors=True,
            ),
            operation="insert_gap",
            params={"at_time": at_time, "duration_sec": duration_sec},
        )

    def preview_fade_joins(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        fade_ms: int | None = None,
    ) -> dict:
        return fade_joins(
            self.ws.project,
            track_id=track_id,
            speaker=speaker,
            fade_ms=fade_ms,
            dry_run=True,
            defaults=self.ws.effective_config(),
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
            return self.preview_fade_joins(track_id=track_id, speaker=speaker, fade_ms=fade_ms)
        return self.ws.mutate(
            "before fade joins",
            "after fade joins",
            lambda p: fade_joins(
                p,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
                defaults=self.ws.effective_config(),
            ),
            operation="fade_joins",
            params={
                "track_id": track_id,
                "speaker": speaker,
                "fade_ms": fade_ms,
            },
        )

    def preview_crossfade_joins(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        fade_ms: int | None = None,
    ) -> dict:
        return crossfade_joins(
            self.ws.project,
            track_id=track_id,
            speaker=speaker,
            fade_ms=fade_ms,
            dry_run=True,
            defaults=self.ws.effective_config(),
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
            return self.preview_crossfade_joins(track_id=track_id, speaker=speaker, fade_ms=fade_ms)
        return self.ws.mutate(
            "before crossfade joins",
            "after crossfade joins",
            lambda p: crossfade_joins(
                p,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
                defaults=self.ws.effective_config(),
            ),
            operation="crossfade_joins",
            params={
                "track_id": track_id,
                "speaker": speaker,
                "fade_ms": fade_ms,
            },
        )

    def inspect_clip_bleed(self, clip_id: str, *, track_id: str) -> ClipBleedInspection:
        return inspect_clip_bleed(self.ws, clip_id, track_id=track_id)

    def restore_clip_bleed(self, target: BleedRestoreTarget) -> BleedRestoreResult:
        return restore_clip_bleed(self.ws, target)

    def set_clip_fade(
        self,
        clip_id: str,
        fade_in_ms: int,
        fade_out_ms: int,
        *,
        expected: ClipFadeBaseline | None = None,
    ) -> dict:
        with self.ws.transaction() as project:
            if expected is not None:
                require_clip_fade_baseline(project, clip_id, expected)
            return self.ws.mutate(
                "before set clip fade",
                "after set clip fade",
                lambda p: set_clip_fade(
                    p, clip_id, fade_in_ms, fade_out_ms, defaults=self.ws.effective_config()
                ),
                operation="set_clip_fade",
                params={
                    "clip_id": clip_id,
                    "fade_in_ms": fade_in_ms,
                    "fade_out_ms": fade_out_ms,
                    **({"expected": asdict(expected)} if expected is not None else {}),
                },
            )

    def move_clips(self, clips: list[dict]) -> dict:
        return self.ws.mutate(
            "before move clips",
            "after move clips",
            lambda p: move_clips(p, clips, defaults=self.ws.effective_config()),
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
        edge: TrimEdge,
        source_sec: float,
        *,
        mode: EditMode,
        expected_token: str,
        application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    ) -> dict:
        """Move one clip edge; a ripple keeps every track in sync and guards their speech."""
        if not math.isfinite(source_sec):
            raise CodedValueError("source_sec must be finite", code="source_sec_not_finite")
        target = TrimBoundaryTarget.model_validate({"clip_id": clip_id, "edge": edge, "mode": mode})
        with self.ws.transaction() as project:
            assert_boundary_token(
                project, target, expected_token, defaults=self.ws.effective_config()
            )
            plan = plan_trim(project, clip_id, edge, source_sec, mode)
            if plan.unchanged:
                return {"operation": "trim_clip_edge", "unchanged": True}
            from podcast_mcp.edits.cut_application import apply_trim

            return self._mutate_timeline_cut(
                "trim clip edge",
                "trim_clip_edge",
                lambda p: apply_trim(
                    p,
                    plan,
                    application_intent=application_intent,
                    defaults=self.ws.effective_config(),
                ),
                {"clip_id": clip_id, "edge": edge, "source_sec": source_sec, "mode": mode.value},
            )

    def roll_clip_join(
        self,
        left_clip_id: str,
        right_clip_id: str,
        delta_sec: float,
        *,
        expected_token: str,
    ) -> dict:
        if not math.isfinite(delta_sec):
            raise CodedValueError("delta_sec must be finite", code="delta_sec_not_finite")
        target = RollBoundaryTarget(left_clip_id=left_clip_id, right_clip_id=right_clip_id)

        def apply(p: EpisodeProject) -> dict:
            assert_boundary_token(p, target, expected_token, defaults=self.ws.effective_config())
            return roll_clip_join(
                p, left_clip_id, right_clip_id, delta_sec, defaults=self.ws.effective_config()
            )

        with self.ws.transaction() as project:
            current = assert_boundary_token(
                project, target, expected_token, defaults=self.ws.effective_config()
            )
            bounded = min(max(delta_sec, current.limits.min), current.limits.max)
            if abs(bounded) < 1e-12:
                return {"operation": "roll_clip_join", "unchanged": True}
            return self.ws.mutate(
                "before roll clip join",
                "after roll clip join",
                apply,
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

    def set_clip_join(
        self,
        left_clip_id: str,
        right_clip_id: str,
        mode: str,
        length_ms: int | None = None,
    ) -> dict:
        """Set one join's mode and fades in a single undoable step."""
        return self.ws.mutate(
            "before set clip join",
            "after set clip join",
            lambda p: set_clip_join(
                p,
                left_clip_id,
                right_clip_id,
                mode,
                length_ms=length_ms,
                defaults=self.ws.effective_config(),
            ),
            operation="set_clip_join",
            params={
                "left_clip_id": left_clip_id,
                "right_clip_id": right_clip_id,
                "mode": mode,
                "length_ms": length_ms,
            },
        )

    def shorten_word_gaps(
        self,
        max_gap_sec: float = DEFAULT_SHORTEN_GAP_SEC,
        *,
        use_inaudible_opt: bool | None = None,
    ) -> dict:
        """Ripple out long pauses; another speaker talking in a pause asks to confirm first."""
        with self.ws.transaction() as project:
            removal = plan_shorten_word_gaps(
                project,
                max_gap_sec,
                use_inaudible_opt=use_inaudible_opt,
                defaults=self.ws.effective_config(),
            )
            if removal is None:
                return change_summary(
                    project, operation="shorten_word_gaps", affected_tracks=[], unchanged=True
                )

            return self._apply_cut(
                "shorten gaps",
                removal,
                operation="shorten_word_gaps",
                params={"max_gap_sec": max_gap_sec, "use_inaudible_opt": use_inaudible_opt},
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
            lambda p: split_clips_at(p, at_time, tids, defaults=self.ws.effective_config()),
        )

    def split_at_time(
        self,
        at_time: float,
        track_ids: list[str] | None = None,
        *,
        propose: bool = False,
        reason: str | None = None,
        author: str | None = None,
        extra_at_times: list[float] | None = None,
    ) -> dict:
        """Blade cut: apply split or append pending ``type=split`` proposal.

        ``extra_at_times`` splits at more times in the same history step (both edges
        of a selected range). With several times, one with no clip to split is
        skipped as long as another splits.
        """
        times = [float(at_time), *(float(t) for t in extra_at_times or [])]

        def mutate(p) -> dict:
            tids = list(track_ids) if track_ids else dialogue_track_ids(p)
            if not tids:
                raise CodedValueError("no tracks to split", code="no_tracks_to_split")
            if propose:
                edits = [
                    append_split_decision(
                        p,
                        t,
                        tids,
                        reason=reason or GUEST_SUGGEST_SPLIT_REASON,
                        author=author,
                    ).model_dump()
                    for t in times
                ]
                return {"operation": "propose_split", "edit": edits[0], "edits": edits}
            summary: dict | None = None
            failure: CodedValueError | None = None
            split_times: list[float] = []
            for t in times:
                try:
                    summary = split_clips_at(p, t, tids, defaults=self.ws.effective_config())
                except CodedValueError as exc:
                    if len(times) == 1 or exc.code != "no_clip_at_time":
                        raise
                    failure = exc
                    continue
                split_times.append(t)
            if summary is None:
                assert failure is not None
                raise failure
            if len(times) > 1:
                summary["split_times"] = split_times
            return summary

        return self.ws.mutate(
            "before split at time",
            "after split at time",
            mutate,
        )

    def delete_clips(
        self,
        clip_ids: list[str],
        *,
        mode: EditMode,
        propose: bool = False,
        reason: str | None = None,
        author: str | None = None,
        application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    ) -> dict:
        """Delete clips: ripple closes their spans on every track; gap leaves silence.

        A proposal appends one pending remove per clip. A suggested ripple that would
        cut other speakers' speech records it, so approving it asks to confirm.
        """
        ripple = mode is EditMode.RIPPLE
        if propose:

            def suggest(p: EpisodeProject) -> dict:
                plan_delete_clips(p, clip_ids)
                by_id = {c.id: c for c in p.clips}
                edits = []
                for cid in clip_ids:
                    clip = by_id[cid]
                    decision = append_remove_decision(
                        p,
                        clip.track_id,
                        float(clip.source_start),
                        float(clip.source_end),
                        reason=reason
                        or (
                            GUEST_SUGGEST_RIPPLE_DELETE_REASON
                            if ripple
                            else GUEST_SUGGEST_DELETE_REASON
                        ),
                        review_required=True,
                        scope="session" if ripple else "track",
                        author=author,
                        defaults=self.ws.effective_config(),
                    )
                    if ripple:
                        decision.cut_speech = assess_cut_speech(
                            p, plan_delete_clips(p, [cid]), defaults=self.ws.effective_config()
                        )
                    edits.append(decision.model_dump(mode="json"))
                return {"operation": "propose_delete_clips", "mode": mode.value, "edits": edits}

            label = "ripple delete clips" if ripple else "delete clips"
            return self.ws.mutate(f"before {label}", f"after {label}", suggest)
        if not ripple:
            with self.ws.transaction() as project:
                return self._apply_cut(
                    "delete clips",
                    plan_delete_clips(project, clip_ids),
                    clip_ids=tuple(clip_ids),
                    operation="delete_clips",
                    application_intent=application_intent,
                    ripple=False,
                    params={"clip_ids": list(clip_ids), "mode": mode.value},
                )
        with self.ws.transaction() as project:
            return self._apply_cut(
                "ripple delete clips",
                plan_delete_clips(project, clip_ids),
                clip_ids=tuple(clip_ids),
                operation="ripple_delete_clips",
                application_intent=application_intent,
                params={"clip_ids": list(clip_ids), "mode": mode.value},
            )

    def duplicate_segment(self, source_start: float, source_end: float, insert_at: float) -> dict:
        return self.ws.mutate(
            "before duplicate segment",
            "after duplicate segment",
            lambda p: duplicate_segment(
                p, source_start, source_end, insert_at, defaults=self.ws.effective_config()
            ),
        )

    def copy_segment(self, start: float, end: float, track_ids: list[str] | None = None) -> dict:
        """Studio's clipboard for ``[start, end)``; read-only. ``PasteSegment`` takes it back."""
        return copy_segment(self.ws.project, start, end, track_ids)

    def paste_segment(
        self,
        insert_at: float,
        duration: float,
        extracts: list[dict],
        *,
        mode: EditMode,
    ) -> dict:
        """Paste clips: ripple opens time on every track; gap pastes over in place."""
        return self.ws.mutate(
            "before paste segment",
            "after paste segment",
            lambda p: paste_segment(
                p, insert_at, duration, extracts, mode=mode, defaults=self.ws.effective_config()
            ),
            operation="paste_segment",
            params={"insert_at": insert_at, "duration": duration, "mode": mode.value},
        )

    def list_clips(self, track_id: str | None = None) -> dict:
        secret = get_share_registry().recording_key_secret()
        return list_clips(self.ws.project, track_id, secret=secret)

    def fill_room_tone(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        within: tuple[float, float] | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        if within is None:
            with self.ws.transaction() as project:
                if sum(clip.track_id == tid for clip in project.clips) < 2:
                    return change_summary(
                        project,
                        operation="fill_with_room_tone",
                        affected_tracks=[tid],
                        pad_samples=[],
                        unchanged=True,
                    )
        return self.ws.mutate(
            "before fill room tone",
            "after fill room tone",
            lambda p: fill_with_room_tone(
                p, tid, within=within, defaults=self.ws.effective_config()
            ),
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

    def list_chapters(self) -> list[dict]:
        return [c.model_dump() for c in list_chapters(self.ws.project)]
